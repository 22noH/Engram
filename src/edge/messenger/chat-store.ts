import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

// 채팅 기록 영속(스펙 §4.2). 메시지=state/chat/{channelId}.jsonl append 전용,
// 채널 목록=state/chat/channels.json. 손상 줄 skip(ConversationStore 관례).
// 채널 삭제는 목록에서만 — jsonl은 보존(데이터 삭제 opt-in 관례).

export interface ChatMessage {
  id: string;
  authorId: string;
  text: string;
  threadId?: string;
  ts: string; // ISO
}

export interface ChatChannel {
  id: string;
  name: string;
  respondMode: 'all' | 'mention';
  ownerId?: string;                    // 9b: 계정 도입 시 소유자
  visibility?: 'public' | 'private';   // 9b: 비공개 잠금
}

// channelId는 클라이언트 유래(신뢰 경계) — 파일명에 쓰기 전 검증.
function safeId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && !/[\\/]|\.\./.test(id);
}

export class ChatStore {
  constructor(private readonly chatDir: string) {}

  private channelsPath(): string {
    return path.join(this.chatDir, 'channels.json');
  }
  private messagesPath(channelId: string): string {
    return path.join(this.chatDir, `${channelId}.jsonl`);
  }
  private save(list: ChatChannel[]): void {
    fs.mkdirSync(this.chatDir, { recursive: true });
    fs.writeFileSync(this.channelsPath(), JSON.stringify(list, null, 2));
  }

  listChannels(): ChatChannel[] {
    let list: ChatChannel[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.channelsPath(), 'utf8')) as ChatChannel[];
      if (Array.isArray(raw)) {
        list = raw.filter((c) => c && safeId(c.id) && typeof c.name === 'string');
      }
    } catch { /* 파일없음/손상 시 기본 생성 */ }
    if (list.length === 0) {
      list = [{ id: 'general', name: 'general', respondMode: 'all' }];
      this.save(list);
    }
    return list;
  }

  createChannel(name: string): ChatChannel | null {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return null;
    const list = this.listChannels();
    const ch: ChatChannel = { id: randomUUID(), name: trimmed, respondMode: 'all' };
    list.push(ch);
    this.save(list);
    return ch;
  }

  deleteChannel(id: string): boolean {
    const list = this.listChannels();
    const next = list.filter((c) => c.id !== id);
    if (next.length === list.length) return false;
    this.save(next);
    return true;
  }

  setRespondMode(id: string, mode: 'all' | 'mention'): boolean {
    if (mode !== 'all' && mode !== 'mention') return false;
    const list = this.listChannels();
    const ch = list.find((c) => c.id === id);
    if (!ch) return false;
    ch.respondMode = mode;
    this.save(list);
    return true;
  }

  has(channelId: string): boolean {
    return safeId(channelId) && this.listChannels().some((c) => c.id === channelId);
  }

  appendMessage(
    channelId: string,
    input: { authorId: string; text: string; threadId?: string },
  ): ChatMessage | null {
    if (!this.has(channelId)) return null;
    const msg: ChatMessage = {
      id: randomUUID(),
      authorId: input.authorId,
      text: input.text,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ts: new Date().toISOString(),
    };
    fs.mkdirSync(this.chatDir, { recursive: true });
    fs.appendFileSync(this.messagesPath(channelId), JSON.stringify(msg) + '\n');
    return msg;
  }

  // ponytail: 전체 읽기 O(n) — 개인 규모. 파일이 커지면 tail 인덱스로.
  history(channelId: string, opts?: { limit?: number; before?: string }): ChatMessage[] {
    if (!this.has(channelId)) return [];
    let lines: string[];
    try {
      lines = fs.readFileSync(this.messagesPath(channelId), 'utf8').split('\n').filter(Boolean);
    } catch {
      return []; // 파일 없음 = 메시지 없음
    }
    const msgs: ChatMessage[] = [];
    for (const l of lines) {
      try {
        const m = JSON.parse(l) as ChatMessage;
        if (m && typeof m.id === 'string' && typeof m.text === 'string') msgs.push(m);
      } catch { /* 손상 줄 skip */ }
    }
    let end = msgs.length;
    if (opts?.before) {
      const i = msgs.findIndex((m) => m.id === opts.before);
      if (i >= 0) end = i;
    }
    const limit = opts?.limit ?? 100;
    return msgs.slice(Math.max(0, end - limit), end);
  }
}
