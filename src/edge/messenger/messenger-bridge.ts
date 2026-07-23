import { MessengerPort } from './messenger.port';
import { CoreMessage } from '../core-message';
import { ChannelPolicy, allows } from '../../agent-layer/channel-policy';
import { t } from '../../agent-layer/i18n';
import type { Action, Message } from '../../../shared/protocol';

// Orchestrator를 구조적 타입으로만 의존(순환 import 회피·테스트 용이).
export interface MentionHandler {
  handleMention(
    msg: CoreMessage,
    // question(ask-user Task 3): Orchestrator.PostFn과 짝(구조적 동일 — { questions: QuestionItem[] }).
    post: (text: string, actions?: Action[], question?: Message['question']) => Promise<void>,
    threadKey?: string,
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
    const post = (text: string, actions?: Action[], question?: Message['question']): Promise<void> =>
      port.reply(e.target, text, actions, question);
    const threadKey = e.threadId ?? e.channelId; // 스레드 우선, 없으면 채널
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
          // Task 3(chat-attachments): additive 관통 — 미첨부 send는 기존과 바이트 동일(회귀 0).
          ...(e.attachments && e.attachments.length ? { attachments: e.attachments } : {}),
        },
        post,
        threadKey,
      );
    } catch (err) {
      logger.warn(`멘션 처리 실패: ${String(err)}`, 'Messenger');
      try { await post(t('mentionHandleFailed')); } catch { /* post도 실패하면 포기 */ }
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
