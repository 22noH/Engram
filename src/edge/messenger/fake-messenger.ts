import { MessengerPort, MentionEvent, ReplyTarget } from './messenger.port';

// 결정론적 가짜 메신저(FakeBrain/FakeEmbedder와 같은 역할). 멘션 주입·답 캡처용.
export class FakeMessenger implements MessengerPort {
  private handler?: (e: MentionEvent) => Promise<void>;
  private msgHandler?: (e: MentionEvent) => Promise<void>;
  readonly replies: Array<{ target: ReplyTarget; text: string }> = [];
  readonly channelPosts: Array<{ channelId: string; threadId?: string; text: string }> = [];

  onMention(handler: (e: MentionEvent) => Promise<void>): void {
    this.handler = handler;
  }

  onMessage(handler: (e: MentionEvent) => Promise<void>): void {
    this.msgHandler = handler;
  }

  async reply(target: ReplyTarget, text: string): Promise<void> {
    this.replies.push({ target, text });
  }
  async postToChannel(channelId: string, text: string, threadId?: string): Promise<void> {
    this.channelPosts.push({ channelId, threadId, text });
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  // 테스트 헬퍼: 멘션 1건 주입.
  async emit(e: MentionEvent): Promise<void> {
    if (this.handler) await this.handler(e);
  }

  // 테스트 헬퍼: 관찰(비멘션) 메시지 1건 주입.
  async emitMessage(e: MentionEvent): Promise<void> {
    if (this.msgHandler) await this.msgHandler(e);
  }
}
