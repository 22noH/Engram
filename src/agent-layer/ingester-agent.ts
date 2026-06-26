import { Inject, Injectable } from '@nestjs/common';
import { ConversationStore } from '../knowledge-core/conversation-store';
import { ImportanceGate, ScoredFact } from '../knowledge-core/importance-gate';
import { RagStore } from '../knowledge-core/rag/rag-store';
import { ProposalStore, ProposalOp } from '../knowledge-core/proposal-store';
import { SearchResult } from '../knowledge-core/rag/rag.types';
import { DigestLock } from '../knowledge-core/digest-lock';
import { BRAIN, JUDGE_BRAIN, BrainProvider } from '../brain/brain.port';
import { PinoLogger } from '../pal/logger';
import { DEFAULT_USER } from '../pal/path-resolver';

interface JudgeOut {
  verdict: ProposalOp | 'reject';
  targetSlug?: string; title?: string; category?: string;
  confidence: number; reason: string; conflictSlugs?: string[];
}

// 코드펜스/잡텍스트에서 첫 균형 잡힌 JSON(객체 또는 배열)을 뽑아 파싱. 실패 시 null.
// 깊이 카운팅 + 문자열 인식 스캐너로 꼬리 산문의 브래킷·문자열 내부 브래킷을 무시한다.
export function parseJsonBlock<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  const open = candidate[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)) as T; } catch { return null; }
}

// C 자율수집(설계 §7.4). 대화 배치 → writer 추출 → (Task 7: 게이트·judge·제안). stateless.
@Injectable()
export class IngesterAgent {
  constructor(
    private readonly conversations: ConversationStore,
    private readonly gate: ImportanceGate,
    @Inject(BRAIN) private readonly writer: BrainProvider,
    @Inject(JUDGE_BRAIN) private readonly judge: BrainProvider,
    private readonly rag: RagStore,
    private readonly proposals: ProposalStore,
    private readonly logger: PinoLogger,
    private readonly lock: DigestLock,
  ) {}

  async extractFacts(convText: string): Promise<ScoredFact[]> {
    const prompt = [
      '아래 대화에서 위키에 기록할 가치가 있는 사실만 추출하라.',
      '각 사실에 중요도(importance) 1~5점과 대화에서의 근거 인용(sourceQuote)을 달아라.',
      '출력은 JSON 배열만: [{"claim": string, "importance": number, "sourceQuote": string}]',
      '', `# 대화\n${convText}`,
    ].join('\n');
    const res = await this.writer.complete(prompt);
    if (res.isError) { this.logger.error('writer 추출 실패', String(res.raw ?? 'writer error'), 'IngesterAgent'); return []; }
    const parsed = parseJsonBlock<ScoredFact[]>(res.text);
    if (!Array.isArray(parsed)) { this.logger.error('writer JSON 파싱 실패', res.text.slice(0, 200), 'IngesterAgent'); return []; }
    return parsed.filter((f) => f && typeof f.claim === 'string' && f.sourceQuote); // 출처없으면 거부(§6)
  }

  async run(userId: string = DEFAULT_USER): Promise<{ extracted: number; gated: number; proposed: number }> {
    // 크로스프로세스 단일 라이터 보장: 수동 digest와 @Cron tick이 겹치면 건너뛴다(§11 쓰기 경합).
    if (!(await this.lock.acquire(userId))) {
      this.logger.log('다른 다이제스트가 진행 중 — 건너뜀', 'IngesterAgent');
      return { extracted: 0, gated: 0, proposed: 0 };
    }
    try {
      const cursor = await this.conversations.readCursor(userId);
      const recs = await this.conversations.since(userId, cursor);
      if (recs.length === 0) return { extracted: 0, gated: 0, proposed: 0 };

      const convText = recs.map((r) => `Q: ${r.question}\nA: ${r.answer}`).join('\n\n');
      const facts = await this.extractFacts(convText);
      const gated = this.gate.filter(facts);

      let proposed = 0;
      for (const fact of gated) {
        try {
          const hits = await this.rag.search(fact.claim, 5, userId);
          const v = await this.judgeFact(fact, hits);
          if (!v || v.verdict === 'reject') continue;
          await this.proposals.enqueue({
            userId,
            op: v.verdict,
            targetSlug: v.targetSlug ?? slugify(fact.claim),
            title: v.title ?? fact.claim.slice(0, 60),
            category: v.category ?? 'general',
            payload: fact.claim,
            sources: [fact.sourceQuote],
            importance: fact.importance,
            verdict: { confidence: v.confidence, reason: v.reason, conflictSlugs: v.conflictSlugs },
          });
          proposed++;
        } catch (err) {
          // 한 사실의 실패가 배치 전체를 중단시키지 않게(§10.3). 커서는 정상 전진 → 재실행 중복 제안 방지.
          this.logger.error('제안 생성 실패(이 사실 건너뜀)', String(err), 'IngesterAgent');
        }
      }
      // 워터마크 전진 — 마지막 레코드 ts(다음 run은 여기 이후만 읽음)
      await this.conversations.writeCursor(userId, recs[recs.length - 1].ts);
      return { extracted: facts.length, gated: gated.length, proposed };
    } catch (err) {
      this.logger.error('IngesterAgent.run 실패', String(err), 'IngesterAgent');
      return { extracted: 0, gated: 0, proposed: 0 };
    } finally {
      await this.lock.release(userId);
    }
  }

  // 별도 judge 콜(작성자≠검증자). 후보 사실 + 검색된 기존 페이지 → verdict.
  private async judgeFact(fact: ScoredFact, hits: SearchResult[]): Promise<JudgeOut | null> {
    const ctx = hits.map((h, i) => `[${i + 1}] ${h.title} (slug: ${h.slug})\n${h.text}`).join('\n\n');
    const prompt = [
      '아래 후보 사실을 검증하라(너는 작성자가 아닌 검증자다).',
      '기존 위키와 비교해 판정하라:',
      '- create: 신규 주제 → 새 페이지',
      '- append: 기존 페이지에 보강(targetSlug=기존 slug)',
      '- supersede: 기존과 모순 → 기존을 대체(targetSlug=기존 slug, conflictSlugs 명시, 덮어쓰기 금지)',
      '- reject: 근거 부족·환각·무가치',
      '출력은 JSON 객체만: {"verdict","targetSlug","title","category","confidence","reason","conflictSlugs"}',
      '', `# 후보 사실\n${fact.claim}\n근거: ${fact.sourceQuote}`,
      '', `# 관련 기존 위키\n${ctx || '(없음)'}`,
    ].join('\n');
    const res = await this.judge.complete(prompt);
    if (res.isError) { this.logger.error('judge 호출 실패', String(res.raw ?? 'judge error'), 'IngesterAgent'); return null; }
    const out = parseJsonBlock<JudgeOut>(res.text);
    const valid = out && ['create', 'append', 'supersede', 'reject'].includes(out.verdict);
    if (!valid) { this.logger.error('judge verdict 무효/파싱 실패', res.text.slice(0, 200), 'IngesterAgent'); return null; }
    return out;
  }
}

// 사실 텍스트 → 파일명 안전한 slug(영문·숫자·한글 유지, 나머지는 하이픈).
function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
}
