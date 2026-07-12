import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Action } from '../../../shared/protocol';

// 채팅 기록 영속(스펙 §4.2). 메시지=state/chat/{channelId}.jsonl append 전용,
// 채널 목록=state/chat/channels.json. 손상 줄 skip(ConversationStore 관례).
// 채널 삭제는 목록에서만 — jsonl은 보존(데이터 삭제 opt-in 관례).

export interface ChatMessage {
  id: string;
  authorId: string;
  authorName?: string;
  text: string;
  threadId?: string;
  actions?: Action[];
  ts: string; // ISO
}

export interface ChatChannel {
  id: string;
  name: string;
  respondMode: 'all' | 'mention';
  mode?: 'chat' | 'code' | 'team';     // Phase 11b: team 추가. 누락/오염=chat.
  repoPath?: string;                   // Phase 10: Code 채널이 바인딩한 레포 절대경로.
  creatorId?: string;                  // Phase 16b: 만든 사람 계정 id(소유권 예외 판정용)
  ownerId?: string;                    // 9b/16c: 비공개 채널 소유자(별개 — 건드리지 않음)
  visibility?: 'public' | 'private';   // Phase 16c: 비공개 = 초대된 사람만
  memberIds?: string[];                // Phase 16c: 비공개 채널 입장 허용 계정 id
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
        // respondMode는 손수정 channels.json 등으로 오염될 수 있어 값을 정규화(드롭 대신 안전값으로 교정).
        list = raw
          .filter((c) => c && safeId(c.id) && typeof c.name === 'string')
          .map((c) => ({
            ...c,
            respondMode: c.respondMode === 'mention' ? 'mention' : 'all',
            mode: c.mode === 'code' ? 'code' : c.mode === 'team' ? 'team' : 'chat',
          }));
      }
    } catch { /* 파일없음/손상 시 기본 생성 */ }
    if (list.length === 0) {
      list = [{ id: 'general', name: 'general', respondMode: 'all', mode: 'chat' }];
      this.save(list);
    }
    return list;
  }

  createChannel(name: string, mode: 'chat' | 'code' | 'team' = 'chat', creatorId?: string, visibility?: 'public' | 'private'): ChatChannel | null {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return null;
    const list = this.listChannels();
    const m = mode === 'code' ? 'code' : mode === 'team' ? 'team' : 'chat';
    // Team 채널은 사람 대화 영역 → 기본 멘션-전용(Ask=all과 구분). Phase 14에서 실동작.
    const ch: ChatChannel = { id: randomUUID(), name: trimmed, respondMode: m === 'team' ? 'mention' : 'all', mode: m, ...(creatorId ? { creatorId } : {}), ...(visibility === 'private' ? { visibility: 'private' } : {}) };
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

  setRepoPath(id: string, repoPath: string): boolean {
    if (typeof repoPath !== 'string' || !repoPath.trim()) return false;
    const list = this.listChannels();
    const ch = list.find((c) => c.id === id);
    if (!ch) return false;
    ch.repoPath = repoPath.trim();
    this.save(list);
    return true;
  }

  setVisibility(id: string, visibility: 'public' | 'private'): boolean {
    const list = this.listChannels();
    const ch = list.find((c) => c.id === id);
    if (!ch) return false;
    if (visibility === 'private') {
      ch.visibility = 'private';
    } else {
      delete ch.visibility;
    }
    this.save(list);
    return true;
  }

  setMembers(id: string, memberIds: string[]): boolean {
    const list = this.listChannels();
    const ch = list.find((c) => c.id === id);
    if (!ch) return false;
    ch.memberIds = memberIds.filter((x) => typeof x === 'string');
    this.save(list);
    return true;
  }

  has(channelId: string): boolean {
    return safeId(channelId) && this.listChannels().some((c) => c.id === channelId);
  }

  appendMessage(
    channelId: string,
    input: { authorId: string; authorName?: string; text: string; threadId?: string; actions?: Action[] },
  ): ChatMessage | null {
    if (!this.has(channelId)) return null;
    const msg: ChatMessage = {
      id: randomUUID(),
      authorId: input.authorId,
      text: input.text,
      ...(input.authorName ? { authorName: input.authorName } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.actions ? { actions: input.actions } : {}),
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
