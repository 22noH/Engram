import { Inject, Injectable, Optional } from '@nestjs/common';
import { RagStore } from '../knowledge-core/rag/rag-store';
import { SearchResult } from '../knowledge-core/rag/rag.types';
import { BRAIN, BrainProvider } from '../brain/brain.port';
import { PinoLogger } from '../pal/logger';
import { CoreMessage } from '../edge/core-message';
import { InsightContext } from '../knowledge-core/insight/insight-context';
import { ConversationStore, ConversationRecord } from '../knowledge-core/conversation-store';
import { outputDirective } from './language';
import { t } from './i18n';
import { BrainDelegator } from './brain-delegator';
import { loadPrompt } from './prompt-store';

const RECENT_TURNS = 6; // 직전 대화 주입 개수 — 연속성용 단기 창(장기 기억은 위키)

// prompts/conductor.md 없을 때의 내장 기본값(지휘자 지침 — out-of-box 동작 보장).
export const CONDUCTOR_DEFAULT = [
  'You can delegate subtasks to other registered brains using the ask_brain tool.',
  '- If the user names a specific brain for part of the work, use ask_brain to hand that part to it.',
  '- If you get stuck, or another brain would clearly do a part better, delegate it. For autonomous delegation, prefer local/free brains over paid API brains.',
  '- If the request is ambiguous, ask one brief clarifying question instead of guessing.',
  '- Coding delegation is not available yet — delegate only analysis, review, and writing tasks.',
].join('\n');

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
    @Optional() private readonly delegator?: BrainDelegator,
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
      const header = hits.length === 0 ? t('noHitsHeader') : '';
      if (header) emit(header);

      const ctx = this.insight ? await this.insight.latest(msg.userId) : '';
      // 직전 대화 실패는 연속성만 포기(답변 자체는 진행) — 격리.
      let recent: ConversationRecord[] = [];
      try {
        recent = this.conversations ? await this.conversations.recent(msg.userId, RECENT_TURNS) : [];
      } catch { recent = []; }
      // 지휘자 활성 조건: 위임기 주입됨 + 이 두뇌가 위임 지원(엔그램 하네스) + 위임 가능한 두뇌가 실재.
      // CLI 두뇌(canDelegate 없음)면 지휘자 오프 → 프롬프트·opts.delegate 모두 8d 이전과 동일(회귀 0).
      const session = this.delegator && this.brain.canDelegate ? this.delegator.handle() : undefined;
      const handle = session && session.brains.length > 0 ? session : undefined;
      const result = await this.brain.complete(
        this.buildPrompt(msg.text, hits, ctx, recent, !!handle),
        onChunk,
        handle ? { delegate: handle } : undefined,
      );
      // 위임 비용 노출(응답 문자열엔 비용 필드가 없어 로그로) — 스펙 §2.4 "비용 합산".
      if (handle && handle.spentUsd() > 0) {
        this.logger.log(`delegation cost $${handle.spentUsd().toFixed(4)}`, 'ReaderAgent');
      }
      if (result.isError) {
        const m = t('answerGenFailedBrainError');
        emit(m);
        return header + m;
      }

      const sources = hits.length
        ? t('sourcesFooter', hits.map((h, i) => `[${i + 1}] ${h.title} (${h.slug})`).join(' · '))
        : '';
      if (sources) emit(sources);
      return header + result.text + sources;
    } catch (err) {
      this.logger.error('ReaderAgent.handle 실패', String(err), 'ReaderAgent');
      const m = t('answerGenFailedWithError', String(err));
      emit(m);
      return m;
    }
  }

  // 검색된 위키를 번호 매긴 컨텍스트로 조립 + 근거 우선·출처 표기 지시.
  private buildPrompt(question: string, hits: SearchResult[], ctx = '', recent: ConversationRecord[] = [], conductorOn = false): string {
    const context = hits.map((h, i) => `[${i + 1}] ${h.title} (slug: ${h.slug})\n${h.text}`).join('\n\n');
    const clip = (s: string): string => (s.length > 400 ? s.slice(0, 400) + '…' : s);
    const recentBlock = recent.length
      ? `# Prior conversation (continuity reference — not evidence; evidence is the wiki below)\n${recent
          .map((r) => `User: ${clip(r.question)}\nEngram: ${clip(r.answer)}`)
          .join('\n')}\n\n`
      : '';
    const insightBlock = ctx
      ? `# User context for reference (not evidence — evidence is the wiki below)\n${ctx}\n\n`
      : '';
    const conductorBlock = conductorOn ? `# Delegation\n${loadPrompt('conductor', CONDUCTOR_DEFAULT)}\n\n` : '';
    return [
      'Answer the question using the searched wiki content below as the primary basis.',
      'Mark the evidence you use with [n]. If the search content cannot answer it, state that this is general knowledge outside the wiki.',
      'If there is prior conversation, continue its flow (interpret short replies and pronouns against the prior conversation).',
      'If there are numbers/time series, include a chart block (the UI renders it as a graph): ```chart {"type":"bar|line|pie","title":"title","labels":["A","B"],"values":[1,2],"unit":"%"} ``` (bar/line = trend/compare, pie = share).',
      'Per-item comparisons also work as a markdown table (| header | ... |) — for changes attach arrows like ▲2.3% (up) / ▼1.1% (down) and the UI colors them green/red. Use - [ ] / - [x] checkboxes for to-do lists.',
      outputDirective('interactive'),
      '',
      conductorBlock + recentBlock + insightBlock + `# Searched wiki\n${context || '(none)'}`,
      '',
      `# Question\n${question}`,
    ].join('\n');
  }
}
