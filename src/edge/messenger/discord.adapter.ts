import { Client, GatewayIntentBits, Events, Message } from 'discord.js';
import { MessengerPort, MentionEvent, ReplyTarget, MessengerConfig } from './messenger.port';
import type { Action } from '../../../shared/protocol';

// Discord 어댑터(설계 §9 / Phase 6a). 생성자는 연결하지 않음 — login은 start()에서.
// ponytail: 네트워크 글루, 스모크만. 로직(필터·@제거)은 최소로 둔다.

/** 메시지를 처리해야 하는지 판단한다. 봇 메시지이거나 멘션이 아니면 false. */
export function shouldHandleMessage(authorIsBot: boolean, isMentioned: boolean): boolean {
  return !authorIsBot && isMentioned;
}

/** 관찰(6c-1) 대상인지: 봇이 아니고 멘션도 아닌 일반 메시지. */
export function shouldObserveMessage(authorIsBot: boolean, isMentioned: boolean): boolean {
  return !authorIsBot && !isMentioned;
}

/** Discord 앵글브래킷 토큰(<@123>, <@&456>, <#789> 등)을 모두 제거하고 trim한다. */
export function stripMentionTokens(content: string): string {
  return content.replace(/<[^>]+>/g, '').trim();
}

export class DiscordAdapter implements MessengerPort {
  private readonly client: Client;
  private handler?: (e: MentionEvent) => Promise<void>;
  private msgHandler?: (e: MentionEvent) => Promise<void>;

  constructor(private readonly cfg: MessengerConfig) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });
  }

  onMention(handler: (e: MentionEvent) => Promise<void>): void {
    this.handler = handler;
  }

  onMessage(handler: (e: MentionEvent) => Promise<void>): void {
    this.msgHandler = handler;
  }

  async start(): Promise<void> {
    this.client.on(Events.MessageCreate, async (m: Message) => {
      // @everyone / 역할핑 / 답글멘션은 제외하고, 직접 @Engram 유저멘션만 처리(§4.2②)
      const isMentioned = !!this.client.user && m.mentions.has(this.client.user, {
        ignoreEveryone: true,
        ignoreRoles: true,
        ignoreRepliedUser: true,
      });
      if (shouldHandleMessage(m.author.bot, isMentioned)) {
        const text = stripMentionTokens(m.content);
        if (this.handler) await this.handler({
          text, channelId: m.channelId, authorId: m.author.id, target: m as ReplyTarget,
        });
        return;
      }
      // 관찰(6c-1): 비멘션 일반 메시지. 어댑터는 정책을 모른다(필터는 bridge).
      // ponytail: 네트워크 글루, 스모크만.
      if (shouldObserveMessage(m.author.bot, isMentioned) && this.msgHandler) {
        await this.msgHandler({
          text: m.content.trim(), channelId: m.channelId, authorId: m.author.id, target: m as ReplyTarget,
        });
      }
    });
    await this.client.login(this.cfg.token);
  }

  async reply(target: ReplyTarget, text: string, _actions?: Action[]): Promise<void> {
    // actions는 self 클라 전용 — Discord는 텍스트만 게시(하위호환).
    await (target as Message).reply(text);
  }

  // 채널 ID로 게시(영속 발사가 되쏠 경로, Phase 6b-3). 스레드 우선.
  // ponytail: 네트워크 글루, 스모크만.
  async postToChannel(channelId: string, text: string, threadId?: string): Promise<void> {
    const ch = await this.client.channels.fetch(threadId ?? channelId);
    if (ch && ch.isTextBased()) {
      await (ch as import('discord.js').TextChannel).send(text);
    }
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }
}
