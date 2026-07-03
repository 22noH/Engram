import { Inject, Injectable, Optional } from '@nestjs/common';
import { RagStore } from '../knowledge-core/rag/rag-store';
import { SearchResult } from '../knowledge-core/rag/rag.types';
import { BRAIN, BrainProvider } from '../brain/brain.port';
import { PinoLogger } from '../pal/logger';
import { CoreMessage } from '../edge/core-message';
import { InsightContext } from '../knowledge-core/insight/insight-context';
import { ConversationStore, ConversationRecord } from '../knowledge-core/conversation-store';

const NO_HITS_HEADER = '⚠ 위키에 관련 내용 없음 — 일반 지식 기반 답변\n\n';
const RECENT_TURNS = 6; // 직전 대화 주입 개수 — 연속성용 단기 창(장기 기억은 위키)

// A 읽기(설계 §7.2). 질문 → RAG 검색 → 컨텍스트 종합 → 답 + 출처.
// 에이전트 자체는 stateless — 연속성은 ConversationStore의 직전 n턴을 프롬프트에 주입해서 얻는다.
@Injectable()
export class ReaderAgent {
  constructor(
    private readonly rag: RagStore,
    @Inject(BRAIN) private readonly brain: BrainProvider,
    private readonly logger: PinoLogger,
    @Optional() private readonly insight?: InsightContext,
    @Optional() private readonly conversations?: ConversationStore,
  ) {}

  async handle(
    msg: CoreMessage,
    onChunk?: (t: string) => void,
    onSources?: (slugs: string[]) => void,
  ): Promise<string> {
    const emit = (s: string): void => onChunk?.(s);
    try {
      const hits = await this.rag.search(msg.text, 5, msg.userId);
      onSources?.(hits.map((h) => h.slug));
      const header = hits.length === 0 ? NO_HITS_HEADER : '';
      if (header) emit(header);

      const ctx = this.insight ? await this.insight.latest(msg.userId) : '';
      // 직전 대화 실패는 연속성만 포기(답변 자체는 진행) — 격리.
      let recent: ConversationRecord[] = [];
      try {
        recent = this.conversations ? await this.conversations.recent(msg.userId, RECENT_TURNS) : [];
      } catch { recent = []; }
      const result = await this.brain.complete(this.buildPrompt(msg.text, hits, ctx, recent), onChunk);
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
  private buildPrompt(question: string, hits: SearchResult[], ctx = '', recent: ConversationRecord[] = []): string {
    const context = hits.map((h, i) => `[${i + 1}] ${h.title} (slug: ${h.slug})\n${h.text}`).join('\n\n');
    const clip = (s: string): string => (s.length > 400 ? s.slice(0, 400) + '…' : s);
    const recentBlock = recent.length
      ? `# 직전 대화 (연속성 참고 — 사실 근거 아님, 근거는 아래 위키)\n${recent
          .map((r) => `사용자: ${clip(r.question)}\nEngram: ${clip(r.answer)}`)
          .join('\n')}\n\n`
      : '';
    const insightBlock = ctx
      ? `# 참고용 사용자 맥락 (답의 근거 아님 — 근거는 아래 위키)\n${ctx}\n\n`
      : '';
    return [
      '아래 검색된 위키 내용을 우선 근거로 질문에 답하라.',
      '사용한 근거는 [n]으로 표기하라. 검색 내용으로 답할 수 없으면 위키 밖 일반 지식임을 명시하라.',
      '직전 대화가 있으면 그 흐름을 이어서 답하라(짧은 답장·지시어는 직전 대화 기준으로 해석).',
      // UI가 ```chart 블록을 인라인 SVG 그래프로 렌더한다 — 수치/시계열이 있으면 함께 넣게 유도.
      '수치 비교나 시계열(지수 추이·항목별 비교 등)이 있으면 그 값으로 차트 블록을 함께 넣어라(UI가 그래프로 렌더): ```chart {"type":"bar 또는 line","title":"제목","labels":["A","B"],"values":[1,2],"unit":"%"} ``` — 한 줄 JSON, 실제 근거 수치일 때만, 지어내지 말 것.',
      '',
      recentBlock + insightBlock + `# 검색된 위키\n${context || '(없음)'}`,
      '',
      `# 질문\n${question}`,
    ].join('\n');
  }
}
