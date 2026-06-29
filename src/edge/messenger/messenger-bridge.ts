import { MessengerPort } from './messenger.port';
import { CoreMessage } from '../core-message';

// Orchestrator를 구조적 타입으로만 의존(순환 import 회피·테스트 용이).
export interface MentionHandler {
  handleMention(
    msg: CoreMessage,
    post: (text: string) => Promise<void>,
    threadKey?: string,
  ): Promise<void>;
}

// 멘션을 handleMention으로 흘린다. handleMention이 post로 직접 게시(ack·진행·결과·상태).
// 실패해도 상주를 죽이지 않는다.
export function bindMessenger(
  port: MessengerPort,
  orchestrator: MentionHandler,
  logger: { warn(msg: string, ctx?: string): void },
): void {
  port.onMention(async (e) => {
    const post = (text: string): Promise<void> => port.reply(e.target, text);
    const threadKey = e.threadId ?? e.channelId; // 스레드 우선, 없으면 채널
    try {
      // 지식 네임스페이스는 채널 유지(userId=channelId, 멀티플레이어).
      await orchestrator.handleMention({ text: e.text, userId: e.channelId }, post, threadKey);
    } catch (err) {
      logger.warn(`멘션 처리 실패: ${String(err)}`, 'Messenger');
      try { await post('지금 처리가 안 되네요 🙏'); } catch { /* post도 실패하면 포기 */ }
    }
  });
}
