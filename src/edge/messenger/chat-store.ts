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
  brain?: string;                      // Task 1: 채널이 사용할 뇌(모델) 선택. 누락=기본값.
}

// channelId는 클라이언트 유래(신뢰 경계) — 파일명에 쓰기 전 검증.
function safeId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && !/[\\/]|\.\./.test(id);
}

// Task 1(S4): 대화 자동 보존 정책. 기본=unlimited(회귀 0 — 기존 동작 유지).
// count=채널당 최근 N개만 남김·days=최근 N일 이내 ts만 남김. 위키·RAG 절대 무관(대화 jsonl만).
export type RetentionPolicy = { mode: 'count' | 'days' | 'unlimited'; value?: number };

const UNLIMITED_RETENTION: RetentionPolicy = { mode: 'unlimited' };

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0;
}

function isPositiveNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

export class ChatStore {
  private retention: RetentionPolicy = UNLIMITED_RETENTION;

  constructor(private readonly chatDir: string, retention?: RetentionPolicy) {
    if (retention) this.setRetention(retention);
  }

  // 정책 소스(설정 파일 값)는 Task 2에서 배선 — 여기선 세터만 제공.
  // 알 수 없는/잘못된 mode는 안전하게 unlimited로 강등(오염 방지 관례).
  setRetention(policy: RetentionPolicy): void {
    if (policy && (policy.mode === 'count' || policy.mode === 'days' || policy.mode === 'unlimited')) {
      this.retention = policy;
    } else {
      this.retention = UNLIMITED_RETENTION;
    }
  }

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
        // brain도 마찬가지로 정규화: 비문자열/빈문자열이면 필드 자체 드롭.
        // 새 ChatChannel 필드는 여기에도 추가(누락 시 저장 때 소실) — 이 map은 명시적 필드 화이트리스트라
        // ChatChannel에 필드를 늘려도 여기 손대지 않으면 listChannels()가 조용히 걸러 그 필드가 없던 일이 된다.
        list = raw
          .filter((c) => c && safeId(c.id) && typeof c.name === 'string')
          .map((c) => {
            const normalized: ChatChannel = {
              id: c.id,
              name: c.name,
              respondMode: c.respondMode === 'mention' ? 'mention' : 'all',
              mode: c.mode === 'code' ? 'code' : c.mode === 'team' ? 'team' : 'chat',
            };
            // 선택적 필드들: 유효한 경우만 포함
            if (typeof c.repoPath === 'string') normalized.repoPath = c.repoPath;
            if (typeof c.creatorId === 'string') normalized.creatorId = c.creatorId;
            if (typeof c.ownerId === 'string') normalized.ownerId = c.ownerId;
            if (c.visibility === 'public' || c.visibility === 'private') normalized.visibility = c.visibility;
            if (Array.isArray(c.memberIds)) normalized.memberIds = c.memberIds;
            if (typeof c.brain === 'string' && c.brain.trim().length > 0) normalized.brain = c.brain;
            return normalized;
          });
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

  setChannelBrain(id: string, brain: string | null): boolean {
    const list = this.listChannels();
    const ch = list.find((c) => c.id === id);
    if (!ch) return false;
    if (brain === null) {
      delete ch.brain;
    } else {
      const trimmed = brain.trim();
      if (!trimmed) return false;
      ch.brain = trimmed;
    }
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
    this.pruneChannel(channelId); // 정책이 count/days면 여기서 오래된 줄 정리(unlimited=no-op).
    return msg;
  }

  // 현재 보존 정책을 한 채널에 적용(append 후 자동 호출 + 테스트/수동 트리거용 public).
  // 절대 throw하지 않음(append는 이미 성공했으므로 프루닝 실패는 로그만 남기고 계속).
  pruneChannel(id: string): void {
    try {
      const policy = this.retention;
      if (!policy || policy.mode === 'unlimited') return;
      if (!safeId(id)) return;
      const p = this.messagesPath(id);
      let raw: string;
      try {
        raw = fs.readFileSync(p, 'utf8');
      } catch {
        return; // 파일 없음 = 프루닝할 것 없음
      }
      const lines = raw.split('\n').filter(Boolean);
      let kept: string[];
      if (policy.mode === 'count') {
        if (!isPositiveInt(policy.value)) return; // 값 없거나 양의 정수 아니면 no-op
        kept = lines.slice(Math.max(0, lines.length - policy.value));
      } else if (policy.mode === 'days') {
        if (!isPositiveNumber(policy.value)) return; // 값 없거나 양수 아니면 no-op
        const cutoffMs = Date.now() - policy.value * 24 * 60 * 60 * 1000;
        kept = lines.filter((l) => {
          try {
            const m = JSON.parse(l) as ChatMessage;
            if (!m || typeof m.ts !== 'string') return true; // ts 없음/파싱 불가 = 안전하게 보존
            const t = Date.parse(m.ts);
            if (Number.isNaN(t)) return true; // ts 파싱 실패 = 안전하게 보존(드롭 금지)
            return t >= cutoffMs;
          } catch {
            return true; // 손상 줄 = 안전하게 보존(드롭 금지)
          }
        });
      } else {
        return;
      }
      if (kept.length === lines.length) return; // 변경 없음 — 불필요한 쓰기 생략
      fs.mkdirSync(this.chatDir, { recursive: true });
      const tmp = `${p}.tmp-${randomUUID()}`;
      try {
        fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '');
        fs.renameSync(tmp, p); // 원자적 교체(임시파일 rename)
      } finally {
        // rename 실패(윈도우 AV/잠금 등) 시 tmp가 남아 매 프루닝마다 누적되는 것 방지(리뷰 지적).
        // 성공 시엔 rename으로 이미 사라졌으므로 unlink는 no-op(존재하면만 제거).
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 정리 실패는 무시 */ }
      }
    } catch (e) {
      console.warn(`[chat-store] 채널 '${id}' 프루닝 실패(무시하고 계속): ${String(e)}`);
    }
  }

  // 용량 타일용: chatDir 아래 전체 채팅 jsonl 총 바이트. 위키/RAG 폴더는 별개 경로라 무관.
  historyBytes(): number {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.chatDir, { withFileTypes: true });
    } catch {
      return 0; // 디렉터리 없음 = 0
    }
    let total = 0;
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      try {
        total += fs.statSync(path.join(this.chatDir, e.name)).size;
      } catch { /* 통계 실패한 개별 파일은 건너뜀 */ }
    }
    return total;
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
