import { ChannelPoster } from './messenger.port';

// postToChannel 라우터(스펙 §4.3): self ChatStore가 아는 채널이면 self,
// 아니면 fallback(Discord). 포트가 하나뿐이면 사실상 통과.
export class MessengerHub implements ChannelPoster {
  constructor(
    private readonly store: { has(channelId: string): boolean },
    private readonly self: ChannelPoster,
    private readonly fallback?: ChannelPoster,
  ) {}

  async postToChannel(channelId: string, text: string, threadId?: string): Promise<void> {
    const port = this.store.has(channelId) ? this.self : (this.fallback ?? this.self);
    await port.postToChannel(channelId, text, threadId);
  }
}
