import { Inject, Injectable } from '@nestjs/common';
import { RagStore } from '../knowledge-core/rag/rag-store';
import { SearchResult } from '../knowledge-core/rag/rag.types';
import { BRAIN, BrainProvider } from '../brain/brain.port';
import { PinoLogger } from '../pal/logger';
import { CoreMessage } from '../edge/core-message';

const NO_HITS_HEADER = '⚠ 위키에 관련 내용 없음 — 일반 지식 기반 답변\n\n';

// A 읽기(설계 §7.2). 질문 → RAG 검색 → 컨텍스트 종합 → 답 + 출처. 매 턴 독립(stateless).
@Injectable()
export class ReaderAgent {
  constructor(
    private readonly rag: RagStore,
    @Inject(BRAIN) private readonly brain: BrainProvider,
    private readonly logger: PinoLogger,
  ) {}

  async handle(msg: CoreMessage, onChunk?: (t: string) => void): Promise<string> {
    const emit = (s: string): void => onChunk?.(s);
    try {
      const hits = await this.rag.search(msg.text, 5, msg.userId);
      const header = hits.length === 0 ? NO_HITS_HEADER : '';
      if (header) emit(header);

      const result = await this.brain.complete(this.buildPrompt(msg.text, hits), onChunk);
      if (result.isError) {
        const m = '답변 생성 실패: 두뇌 호출 오류';
        emit(m);
        return header + m;
      }

      const sources = hits.length
        ? `\n\n───\n출처: ${hits.map((h, i) => `[${i + 1}] ${h.title} (${h.slug})`).join(' · ')}`
        : '';
      if (sources) emit(sources);
      return header + result.text + sources;
    } catch (err) {
      this.logger.error('ReaderAgent.handle 실패', String(err), 'ReaderAgent');
      const m = `답변 생성 실패: ${String(err)}`;
      emit(m);
      return m;
    }
  }

  // 검색된 위키를 번호 매긴 컨텍스트로 조립 + 근거 우선·출처 표기 지시.
  private buildPrompt(question: string, hits: SearchResult[]): string {
    const ctx = hits.map((h, i) => `[${i + 1}] ${h.title} (slug: ${h.slug})\n${h.text}`).join('\n\n');
    return [
      '아래 검색된 위키 내용을 우선 근거로 질문에 답하라.',
      '사용한 근거는 [n]으로 표기하라. 검색 내용으로 답할 수 없으면 위키 밖 일반 지식임을 명시하라.',
      '',
      `# 검색된 위키\n${ctx || '(없음)'}`,
      '',
      `# 질문\n${question}`,
    ].join('\n');
  }
}
