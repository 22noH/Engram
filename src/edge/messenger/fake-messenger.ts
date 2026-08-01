import { MessengerPort, MentionEvent, ReplyTarget } from './messenger.port';
import type { ProgressRun } from '../../../shared/protocol';

// 결정론적 가짜 메신저(FakeBrain/FakeEmbedder와 같은 역할). 멘션 주입·답 캡처용.
export class FakeMessenger implements MessengerPort {
  private handler?: (e: MentionEvent) => Promise<void>;
  private msgHandler?: (e: MentionEvent) => Promise<void>;
  readonly replies: Array<{ target: ReplyTarget; text: string }> = [];
  // progress/completionReport: 전달됐을 때만 필드가 생긴다(기존 toEqual 단언 그대로 통과 — 회귀 0).
  readonly channelPosts: Array<{ channelId: string; threadId?: string; text: string; progress?: boolean | ProgressRun; completionReport?: boolean }> = [];
  // Task 1(brain-activity): 브리지가 port.activity 유무로 activity fn을 빌드하므로 여기 구현해둬야
  // bindMessenger의 그 분기를 테스트로 확인할 수 있다(추가만 — 안 부르는 기존 테스트는 그대로 통과).
  readonly activities: Array<{ channelId: string; label: string }> = [];
  // 답변 실시간 스트리밍: activities와 같은 이유(브리지가 port.delta 유무로 delta fn을 빌드한다).
  readonly deltas: Array<{ channelId: string; text: string }> = [];

  onMention(handler: (e: MentionEvent) => Promise<void>): void {
    this.handler = handler;
  }

  onMessage(handler: (e: MentionEvent) => Promise<void>): void {
    this.msgHandler = handler;
  }

  async reply(target: ReplyTarget, text: string): Promise<void> {
    this.replies.push({ target, text });
  }
  async postToChannel(channelId: string, text: string, threadId?: string, progress?: boolean | ProgressRun, completionReport?: boolean): Promise<void> {
    this.channelPosts.push({
      channelId, threadId, text,
      ...(progress !== undefined ? { progress } : {}),
      ...(completionReport !== undefined ? { completionReport } : {}),
    });
  }
  activity(channelId: string, label: string): void {
    this.activities.push({ channelId, label });
  }
  delta(channelId: string, text: string): void {
    this.deltas.push({ channelId, text });
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
