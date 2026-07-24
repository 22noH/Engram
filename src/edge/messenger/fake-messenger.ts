import { MessengerPort, MentionEvent, ReplyTarget } from './messenger.port';

// 결정론적 가짜 메신저(FakeBrain/FakeEmbedder와 같은 역할). 멘션 주입·답 캡처용.
export class FakeMessenger implements MessengerPort {
  private handler?: (e: MentionEvent) => Promise<void>;
  private msgHandler?: (e: MentionEvent) => Promise<void>;
  readonly replies: Array<{ target: ReplyTarget; text: string }> = [];
  readonly channelPosts: Array<{ channelId: string; threadId?: string; text: string }> = [];
  // Task 1(brain-activity): 브리지가 port.activity 유무로 activity fn을 빌드하므로 여기 구현해둬야
  // bindMessenger의 그 분기를 테스트로 확인할 수 있다(추가만 — 안 부르는 기존 테스트는 그대로 통과).
  readonly activities: Array<{ channelId: string; label: string }> = [];

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
  activity(channelId: string, label: string): void {
    this.activities.push({ channelId, label });
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
