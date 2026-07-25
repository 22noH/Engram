import { MessengerPort } from './messenger.port';
import { CoreMessage } from '../core-message';
import { ChannelPolicy, allows } from '../../agent-layer/channel-policy';
import { t } from '../../agent-layer/i18n';
import { createDeltaCoalescer } from './delta-coalescer';
import { createStreamFenceGuard } from './stream-fence-guard';
import type { Action, Message } from '../../../shared/protocol';

// Orchestrator를 구조적 타입으로만 의존(순환 import 회피·테스트 용이).
export interface MentionHandler {
  handleMention(
    msg: CoreMessage,
    // question(ask-user Task 3): Orchestrator.PostFn과 짝(구조적 동일 — { questions: QuestionItem[] }).
    // toolsUsed(brain-activity Task 1): additive 4번째 인자 — 안 쓰는 호출부는 그대로(회귀 0).
    // progress(진행 중 표시): additive 5번째 — 다단계 작업의 중간 보고에만 서버가 붙이는 표식.
    post: (text: string, actions?: Action[], question?: Message['question'], toolsUsed?: string[], progress?: boolean) => Promise<void>,
    threadKey?: string,
    // activity(brain-activity Task 1): 대기 중 실시간 라벨 발화 — port.activity 미지원 어댑터면 undefined.
    activity?: (label: string) => void,
    // delta(답변 실시간 스트리밍): 생성 중인 답의 증분 텍스트 발화 — port.delta 미지원 어댑터면 undefined.
    // activity와 정확히 같은 결(additive 위치 인자, 미지원=undefined로 no-op 흡수).
    delta?: (text: string) => void,
  ): Promise<void>;
  // 관찰 끼어들기(6c-1) — 옵셔널(구식 스텁 호환).
  observe?(msg: CoreMessage, post: (text: string) => Promise<void>): Promise<void>;
}

