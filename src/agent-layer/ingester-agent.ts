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
import { parseJsonBlock } from './parse-json-block';
import { outputDirective } from './language';
export { parseJsonBlock } from './parse-json-block';

interface JudgeOut {
  verdict: ProposalOp | 'reject';
  targetSlug?: string; title?: string; category?: string;
  confidence: number; reason: string; conflictSlugs?: string[];
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
      'Extract from the conversation below only the facts worth recording in the wiki.',
      'For each fact, attach an importance (1-5) and a source quote (sourceQuote) from the conversation.',
      'Output only a JSON array: [{"claim": string, "importance": number, "sourceQuote": string}]',
      outputDirective('source'),
      '', `# Conversation\n${convText}`,
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
      'Verify the candidate fact below (you are the verifier, not the writer).',
      'Judge by comparing with the existing wiki:',
      '- create: new topic → new page',
      '- append: strengthen an existing page (targetSlug = existing slug)',
      '- supersede: contradicts existing → replace it (targetSlug = existing slug, list conflictSlugs; no overwriting)',
      '- reject: insufficient evidence, hallucination, or no value',
      'Output only a JSON object: {"verdict","targetSlug","title","category","confidence","reason","conflictSlugs"}',
      '', `# Candidate fact\n${fact.claim}\nsource: ${fact.sourceQuote}`,
      '', `# Related existing wiki\n${ctx || '(none)'}`,
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
