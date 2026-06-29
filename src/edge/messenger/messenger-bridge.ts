import { MessengerPort } from './messenger.port';
import { CoreMessage } from '../core-message';

// Orchestrator를 구조적 타입으로만 의존(순환 import 회피·테스트 용이).
export interface MentionHandler {
  handleMention(msg: CoreMessage, onAck?: (t: string) => Promise<void>): Promise<string>;
}

// 멘션을 handleMention으로 흘리고 답을 그 자리에 게시. 실패해도 상주를 죽이지 않는다.
export function bindMessenger(
  port: MessengerPort,
  orchestrator: MentionHandler,
  logger: { warn(msg: string, ctx?: string): void },
): void {
  port.onMention(async (e) => {
    try {
      const answer = await orchestrator.handleMention(
        { text: e.text, userId: e.channelId },          // 채널 ID = 맥락 네임스페이스(멀티플레이어)
        (ack) => port.reply(e.target, ack),             // 처리 중 메시지(선택)
      );
      await port.reply(e.target, answer);               // 최종 결과
    } catch (err) {
      logger.warn(`멘션 처리 실패: ${String(err)}`, 'Messenger');
      try { await port.reply(e.target, '지금 처리가 안 되네요 🙏'); } catch { /* reply도 실패하면 포기 */ }
    }
  });
}
