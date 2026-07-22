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
  // Task 5(clear-compact 자동 compact): 프루닝이 버릴 구간이 있을 때, 동기 삭제 대신 이 훅으로 먼저
  // "요약→위키 게시"를 시도한다. 미주입이면 기존 pruneChannel 동기 삭제 그대로(회귀 0). main.ts에서
  // wiki 배선이 있을 때만 주입(setChannelBrainSource·setCompactService와 동일한 DI-밖 setter 결).
  // 반환 true=요약 성공(호출부가 removeMessagesByIds로 정밀 제거)·false=실패(아무것도 지우지 않음).
  private autoCompactHook?: (channelId: string, dropped: ChatMessage[]) => Promise<boolean>;
  // 채널별 자동 compact 디바운스: 한 채널에 대해 훅이 진행 중이면 새 프루닝 라운드는 건너뛴다(과다 AI
  // 호출 방지). 다음 append가 다시 pruneChannel을 호출하므로 건너뛴 라운드는 자연히 재시도된다.
  private readonly autoCompactInFlight: Set<string> = new Set();
  // 자동 compact "켜짐" 여부(런타임 토글 가능 — 최종 리뷰 지적). 훅 주입과 분리한 이유: 훅은 부팅 1회
  // 설치(wiki 배선)지만, 콘솔에서 retention은 즉시 적용되는데 autoCompact가 재시작까지 미반영이면,
  // autoCompact를 켬과 동시에 retention을 조인 저장이 "요약 없이 raw 삭제"로 새는 비대칭이 생긴다.
  // enabled를 런타임 세터로 두면 admin이 retention(setRetention)과 함께 즉시 적용해 둘이 항상 같이 뒤집힌다.
  // enabled=false면 pruneChannel은 훅을 호출조차 안 하고 동기 raw 삭제(S4)로 떨어진다(스펙 ⑤).
  private autoCompactEnabled = false;

  setAutoCompactEnabled(enabled: boolean): void {
    this.autoCompactEnabled = enabled;
  }

  // opts.readOnly: 부팅 시 잔여 .cleared 정리(cleanupStaleClearBackups)를 건너뛴다 — 별도 프로세스가
  // "읽기 전용"으로 잠깐 열 때(예: engram-server status CLI)를 위한 것. 그 정리는 파일을 지우는 유일한
  // 부작용이라, 실행 중 서버와 데이터 폴더를 공유하는 CLI가 이걸 돌리면 서버의 /clear 되돌리기 백업을
  // 지워버린다(리뷰 지적: 읽기 전용 명령의 데이터 손실). 서버 본체는 부팅 1회 생성이라 기본 동작(정리) 유지.
  // listChannels()도 같은 이유로 readOnly면 채널이 하나도 없을 때 기본 general 채널을 파일로
  // 저장하지 않는다(리뷰 지적: status가 빈 데이터 폴더에 channels.json을 만들어버림 — 읽기 전용
  // 명령은 어떤 파일도 생성/수정하면 안 된다). 값만 메모리에서 만들어 돌려준다.
  private readonly readOnly: boolean;

  constructor(private readonly chatDir: string, retention?: RetentionPolicy, opts?: { readOnly?: boolean }) {
    this.readOnly = !!opts?.readOnly;
    if (retention) this.setRetention(retention);
    if (!this.readOnly) this.cleanupStaleClearBackups();
  }

  // main.ts에서 wiki 배선이 있을 때만 호출(구조적 타입, DI 순환 회피 — setChannelBrainSource와 동일 결).
  setAutoCompactHook(fn: (channelId: string, dropped: ChatMessage[]) => Promise<boolean>): void {
    this.autoCompactHook = fn;
  }

  // Task 1(clear/compact): 이전 세션에서 실행취소 창이 만료되지 않은 채 남은 `.cleared`
  // 백업(토스트 미확정분)을 부팅 시 정리. never-throw(chatDir 없음=정리할 것 없음).
  private cleanupStaleClearBackups(): void {
    try {
      const entries = fs.readdirSync(this.chatDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.cleared')) continue;
        try { fs.unlinkSync(path.join(this.chatDir, e.name)); } catch { /* 개별 실패는 무시하고 계속 */ }
      }
    } catch { /* chatDir 없음/읽기 실패 = 정리할 것 없음 */ }
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
  private clearedPath(channelId: string): string {
    return `${this.messagesPath(channelId)}.cleared`;
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
      if (!this.readOnly) this.save(list);
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

      // Task 5(clear-compact): 자동 compact가 켜져 있고(enabled) 훅이 있으면 동기 삭제 대신 "요약 성공 후에만
      // 제거"로 우회한다. enabled=false면 이 분기를 타지 않고 아래 동기 raw 삭제(S4)로 떨어진다(최종 리뷰:
      // 훅 설치 여부만으로 판정하면 콘솔에서 autoCompact를 켠 즉시엔 반영 안 돼 raw 삭제로 새던 것 방지).
      // ★안전 불변식: 메시지는 그 내용이 위키에 성공적으로 요약·게시된 뒤에만 jsonl에서 사라진다.
      if (this.autoCompactHook && this.autoCompactEnabled) {
        // kept는 lines의 부분수열(count=suffix slice·days=순서보존 filter) — 두 포인터로 그 여집합(dropped)을
        // 정확히 복원한다(Set 기반 비교는 완전히 동일한 줄이 중복될 때 모호할 수 있어 피한다).
        const droppedLines: string[] = [];
        let ki = 0;
        for (const l of lines) {
          if (ki < kept.length && kept[ki] === l) { ki++; continue; }
          droppedLines.push(l);
        }
        const dropped: ChatMessage[] = [];
        for (const l of droppedLines) {
          try {
            const m = JSON.parse(l) as ChatMessage;
            if (m && typeof m.id === 'string' && typeof m.text === 'string') dropped.push(m);
          } catch { /* 손상 줄 skip — 어차피 요약할 내용이 없으므로 다음 기회로 보류(안전 우선) */ }
        }
        this.runAutoCompact(id, dropped); // fire-and-forget·never-throw(내부에서 전부 삼킴)
        return; // 동기 프루닝 생략 — 훅이 성공하면 removeMessagesByIds가 나중에 정밀 제거
      }

      // 훅 미주입(기존 동작, 회귀 0) — 그대로 동기 프루닝.
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

  // Task 5(clear-compact): pruneChannel이 골라낸 dropped를 autoCompactHook으로 요약→위키 게시 시도.
  // 채널별 디바운스(이미 진행 중이면 이번 라운드는 건너뜀 — 다음 append가 재시도)·never-throw(fire-and-
  // forget으로 호출되므로 여기서 던지면 unhandled rejection이 된다 — 반드시 전부 삼킨다).
  private runAutoCompact(channelId: string, dropped: ChatMessage[]): void {
    if (dropped.length === 0) return; // 요약할 내용이 없음(예: 전부 손상 줄) — 다음 기회로 보류
    if (this.autoCompactInFlight.has(channelId)) return; // 디바운스: 진행 중이면 이번 라운드 skip
    this.autoCompactInFlight.add(channelId);
    void (async () => {
      try {
        const ok = await this.autoCompactHook!(channelId, dropped);
        if (ok) this.removeMessagesByIds(channelId, new Set(dropped.map((m) => m.id)));
        // ok=false(요약/위키 저장 실패) — 아무것도 지우지 않음. 다음 append의 pruneChannel이 같은
        // dropped(+새로 늘어난 구간)를 다시 시도한다(안전 우선 — 지식 유실보다 재시도가 낫다).
      } catch (e) {
        console.warn(`[chat-store] 채널 '${channelId}' 자동 compact 실패(무시, 다음 프루닝에서 재시도): ${String(e)}`);
      } finally {
        this.autoCompactInFlight.delete(channelId);
      }
    })();
  }

  // Task 5(clear-compact): 자동 compact 성공 후 "정확히 그 메시지들만" 제거. 마지막 N개/최근 M일 같은
  // 상대적 판정이 아니라 id 집합 매칭이라 — 훅이 요약을 만든 뒤 새로 도착한 메시지가 섞여 들어와도
  // (같은 채널에 append가 계속될 수 있음) 그 새 메시지는 ids에 없으므로 절대 지워지지 않는다.
  // never-throw·safeId 가드·pruneChannel과 동일한 원자적 tmp rename 관례.
  removeMessagesByIds(channelId: string, ids: Set<string>): void {
    try {
      if (!safeId(channelId)) return;
      if (ids.size === 0) return; // 지울 것 없음
      const p = this.messagesPath(channelId);
      let raw: string;
      try {
        raw = fs.readFileSync(p, 'utf8');
      } catch {
        return; // 파일 없음 = 지울 것 없음
      }
      const lines = raw.split('\n').filter(Boolean);
      const kept = lines.filter((l) => {
        try {
          const m = JSON.parse(l) as ChatMessage;
          if (!m || typeof m.id !== 'string') return true; // 파싱 불가/손상 = 안전하게 보존
          return !ids.has(m.id);
        } catch {
          return true; // 손상 줄 = 안전하게 보존(드롭 금지)
        }
      });
      if (kept.length === lines.length) return; // 변경 없음 — 불필요한 쓰기 생략
      fs.mkdirSync(this.chatDir, { recursive: true });
      const tmp = `${p}.tmp-${randomUUID()}`;
      try {
        fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '');
        fs.renameSync(tmp, p); // 원자적 교체(임시파일 rename)
      } finally {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 정리 실패는 무시 */ }
      }
    } catch (e) {
      console.warn(`[chat-store] 채널 '${channelId}' removeMessagesByIds 실패(무시하고 계속): ${String(e)}`);
    }
  }

  // Task 1(clear/compact): /clear = jsonl을 `.cleared`로 원자적 rename(삭제 아님 — 실행취소 가능).
  // 백업은 항상 최신 1개만 유지(이전 백업이 있으면 먼저 버림). 위키/RAG 폴더는 별개 경로라 무관.
  // never-throw: 실패해도 대화 자체는 그대로 남아있으므로 로그만 남기고 계속.
  clearChannel(id: string): void {
    try {
      if (!safeId(id)) return;
      const p = this.messagesPath(id);
      if (!fs.existsSync(p)) return; // 대화 없음 = no-op
      const backup = this.clearedPath(id);
      // 이전 백업이 남아있으면(실행취소 안 하고 또 clear) 먼저 지워 백업 1개만 유지.
      try { if (fs.existsSync(backup)) fs.unlinkSync(backup); } catch { /* 개별 실패 무시, rename에서 재시도 안 함 */ }
      fs.renameSync(p, backup); // 원자적 rename(같은 디렉터리 내 이동 — tmp 불필요)
    } catch (e) {
      console.warn(`[chat-store] 채널 '${id}' clear 실패(무시하고 계속): ${String(e)}`);
    }
  }

  // clearChannel의 되돌리기. 백업 없으면 false. 되돌리기 창 동안 새 메시지가 쌓여
  // 현재 jsonl이 이미 존재하면(다시 대화 시작됨) 덮어쓰지 않고 false — 데이터 유실 방지.
  undoClear(id: string): boolean {
    try {
      if (!safeId(id)) return false;
      const backup = this.clearedPath(id);
      if (!fs.existsSync(backup)) return false; // 백업 없음
      const p = this.messagesPath(id);
      if (fs.existsSync(p)) return false; // 그새 새 대화가 쌓임 — 덮어쓰기 금지
      fs.renameSync(backup, p); // 원자적 rename으로 복원
      return true;
    } catch (e) {
      console.warn(`[chat-store] 채널 '${id}' undoClear 실패(무시): ${String(e)}`);
      return false;
    }
  }

  // 실행취소 창 만료(또는 다음 clear 직전 정리)에 호출 — 백업만 지움, 대화 상태는 무관.
  dropClearBackup(id: string): void {
    try {
      if (!safeId(id)) return;
      const backup = this.clearedPath(id);
      if (fs.existsSync(backup)) fs.unlinkSync(backup);
    } catch (e) {
      console.warn(`[chat-store] 채널 '${id}' 백업 삭제 실패(무시): ${String(e)}`);
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
