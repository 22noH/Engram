import { Inject, Injectable, Optional } from '@nestjs/common';
import { RagStore } from '../knowledge-core/rag/rag-store';
import { SearchResult } from '../knowledge-core/rag/rag.types';
import { BRAIN, BrainProvider, CompleteOpts } from '../brain/brain.port';
import { PinoLogger } from '../pal/logger';
import { CoreMessage } from '../edge/core-message';
import { InsightContext } from '../knowledge-core/insight/insight-context';
import { ConversationStore, ConversationRecord } from '../knowledge-core/conversation-store';
import { outputDirective } from './language';
import { t } from './i18n';
import { BrainDelegator } from './brain-delegator';
import { ChannelBrainResolver } from './channel-brain-resolver';
import { loadPrompt } from './prompt-store';
import { AskUserPayload } from './ask-user-block';

const RECENT_TURNS = 6; // 직전 대화 주입 개수 — 연속성용 단기 창(장기 기억은 위키)

// prompts/conductor.md 없을 때의 내장 기본값(지휘자 지침 — out-of-box 동작 보장).
export const CONDUCTOR_DEFAULT = [
  'You can delegate subtasks to other registered brains using the ask_brain tool.',
  '- If the user names a specific brain for part of the work, use ask_brain to hand that part to it.',
  '- If you get stuck, or another brain would clearly do a part better, delegate it. For autonomous delegation, prefer local/free brains over paid API brains.',
  '- If the request is ambiguous, ask one brief clarifying question instead of guessing.',
  '- Coding delegation is not available yet — delegate only analysis, review, and writing tasks.',
].join('\n');

// 도구 사용 지침(MCP-parity Task 4 리뷰 지적) — conductor 게이트(위임 지원 두뇌만)와 무관하게
// 모든 ReaderAgent 프롬프트에 무조건 포함한다. CLI 하네스(canDelegate 없음 — --allowedTools로
// MCP 전체가 열림)도 이 문장을 받아야 자동/예약 컨텍스트에서 쓰기 도구를 남용하지 않는다.
// 문장 자체가 자기 범위 한정("자동/예약 컨텍스트에서만…")이라 일반 채팅에 섞여도 안전.
// ask-user 범용 경로(Task 3) 안내를 이어붙인다 — 도구가 없는 CLI 하네스·비도구 로컬 LLM도
// 이 프롬프트 문장 하나로 질문 카드를 낼 수 있어야 한다(응답 텍스트 뒤에 펜스 블록만 붙이면 되므로
// 도구 호출 없이도 동작). orchestrator.ts의 extractAskUser가 이 형식을 그대로 파싱한다.
export const TOOL_USAGE_GUIDANCE =
  'In a scheduled or automatic-execution context, only use tools that write externally (sending messages, editing documents, etc.) when the task instruction explicitly calls for it — otherwise favor read-only actions. ' +
  'When you reach a point where the user genuinely needs to decide between options before you can continue, ask with a structured question card instead of asking in plain prose: append a fenced block to the end of your reply, starting with ```ask_user on its own line, then one line of JSON, then a closing ``` on its own line. ' +
  'The JSON shape is {"questions":[{"q":"the question","header":"optional short title","multiSelect":false,"options":[{"label":"the choice","desc":"optional one-line detail","recommended":true}]}]} — 1 to 4 questions, each with 2 to 4 options, and at most one option per question marked recommended. Only the first ```ask_user block in a reply is used. ' +
  'Do not use this in a scheduled or automatic-trigger turn — there is no user present there to answer it.';

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
    // 채널별 두뇌 해소(스펙 §3.2). 미주입(구식 DI·기존 테스트)이면 항상 주입 BRAIN 사용(회귀 0).
    @Optional() private readonly channelBrain?: ChannelBrainResolver,
  ) {}

  async handle(
    msg: CoreMessage,
    onChunk?: (t: string) => void,
    onSources?: (slugs: string[]) => void,
    // Task 4: 있으면 위임(delegate)과 같은 자리에서 CompleteOpts.askUser로 실어보낸다(자체 하네스가
    // ask_user 도구를 노출). 호출부(orchestrator.route)가 인터랙티브/예약을 가르지 않으므로 여기도
    // 가르지 않는다 — TOOL_USAGE_GUIDANCE(프롬프트 지침)가 예약 턴에서 쓰지 말라고 이미 안내한다.
    askUser?: (q: AskUserPayload) => Promise<void>,
  ): Promise<string> {
    const emit = (s: string): void => onChunk?.(s);
    // 요청 한정 지역 변수(스펙 §3.2) — this.brain(싱글턴)에 대입하지 않는다.
    // channelBrain 미주입 시 항상 this.brain 그대로(회귀 0). msg.brain 미지정이면 resolve가 this.brain을 돌려준다.
    const brain = this.channelBrain ? this.channelBrain.resolve(msg.brain) : this.brain;
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
      // 게이트는 해소된(채널) 두뇌의 canDelegate 기준 — 기본 두뇌가 아니라 이 요청이 실제로 쓰는 두뇌.
      // msg.brain을 selfName으로 넘긴다(최종 리뷰 지적 — 자기위임 데드락 차단): 채널 두뇌가 지정돼 있으면
      // 그 이름이 곧 지휘자 자신이 resolve된 인스턴스 이름 — 목록에서 빼야 자기 자신에게 위임해 세마포어
      // 재진입으로 데드락하지 않는다. 기본 지휘자(msg.brain 미설정)는 undefined → 전 목록 그대로(회귀 0).
      const session = this.delegator && brain.canDelegate ? this.delegator.handle(msg.brain) : undefined;
      const handle = session && session.brains.length > 0 ? session : undefined;
      const completeOpts: CompleteOpts | undefined = handle || askUser
        ? { ...(handle ? { delegate: handle } : {}), ...(askUser ? { askUser } : {}) }
        : undefined;
      const result = await brain.complete(
        this.buildPrompt(msg.text, hits, ctx, recent, !!handle),
        onChunk,
        completeOpts,
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
      TOOL_USAGE_GUIDANCE,
      '',
      conductorBlock + recentBlock + insightBlock + `# Searched wiki\n${context || '(none)'}`,
      '',
      `# Question\n${question}`,
    ].join('\n');
  }
}
