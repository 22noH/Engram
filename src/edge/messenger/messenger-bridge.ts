import { MessengerPort } from './messenger.port';
import { CoreMessage } from '../core-message';
import { ChannelPolicy, allows } from '../../agent-layer/channel-policy';
import { t } from '../../agent-layer/i18n';
import type { Action } from '../../../shared/protocol';

// Orchestrator를 구조적 타입으로만 의존(순환 import 회피·테스트 용이).
export interface MentionHandler {
  handleMention(
    msg: CoreMessage,
    post: (text: string, actions?: Action[]) => Promise<void>,
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
    const post = (text: string, actions?: Action[]): Promise<void> => port.reply(e.target, text, actions);
    const threadKey = e.threadId ?? e.channelId; // 스레드 우선, 없으면 채널
    try {
      // 지식 네임스페이스는 채널 유지(userId=channelId, 멀티플레이어).
      await orchestrator.handleMention(
        { text: e.text, userId: e.channelId, ...(e.mode ? { mode: e.mode, repoPath: e.repoPath } : {}), ...(e.brain ? { brain: e.brain } : {}) },
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
