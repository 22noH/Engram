import { Inject, Injectable } from '@nestjs/common';
import { ConversationStore } from '../knowledge-core/conversation-store';
import { ImportanceGate, ScoredFact } from '../knowledge-core/importance-gate';
import { RagStore } from '../knowledge-core/rag/rag-store';
import { ProposalStore } from '../knowledge-core/proposal-store';
import { BRAIN, JUDGE_BRAIN, BrainProvider } from '../brain/brain.port';
import { PinoLogger } from '../pal/logger';
import { DEFAULT_USER } from '../pal/path-resolver';

// 코드펜스/잡텍스트에서 첫 JSON(객체 또는 배열)을 뽑아 파싱. 실패 시 null.
export function parseJsonBlock<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  const open = candidate[start]; const close = open === '[' ? ']' : '}';
  const end = candidate.lastIndexOf(close);
  if (end <= start) return null;
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
  ) {}

  async extractFacts(convText: string): Promise<ScoredFact[]> {
    const prompt = [
      '아래 대화에서 위키에 기록할 가치가 있는 사실만 추출하라.',
      '각 사실에 중요도(importance) 1~5점과 대화에서의 근거 인용(sourceQuote)을 달아라.',
      '출력은 JSON 배열만: [{"claim": string, "importance": number, "sourceQuote": string}]',
      '', `# 대화\n${convText}`,
    ].join('\n');
    const res = await this.writer.complete(prompt);
    if (res.isError) { this.logger.error('writer 추출 실패', String(res.raw), 'IngesterAgent'); return []; }
    const parsed = parseJsonBlock<ScoredFact[]>(res.text);
    if (!Array.isArray(parsed)) { this.logger.error('writer JSON 파싱 실패', res.text.slice(0, 200), 'IngesterAgent'); return []; }
    return parsed.filter((f) => f && typeof f.claim === 'string' && f.sourceQuote); // 출처없으면 거부(§6)
  }

  // Task 7에서 완성. 지금은 스텁.
  async run(userId: string = DEFAULT_USER): Promise<{ extracted: number; gated: number; proposed: number }> {
    void userId;
    return { extracted: 0, gated: 0, proposed: 0 };
  }
}
