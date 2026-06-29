import { Client, GatewayIntentBits, Events, Message } from 'discord.js';
import { MessengerPort, MentionEvent, ReplyTarget, MessengerConfig } from './messenger.port';

// Discord 어댑터(설계 §9 / Phase 6a). 생성자는 연결하지 않음 — login은 start()에서.
// ponytail: 네트워크 글루, 스모크만. 로직(필터·@제거)은 최소로 둔다.
export class DiscordAdapter implements MessengerPort {
  private readonly client: Client;
  private handler?: (e: MentionEvent) => Promise<void>;

  constructor(private readonly cfg: MessengerConfig) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });
  }

  onMention(handler: (e: MentionEvent) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.client.on(Events.MessageCreate, async (m: Message) => {
      if (m.author.bot) return;                                   // 봇/자기 자신 무시
      if (!this.client.user || !m.mentions.has(this.client.user)) return; // @Engram 멘션만
      const text = m.content.replace(/<@!?\d+>/g, '').trim();     // 멘션 토큰 제거
      if (this.handler) await this.handler({
        text, channelId: m.channelId, authorId: m.author.id, target: m as ReplyTarget,
      });
    });
    await this.client.login(this.cfg.token);
  }

  async reply(target: ReplyTarget, text: string): Promise<void> {
    await (target as Message).reply(text);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }
}