// 멘션을 handleMention으로 흘린다. handleMention이 post로 직접 게시(ack·진행·결과·상태).
// 실패해도 상주를 죽이지 않는다. policy가 있으면 observe opt-in 채널의 일반 메시지도 observe로 흘린다.
export function bindMessenger(
  port: MessengerPort,
  orchestrator: MentionHandler,
  logger: { warn(msg: string, ctx?: string): void },
  policy?: ChannelPolicy,
): void {
  port.onMention(async (e) => {
    const post = (text: string, actions?: Action[], question?: Message['question'], toolsUsed?: string[], progress?: boolean): Promise<void> =>
      port.reply(e.target, text, actions, question, toolsUsed, progress);
    const threadKey = e.threadId ?? e.channelId; // 스레드 우선, 없으면 채널
    // Task 1(brain-activity): port.activity 지원 어댑터(self.adapter)만 채널에 바인딩된 activity fn을
    // 만든다 — 미지원 어댑터는 undefined(orchestrator/reader-agent가 그대로 no-op으로 흡수, 회귀 0).
    // never-throw: UI 브로드캐스트 실패가 두뇌 하네스의 도구 루프를 끊으면 안 된다.
    const activity = port.activity
      ? (label: string): void => { try { port.activity!(e.channelId, label); } catch { /* 격리 */ } }
      : undefined;
    // 답변 실시간 스트리밍: activity와 같은 결로 port.delta 지원 어댑터(self.adapter)에서만 만든다.
    // 다만 두뇌 onChunk는 토큰마다 오므로 그대로 프레임을 쏘면 폭주 — 코얼레서를 끼워 짧은 간격으로
    // 모아 보낸다. 턴이 끝나면(성공·실패 무관) 반드시 stop()으로 타이머·버퍼를 정리한다(누수 0,
    // 최종 msg가 확정이라 꼬리 조각은 버린다).
    const coalescer = port.delta
      ? createDeltaCoalescer((text: string): void => { try { port.delta!(e.channelId, text); } catch { /* 격리 */ } })
      : undefined;
    // 펜스 가드는 코얼레서 "앞"에 선다: 확정 전 원시 JSON(```ask_user/```engram:propose)이 화면에 새지
    // 않게 델타 단계에서 미리 걸러야 하고, 코얼레서는 이미 걸러진 표시용 텍스트만 모으면 되기 때문이다.
    // (반대 순서면 가드가 조각 경계를 다시 붙여야 해 상태기계가 두 겹이 된다.) 최종 msg 프레임이 여전히
    // 권위라 가드가 버린 조각은 표시에서만 사라진다 — 저장·확정 텍스트엔 영향 0.
    const guard = coalescer ? createStreamFenceGuard() : undefined;
    const delta = coalescer && guard
      ? (text: string): void => { const out = guard.push(text); if (out) coalescer.push(out); }
      : undefined;
    try {
      // 최종 리뷰 픽스(ask-user 답↔질문 상관관계): answeredQuestion이 있으면(=answersId 답장 재트리거,
      // ask_user 도구 경로) 브레인 프롬프트가 될 text 앞에 원본 질문 문맥을 붙인다. 없으면 e.text 그대로
      // (기존과 바이트 동일 — 회귀 0). mode/repoPath/brain과 같은 결로 여기가 MentionEvent→CoreMessage
      // 유일 변환점이라 프롬프트 조립 전 이 한 곳에서만 손대면 된다.
      // 재리뷰 minor: 이 두 마커는 브레인 프롬프트 안(ReaderAgent.buildPrompt의 지시문·TOOL_USAGE_GUIDANCE와
      // 같은 자리)에 들어가는 문구지 채팅에 찍히는 사용자향 텍스트가 아니다 — t()는 ENGRAM_LANG 설정에 따라
      // 로케일화되는 사용자향 사전이라(i18n.ts 주석), 여기 쓰면 설정이 ko일 때 이 마커만 한글이고 buildPrompt의
      // 나머지 지시문은 전부 영어인 채로 남아 오히려 불일치가 커진다. 그래서 t()를 쓰지 않고, buildPrompt의
      // 다른 상수 지시문들과 같은 결로 중립 영어 문구를 그대로 하드코딩한다.
      const text = e.answeredQuestion ? `[The user answered this question]\n${e.answeredQuestion}\n[Answer]\n${e.text}` : e.text;
      // 지식 네임스페이스는 채널 유지(userId=channelId, 멀티플레이어).
      await orchestrator.handleMention(
        {
          text, userId: e.channelId,
          ...(e.mode ? { mode: e.mode, repoPath: e.repoPath } : {}),
          ...(e.brain ? { brain: e.brain } : {}),
          // 노력(effort): 채널에 저장된 값을 그대로 넘긴다 — 실제 적용값은 orchestrator가 정한다(단일 지점).
          ...(e.effort ? { effort: e.effort } : {}),
          // 권한 모드(permMode): effort와 동일 — 채널 저장값을 그대로 넘기고 적용 판단은 orchestrator.
          ...(e.permMode ? { permMode: e.permMode } : {}),
          // Task 3(chat-attachments): additive 관통 — 미첨부 send는 기존과 바이트 동일(회귀 0).
          ...(e.attachments && e.attachments.length ? { attachments: e.attachments } : {}),
        },
        post,
        threadKey,
        activity,
        delta,
      );
    } catch (err) {
      logger.warn(`멘션 처리 실패: ${String(err)}`, 'Messenger');
      try { await post(t('mentionHandleFailed')); } catch { /* post도 실패하면 포기 */ }
    } finally {
      coalescer?.stop();
    }
  });

  // 관찰(6c-1): 포트·정책·observe 셋 다 있을 때만 바인딩. opt-in 채널만 통과.
  if (port.onMessage && orchestrator.observe && policy) {
    port.onMessage(async (e) => {
      if (!allows(policy, e.channelId, 'observe')) return;
      try {
        await orchestrator.observe!(
          { text: e.text, userId: e.channelId, ...(e.brain ? { brain: e.brain } : {}) },
          (text) => port.postToChannel(e.channelId, text, e.threadId),
        );
      } catch (err) {
        logger.warn(`관찰 처리 실패: ${String(err)}`, 'Messenger');
      }
    });
  }
}
