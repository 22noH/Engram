# Phase 16c — 비공개 채널 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 초대된 사람(주인 + memberIds)만 보이고 들어갈 수 있는 비공개 채널을 도입한다. owner·`channels.manage` 권한자도 초대받지 않으면 볼 수 없다(감시 방지). 서버가 채널 목록·메시지를 소켓별로 필터한다.

**Architecture:** 채널에 `visibility`/`memberIds`를 더하고(주인 = 16b `creatorId` 재활용), `self.adapter`에 접근 판정 헬퍼(`canAccessChannel`·`canAdminChannel`)와 소켓별 필터 브로드캐스트(`broadcastChannels`·`broadcastToChannel`)를 만들어 `channels`/`msg`/`send`/`history`를 게이트한다. 멤버 관리는 주인 전용 프레임(`setChannelVisibility`·`setChannelMembers`)과 초대용 가벼운 `channelRoster`로. 클라는 자물쇠 표시 + 주인 전용 멤버 관리 패널.

**Tech Stack:** Node 내장만(신규 의존성 0). 백엔드 jest(`npx jest <파일>`), 렌더러 vitest(renderer 폴더에서 `npx vitest run <파일>`).

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-07-12-phase16c-private-channels-design.md`.
- **비공개 접근권** = `ch.creatorId === me.id || (ch.memberIds ?? []).includes(me.id)`. **owner·channels.manage 예외 없음**(감시 방지). 공개 채널(`visibility` 없음/`'public'`)은 전원 접근.
- **비공개 관리**(멤버·visibility·삭제·설정) = **주인(creatorId)만.** 공개 채널 관리는 16b 그대로(`can(me,'channels.manage') || creatorId===me.id`, owner 전권).
- **게이트는 `authDeps` 주입 서버 모드에서만.** `authDeps` 없으면(무인증 로컬·brain) 전부 접근/전체 목록 — 회귀 금지. 위반은 조용히 무시.
- **주인 = 16b `creatorId`.** 씨앗 `ownerId`는 안 쓴다(creatorId로 흡수). 생성자는 memberIds에 없어도 항상 접근.
- 두뇌 코어·16a 세션게이트/authorId/kickUser/admin 프레임·16b 권한 게이트 무변경(재사용만).
- UI 문구 **영어 기본 / ko 로케일 한국어**(`renderer/src/i18n.ts`의 `ko` 삼항).
- 커밋 메시지 `feat(phase16c): …` / `test(phase16c): …`. 공동 작업자(Co-Authored-By) 넣지 않는다.
- 각 태스크 완료 시 회귀 확인: 백엔드 `npm test`, 렌더러 `renderer`에서 `npx vitest run`.

---

### Task 1: ChatStore `visibility`/`memberIds` + createChannel·setVisibility·setMembers

**Files:**
- Modify: `src/edge/messenger/chat-store.ts`
- Test: `src/edge/messenger/chat-store.spec.ts` (describe 추가)

**Interfaces:**
- Consumes: 없음.
- Produces:
  ```ts
  // ChatChannel에 visibility?: 'public' | 'private'; memberIds?: string[]
  createChannel(name: string, mode?: 'chat' | 'code' | 'team', creatorId?: string, visibility?: 'public' | 'private'): ChatChannel | null;
  setVisibility(id: string, visibility: 'public' | 'private'): boolean; // 없는 id → false
  setMembers(id: string, memberIds: string[]): boolean;                 // 없는 id → false, 통째 교체
  ```

- [ ] **Step 1: 실패하는 테스트 추가**

`chat-store.spec.ts` 하단에 추가:

```ts
describe('ChatStore 비공개 채널 (Phase 16c)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chpv-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('createChannel visibility=private 기록', () => {
    const s = new ChatStore(dir);
    const ch = s.createChannel('secret', 'chat', 'u1', 'private');
    expect(ch?.visibility).toBe('private');
    expect(s.listChannels().find((c) => c.id === ch!.id)?.visibility).toBe('private');
  });

  it('visibility 미전달·public이면 미기록(기존 동작)', () => {
    const s = new ChatStore(dir);
    expect(s.createChannel('a', 'chat', 'u1')?.visibility).toBeUndefined();
    expect(s.createChannel('b', 'chat', 'u1', 'public')?.visibility).toBeUndefined();
  });

  it('setVisibility·setMembers 영속, 없는 id는 false', () => {
    const s = new ChatStore(dir);
    const ch = s.createChannel('secret', 'chat', 'u1', 'private')!;
    expect(s.setMembers(ch.id, ['u2', 'u3'])).toBe(true);
    expect(s.setVisibility(ch.id, 'public')).toBe(true);
    const re = new ChatStore(dir).listChannels().find((c) => c.id === ch.id)!;
    expect(re.memberIds).toEqual(['u2', 'u3']);
    expect(re.visibility).toBe('public');
    expect(s.setMembers('없음', ['x'])).toBe(false);
    expect(s.setVisibility('없음', 'private')).toBe(false);
  });
});
```

(파일 상단 `fs`/`os`/`path`/`ChatStore` import는 기존 spec에 이미 있으면 재사용.)

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/chat-store.spec.ts`
Expected: FAIL — setVisibility/setMembers 미존재·visibility 무시

- [ ] **Step 3: 구현**

`chat-store.ts`:

```ts
// ChatChannel 인터페이스에 필드 추가(creatorId 근처):
export interface ChatChannel {
  id: string;
  name: string;
  respondMode: 'all' | 'mention';
  mode?: 'chat' | 'code' | 'team';
  repoPath?: string;
  creatorId?: string;                  // Phase 16b: 만든 사람 = 비공개 채널 주인
  visibility?: 'public' | 'private';   // Phase 16c: 비공개 = 초대된 사람만
  memberIds?: string[];                // Phase 16c: 비공개 채널 입장 허용 계정 id
  ownerId?: string;                    // (구 9b 씨앗 — 미사용, creatorId로 흡수)
}

// createChannel: visibility 인자 추가(private일 때만 기록):
createChannel(name: string, mode: 'chat' | 'code' | 'team' = 'chat', creatorId?: string, visibility?: 'public' | 'private'): ChatChannel | null {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return null;
  const list = this.listChannels();
  const m = mode === 'code' ? 'code' : mode === 'team' ? 'team' : 'chat';
  const ch: ChatChannel = {
    id: randomUUID(), name: trimmed, respondMode: m === 'team' ? 'mention' : 'all', mode: m,
    ...(creatorId ? { creatorId } : {}),
    ...(visibility === 'private' ? { visibility: 'private' } : {}),
  };
  list.push(ch);
  this.save(list);
  return ch;
}

// 메서드 추가(setRepoPath 근처):
setVisibility(id: string, visibility: 'public' | 'private'): boolean {
  const list = this.listChannels();
  const ch = list.find((c) => c.id === id);
  if (!ch) return false;
  if (visibility === 'private') ch.visibility = 'private';
  else delete ch.visibility; // public이면 필드 제거(기본값)
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
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/messenger/chat-store.spec.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/edge/messenger/chat-store.ts src/edge/messenger/chat-store.spec.ts
git commit -m "feat(phase16c): ChatChannel visibility/memberIds + createChannel visibility·setVisibility·setMembers"
```

---

### Task 2: adapter 채널 목록 소켓별 필터 (canAccessChannel + broadcastChannels)

**Files:**
- Modify: `shared/protocol.ts` (Channel.visibility/memberIds, createChannel visibility)
- Modify: `src/edge/messenger/self.adapter.ts`
- Test: `src/edge/messenger/self.adapter.spec.ts` (describe 추가)

**Interfaces:**
- Consumes: `ChatChannel`·`createChannel(...,visibility)`(T1).
- Produces:
  ```ts
  // protocol: Channel에 visibility?: 'public'|'private'; memberIds?: string[]. createChannel 프레임에 visibility?
  // self.adapter private:
  //   canAccessChannel(ws, ch): boolean  — authDeps 없으면 true; public true; private면 creatorId===me.id || memberIds.includes(me.id)
  //   broadcastChannels(): void          — 각 인증 소켓에 그 소켓이 접근 가능한 채널만 담아 전송
  ```

- [ ] **Step 1: 실패하는 테스트 추가**

`self.adapter.spec.ts`에 describe 추가(기존 `makeAuthDeps` + 서버 기동 + owner/member 세션 관례 재사용):

```ts
describe('비공개 채널 목록 필터(Phase 16c)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('비멤버는 channels에서 비공개 채널을 못 봄, 주인/멤버는 봄', async () => {
    // makeAuthDeps(dir): owner + memberA + memberB 계정(active) + 세션.
    // 서버 store에 비공개 채널 미리 생성: store.createChannel('secret','chat', memberA.id, 'private')
    //   (memberA=주인). setMembers(id, [memberB.id]).
    // memberA(주인) 소켓 auth → {t:'channels'} → 응답 list에 secret 포함.
    // memberB(멤버) 소켓 → secret 포함.
    // owner 소켓(멤버 아님) → secret 미포함(감시 방지).
    // 별도 memberC(비멤버) → secret 미포함.
  });

  it('공개 채널은 전원이 봄(회귀)', async () => {
    // 공개 채널 하나 → 모든 인증 소켓의 channels에 포함.
  });

  it('무인증 모드는 비공개 채널도 전부 보임(회귀)', async () => {
    // authDeps 미주입 서버 + 비공개 채널 → 아무 소켓이나 channels에 포함.
  });

  it('createChannel visibility=private로 만들면 주인만 보임', async () => {
    // member 소켓이 {t:'createChannel', name:'p', visibility:'private'} → 그 소켓엔 보이고, 다른 member 소켓엔 안 보임(브로드캐스트 필터).
  });
});
```

(주석 골격은 기존 spec의 ws 연결·인증·프레임 수집 관례로 완성.)

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: FAIL — 필터 없음(전원이 비공개 봄)

- [ ] **Step 3: 구현**

`shared/protocol.ts`:

```ts
export interface Channel {
  id: string;
  name: string;
  respondMode: 'all' | 'mention';
  mode?: 'chat' | 'code' | 'team';
  repoPath?: string;
  creatorId?: string;                  // 16b
  visibility?: 'public' | 'private';   // 16c
  memberIds?: string[];                // 16c
}

// createChannel 프레임에 visibility 추가:
//   | { t: 'createChannel'; name: string; mode?: 'chat' | 'code' | 'team'; visibility?: 'public' | 'private' }
```

`self.adapter.ts`:

```ts
// import: ChatChannel은 T4/T5에서 이미 import돼 있을 수 있음. 없으면 추가.
import type { ChatChannel } from './chat-store';

// 헬퍼 추가(canManageChannel 근처):
private canAccessChannel(ws: WebSocket, ch: ChatChannel): boolean {
  if (!this.authDeps) return true;                       // 무인증: 전부 접근
  if ((ch.visibility ?? 'public') !== 'private') return true;
  const me = this.users.get(ws);
  if (!me) return false;
  return ch.creatorId === me.id || (ch.memberIds ?? []).includes(me.id);
}

// 소켓별 필터 채널 목록 브로드캐스트:
private broadcastChannels(): void {
  const all = this.store.listChannels();
  for (const c of this.wss?.clients ?? []) {
    if (c.readyState !== WebSocket.OPEN || !this.authed.has(c)) continue;
    const list = this.authDeps ? all.filter((ch) => this.canAccessChannel(c, ch)) : all;
    try { c.send(JSON.stringify({ t: 'channels', list })); } catch { /* 격리 */ }
  }
}

// 'channels' 요청 응답을 필터:
case 'channels': {
  const all = this.store.listChannels();
  const list = this.authDeps ? all.filter((ch) => this.canAccessChannel(ws, ch)) : all;
  this.sendTo(ws, { t: 'channels', list });
  return;
}

// createChannel: visibility 전달 + broadcastChannels로 교체
case 'createChannel': {
  if (this.cfg.role === 'brain' && f.mode === 'team') return;
  const me = this.users.get(ws);
  if (typeof f.name === 'string') {
    this.store.createChannel(
      f.name,
      f.mode === 'code' ? 'code' : f.mode === 'team' ? 'team' : 'chat',
      me?.id,
      f.visibility === 'private' ? 'private' : undefined,
    );
  }
  this.broadcastChannels();
  return;
}

// setRepoPath / deleteChannel / setRespondMode: 말미의
//   this.broadcast({ t: 'channels', list: this.store.listChannels() });
// 를 전부
//   this.broadcastChannels();
// 로 교체(게이트 로직은 16b 그대로 유지).
```

주석 블록을 실제 코드로 반영한다. 기존 `broadcast({t:'channels',...})` 호출 4곳(createChannel·setRepoPath·deleteChannel·setRespondMode)을 `broadcastChannels()`로 교체.

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts && npm test`
Expected: 신규 PASS + 전체 회귀 통과

- [ ] **Step 5: 커밋**

```bash
git add shared/protocol.ts src/edge/messenger/self.adapter.ts src/edge/messenger/self.adapter.spec.ts
git commit -m "feat(phase16c): 채널 목록 소켓별 필터(canAccessChannel·broadcastChannels) + createChannel visibility"
```

---

### Task 3: adapter 메시지 접근 방어 (send/history + msg 브로드캐스트 필터)

**Files:**
- Modify: `src/edge/messenger/self.adapter.ts`
- Test: `src/edge/messenger/self.adapter.spec.ts` (describe 추가)

**Interfaces:**
- Consumes: `canAccessChannel`(T2).
- Produces:
  ```ts
  // self.adapter private:
  //   broadcastToChannel(channelId, frame): void — 그 채널 접근자에게만(공개면 전원). onSend/reply/postToChannel의 msg 브로드캐스트 대체.
  ```

- [ ] **Step 1: 실패하는 테스트 추가**

```ts
describe('비공개 채널 메시지 접근(Phase 16c)', () => {
  it('비멤버 send는 무시(메시지 미기록·브로드캐스트 없음)', async () => {
    // 비공개 채널(주인=memberA, 멤버=[]) + 비멤버 memberC 인증 → {t:'send', channelId, text} → store.history 빈 채로 유지.
  });
  it('비멤버 history는 빈 목록', async () => {
    // 비멤버 memberC → {t:'history', channelId(private)} → 응답 {t:'history', messages:[]}.
  });
  it('비공개 채널 msg는 접근자에게만 브로드캐스트', async () => {
    // 주인 memberA + 멤버 memberB 인증, 비멤버 owner 인증. memberA가 send →
    // memberA·memberB 소켓은 {t:'msg'} 수신, owner 소켓은 그 msg 미수신.
  });
  it('공개 채널 msg는 전원(회귀)', async () => {});
  it('무인증 모드는 send/history 정상(회귀)', async () => {});
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: FAIL

- [ ] **Step 3: 구현**

```ts
// 헬퍼 추가(broadcast 근처):
private broadcastToChannel(channelId: string, frame: ServerFrame): void {
  const ch = this.store.listChannels().find((c) => c.id === channelId);
  const data = JSON.stringify(frame);
  for (const c of this.wss?.clients ?? []) {
    if (c.readyState !== WebSocket.OPEN || !this.authed.has(c)) continue;
    if (ch && !this.canAccessChannel(c, ch)) continue; // 비공개는 접근자에게만(공개면 canAccess=true)
    try { c.send(data); } catch { /* 격리 */ }
  }
}

// onSend: 채널 찾은 뒤 접근 방어 추가(append 전), msg 브로드캐스트 교체.
private async onSend(ws: WebSocket, f: Record<string, unknown>): Promise<void> {
  const text = typeof f.text === 'string' ? f.text : '';
  const channelId = typeof f.channelId === 'string' ? f.channelId : '';
  if (!text.trim() || !channelId) return;
  const ch = this.store.listChannels().find((c) => c.id === channelId);
  if (!ch) { this.sendTo(ws, { t: 'error', text: 'unknown channel' }); return; }
  if (!this.canAccessChannel(ws, ch)) return; // 비공개 비접근 → 무시
  const me = this.users.get(ws);
  const msg = this.store.appendMessage(channelId, {
    authorId: me ? me.id : 'owner',
    ...(me ? { authorName: me.displayName } : {}),
    text,
    threadId: typeof f.threadId === 'string' && f.threadId ? f.threadId : undefined,
  });
  if (!msg) return;
  this.broadcastToChannel(channelId, { t: 'msg', channelId, message: msg });
  // ...이하 mention/handler 로직 그대로...
}

// history case: 접근 방어
case 'history': {
  const channelId = typeof f.channelId === 'string' ? f.channelId : '';
  const before = typeof f.before === 'string' ? f.before : undefined;
  const ch = this.store.listChannels().find((c) => c.id === channelId);
  if (ch && !this.canAccessChannel(ws, ch)) { this.sendTo(ws, { t: 'history', channelId, messages: [] }); return; }
  this.sendTo(ws, { t: 'history', channelId, messages: this.store.history(channelId, { before }) });
  return;
}

// reply / postToChannel: this.broadcast({ t: 'msg', channelId, message: msg }) →
//   this.broadcastToChannel(channelId(또는 t.channelId), { t: 'msg', channelId, message: msg })
```

주석 블록을 실제 코드로 반영. `reply`(target.channelId)와 `postToChannel`(channelId)의 msg 브로드캐스트도 `broadcastToChannel`로 교체(Engram 답도 비공개 채널이면 접근자에게만).

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts && npm test`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/edge/messenger/self.adapter.ts src/edge/messenger/self.adapter.spec.ts
git commit -m "feat(phase16c): 메시지 접근 방어 — send/history 게이트 + msg 브로드캐스트 소켓별 필터"
```

---

### Task 4: adapter 멤버 관리 프레임 + roster (canAdminChannel)

**Files:**
- Modify: `shared/protocol.ts` (프레임 + RosterEntry + roster ServerFrame)
- Modify: `src/edge/messenger/self.adapter.ts`
- Test: `src/edge/messenger/self.adapter.spec.ts` (describe 추가)

**Interfaces:**
- Consumes: `canManageChannel`(16b), `canAccessChannel`(T2), `setVisibility`/`setMembers`(T1), `broadcastChannels`(T2).
- Produces:
  ```ts
  // protocol:
  //   ClientFrame += | { t:'setChannelVisibility'; id: string; visibility: 'public'|'private' }
  //                 | { t:'setChannelMembers'; id: string; memberIds: string[] }
  //                 | { t:'channelRoster' }
  //   ServerFrame += | { t:'roster'; list: RosterEntry[] }
  //   export interface RosterEntry { id: string; displayName: string }
  // self.adapter private:
  //   canAdminChannel(ws, ch): boolean — 비공개면 주인(creatorId===me.id)만; 공개면 canManageChannel(16b)
  ```

- [ ] **Step 1: 실패하는 테스트 추가**

```ts
describe('비공개 채널 멤버 관리(Phase 16c)', () => {
  it('주인은 setChannelMembers로 멤버 추가 → 추가된 멤버가 채널을 보게 됨', async () => {
    // 주인 memberA 인증. 비공개 채널 생성(주인=A). memberB는 처음엔 secret 못 봄.
    // A가 {t:'setChannelMembers', id, memberIds:[B.id]} → 이후 B의 {t:'channels'}에 secret 포함.
  });
  it('비주인(멤버·channels.manage·owner)의 setChannelMembers/setChannelVisibility는 비공개 채널에 무시', async () => {
    // memberB(멤버지만 비주인) + owner + channels.manage 보유자 각각 시도 → memberIds/visibility 불변.
  });
  it('공개 채널 setChannelVisibility는 16b 관리자(creator/channels.manage/owner)가 가능', async () => {
    // 공개 채널을 channels.manage 보유자가 private로 전환 성공.
  });
  it('setChannelMembers는 존재하는 active 계정만 수용', async () => {
    // 없는 id 섞어 보내면 저장된 memberIds엔 유효 id만.
  });
  it('channelRoster는 id+displayName만(민감정보 없음), 인증 사용자면 반환', async () => {
    // 아무 인증 member → {t:'channelRoster'} → {t:'roster', list} 각 항목 keys=[id,displayName]만.
  });
  it('무인증 모드 channelRoster는 빈 목록', async () => {});
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: FAIL

- [ ] **Step 3: 구현**

`shared/protocol.ts`:

```ts
export interface RosterEntry { id: string; displayName: string }

// ClientFrame 유니언에 추가:
//   | { t: 'setChannelVisibility'; id: string; visibility: 'public' | 'private' }
//   | { t: 'setChannelMembers'; id: string; memberIds: string[] }
//   | { t: 'channelRoster' }
// ServerFrame 유니언에 추가:
//   | { t: 'roster'; list: RosterEntry[] }
```

`self.adapter.ts`:

```ts
// 헬퍼 추가:
private canAdminChannel(ws: WebSocket, ch: ChatChannel | undefined): boolean {
  if (!this.authDeps) return true;
  if (!ch) return false;
  if ((ch.visibility ?? 'public') === 'private') {
    const me = this.users.get(ws);
    return !!me && ch.creatorId === me.id;      // 비공개: 주인만
  }
  return this.canManageChannel(ws, ch);         // 공개: 16b 규칙
}

// handleFrame switch에 case 추가:
case 'setChannelVisibility': {
  if (typeof f.id === 'string' && (f.visibility === 'public' || f.visibility === 'private')) {
    const ch = this.store.listChannels().find((c) => c.id === f.id);
    if (this.canAdminChannel(ws, ch)) this.store.setVisibility(f.id, f.visibility);
  }
  this.broadcastChannels();
  return;
}
case 'setChannelMembers': {
  if (typeof f.id === 'string' && Array.isArray(f.memberIds)) {
    const ch = this.store.listChannels().find((c) => c.id === f.id);
    if (this.canAdminChannel(ws, ch)) {
      const valid = this.authDeps
        ? (f.memberIds as unknown[]).filter((x): x is string => typeof x === 'string' && !!this.authDeps!.accounts.get(x))
        : [];
      this.store.setMembers(f.id, valid);
    }
  }
  this.broadcastChannels();
  return;
}
case 'channelRoster': {
  const list = this.authDeps
    ? this.authDeps.accounts.list().filter((a) => a.status === 'active').map((a) => ({ id: a.id, displayName: a.displayName }))
    : [];
  this.sendTo(ws, { t: 'roster', list });
  return;
}
```

주석 블록을 실제 코드로 반영. `RosterEntry`가 `ServerFrame`에서 참조되므로 protocol에 먼저 정의.

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts && npm test && npm run build`
Expected: PASS·클린

- [ ] **Step 5: 커밋**

```bash
git add shared/protocol.ts src/edge/messenger/self.adapter.ts src/edge/messenger/self.adapter.spec.ts
git commit -m "feat(phase16c): 멤버 관리 프레임(setChannelVisibility·setChannelMembers 주인전용) + channelRoster"
```

---

### Task 5: renderer 자물쇠 표시 + 비공개 채널 생성 옵션

**Files:**
- Modify: `renderer/src/components/Channels.tsx` (+test)
- Modify: `renderer/src/App.tsx`

**Interfaces:**
- Consumes: `Channel.visibility`(T2), `createChannel` visibility 프레임(T2).
- Produces: `Channels`의 `onCreate` 시그니처에 `visibility?` 추가; 비공개 채널 행에 자물쇠 표시.

- [ ] **Step 1: 실패하는 테스트 추가**

`Channels.test.tsx`에 추가:

```tsx
it('visibility=private 채널은 자물쇠 마커 표시', () => {
  const channels = [{ id: 'secret', name: 'secret', respondMode: 'all' as const, mode: 'chat' as const, visibility: 'private' as const }];
  render(<Channels channels={channels} current="secret" mode="chat" canManageChannels={false} myId="me"
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} />);
  expect(screen.getByTitle(/private|비공개/i)).toBeTruthy();
});

it('공개 채널은 자물쇠 없음', () => {
  const channels = [{ id: 'general', name: 'general', respondMode: 'all' as const, mode: 'chat' as const }];
  render(<Channels channels={channels} current="general" mode="chat" canManageChannels={false} myId="me"
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} />);
  expect(screen.queryByTitle(/private|비공개/i)).toBeNull();
});
```

- [ ] **Step 2: 실패 확인**

Run(renderer): `npx vitest run src/components/Channels.test.tsx`
Expected: FAIL — 자물쇠 없음

- [ ] **Step 3: 구현**

`i18n.ts` 추가:

```ts
channelPrivate: ko ? '비공개' : 'Private',
newChannelPrivate: ko ? '비공개 채널' : 'Private channel',
```

`Channels.tsx`: 채널 행에 자물쇠 마커(private일 때). `onCreate`에 visibility 추가, 새 채널 입력부에 "비공개" 체크박스:

```tsx
// props onCreate 시그니처:
onCreate: (name: string, mode: 'chat' | 'code' | 'team' | 'wiki' | 'admin', visibility?: 'public' | 'private') => void;

// 채널 행 렌더(# 이름 옆):
<div key={c.id} className={'ch' + (c.id === current ? ' sel' : '')} onClick={() => props.onSelect(c.id)}>
  <span>{'# ' + c.name}</span>
  {c.visibility === 'private' && <span className="lock" title={T.channelPrivate} aria-label={T.channelPrivate}>🔒</span>}
  {canManage(c) && <span className="menu" onClick={(e) => { e.stopPropagation(); openMenu(c.id, e.currentTarget); }}>⋯</span>}
</div>

// 새 채널 생성부(#newch)에 비공개 체크박스 상태 추가:
const [newPrivate, setNewPrivate] = useState(false);
// creating 입력 영역에:
<label className="privToggle"><input type="checkbox" checked={newPrivate} onChange={(e) => setNewPrivate(e.target.checked)} />{T.newChannelPrivate}</label>
// Enter로 생성 시:
if (e.key === 'Enter' && v.trim()) { props.onCreate(v, mode, newPrivate ? 'private' : undefined); setCreating(false); setNewPrivate(false); }
```

`App.tsx`: `onCreate`가 visibility를 실어 `createChannel` 전송:

```tsx
onCreate={(name, m, visibility) => { if (m !== 'wiki' && m !== 'admin') send(connState.defaultConnId, { t: 'createChannel', name, mode: m, ...(visibility ? { visibility } : {}) }); }}
```

- [ ] **Step 4: 통과 확인**

Run(renderer): `npx vitest run`
Expected: 전체 PASS (기존 Channels 테스트가 onCreate 시그니처 변경으로 깨지지 않음 — 3번째 인자는 옵셔널)

- [ ] **Step 5: 커밋**

```bash
git add renderer/src/components/Channels.tsx renderer/src/components/Channels.test.tsx renderer/src/App.tsx renderer/src/i18n.ts
git commit -m "feat(phase16c): 채널 자물쇠 표시 + 비공개 채널 생성 옵션"
```

---

### Task 6: renderer 멤버 관리 패널 + ⋯메뉴 주인 게이트 + roster 배선

**Files:**
- Create: `renderer/src/components/ChannelMembers.tsx` (+test)
- Modify: `renderer/src/components/Channels.tsx` (⋯메뉴에 "멤버 관리" + 비공개 채널 관리 게이트 주인전용)
- Modify: `renderer/src/App.tsx` (roster 상태·멤버 패널 배선), `renderer/src/i18n.ts`

**Interfaces:**
- Consumes: `RosterEntry`·`roster`/`channelRoster`·`setChannelMembers`·`setChannelVisibility`(T4), `Channel.memberIds/visibility/creatorId`.
- Produces:
  ```ts
  // ChannelMembers 컴포넌트: 로스터 체크박스로 멤버 토글, visibility 토글.
  export function ChannelMembers(props: {
    roster: RosterEntry[]; memberIds: string[]; creatorId?: string; visibility: 'public' | 'private';
    onSetMembers(memberIds: string[]): void;
    onSetVisibility(v: 'public' | 'private'): void;
    onClose(): void;
  }): JSX.Element;
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```tsx
// renderer/src/components/ChannelMembers.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChannelMembers } from './ChannelMembers';

const roster = [{ id: 'a', displayName: 'Alice' }, { id: 'b', displayName: 'Bob' }, { id: 'c', displayName: 'Cara' }];

describe('ChannelMembers', () => {
  it('현재 멤버는 체크됨, 토글 시 onSetMembers', () => {
    const onSetMembers = vi.fn();
    render(<ChannelMembers roster={roster} memberIds={['b']} creatorId="a" visibility="private"
      onSetMembers={onSetMembers} onSetVisibility={() => {}} onClose={() => {}} />);
    const cara = screen.getByLabelText('Cara') as HTMLInputElement;
    expect(cara.checked).toBe(false);
    fireEvent.click(cara);
    expect(onSetMembers).toHaveBeenCalledWith(expect.arrayContaining(['b', 'c']));
  });

  it('주인(creatorId) 행은 체크·비활성(항상 멤버)', () => {
    render(<ChannelMembers roster={roster} memberIds={[]} creatorId="a" visibility="private"
      onSetMembers={() => {}} onSetVisibility={() => {}} onClose={() => {}} />);
    const alice = screen.getByLabelText('Alice') as HTMLInputElement;
    expect(alice.checked).toBe(true);
    expect(alice.disabled).toBe(true);
  });

  it('공개↔비공개 토글 시 onSetVisibility', () => {
    const onSetVisibility = vi.fn();
    render(<ChannelMembers roster={roster} memberIds={[]} creatorId="a" visibility="public"
      onSetMembers={() => {}} onSetVisibility={onSetVisibility} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /make private|비공개로/i }));
    expect(onSetVisibility).toHaveBeenCalledWith('private');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run(renderer): `npx vitest run src/components/ChannelMembers.test.tsx`
Expected: FAIL — 컴포넌트 없음

- [ ] **Step 3: 구현**

`i18n.ts` 추가:

```ts
manageMembers: ko ? '멤버 관리' : 'Manage members',
makePrivate: ko ? '비공개로 전환' : 'Make private',
makePublic: ko ? '공개로 전환' : 'Make public',
membersClose: ko ? '닫기' : 'Close',
```

```tsx
// renderer/src/components/ChannelMembers.tsx
import type { RosterEntry } from '../../../shared/protocol';
import { T } from '../i18n';

// 비공개 채널 멤버 관리 패널(스펙 §3.3) — 주인에게만 App이 렌더. 순수 UI.
export function ChannelMembers(props: {
  roster: RosterEntry[]; memberIds: string[]; creatorId?: string; visibility: 'public' | 'private';
  onSetMembers: (memberIds: string[]) => void;
  onSetVisibility: (v: 'public' | 'private') => void;
  onClose: () => void;
}) {
  const isMember = (id: string) => id === props.creatorId || props.memberIds.includes(id);
  const toggle = (id: string, on: boolean) => {
    const base = props.memberIds.filter((m) => m !== id && m !== props.creatorId);
    props.onSetMembers(on ? [...base, id] : base);
  };
  return (
    <div id="membersOverlay" onClick={props.onClose}>
      <div id="membersPanel" onClick={(e) => e.stopPropagation()}>
        <div className="visRow">
          <span className={'visBadge ' + props.visibility}>{props.visibility === 'private' ? T.channelPrivate : ''}</span>
          {props.visibility === 'private'
            ? <button type="button" onClick={() => props.onSetVisibility('public')}>{T.makePublic}</button>
            : <button type="button" onClick={() => props.onSetVisibility('private')}>{T.makePrivate}</button>}
        </div>
        <div className="rosterList">
          {props.roster.map((r) => (
            <label key={r.id}>
              <input type="checkbox" aria-label={r.displayName}
                checked={isMember(r.id)}
                disabled={r.id === props.creatorId}
                onChange={(e) => toggle(r.id, e.target.checked)} />
              {r.displayName}{r.id === props.creatorId ? ' (owner)' : ''}
            </label>
          ))}
        </div>
        <button type="button" id="membersCloseBtn" onClick={props.onClose}>{T.membersClose}</button>
      </div>
    </div>
  );
}
```

`Channels.tsx`: ⋯메뉴 게이트를 비공개는 주인전용으로 정교화 + "멤버 관리" 항목. props에 `onManageMembers(id)` 추가:

```tsx
// canManage를 비공개 정교화(서버 canAdminChannel 미러):
const canManage = (c: Channel) => c.visibility === 'private'
  ? (!!props.myId && c.creatorId === props.myId)                 // 비공개: 주인만
  : (props.canManageChannels || (!!props.myId && c.creatorId === props.myId)); // 공개: 16b
// props에 추가: onManageMembers: (id: string) => void;
// 팝오버 메뉴에 항목 추가(삭제 위):
<div onClick={() => { setMenu(null); props.onManageMembers(c.id); }}>{T.manageMembers}</div>
```

`App.tsx`: roster 상태 + ChannelMembers 렌더 배선. 멤버 관리는 기본 연결의 실제 채널을 대상으로(defaultChan 패턴):

```tsx
import { ChannelMembers } from './components/ChannelMembers';
import type { RosterEntry } from '../../shared/protocol';

// state:
const [roster, setRoster] = useState<RosterEntry[]>([]);
const [membersFor, setMembersFor] = useState<string | null>(null); // 관리 중인 실제 채널 id(기본 연결)

// onFrame 기본연결 분기에 추가:
else if (f.t === 'roster') setRoster(f.list);

// Channels에 onManageMembers 전달(논리 채널 이름 → 기본 연결 실제 채널 찾기):
onManageMembers={(name) => {
  const ch = channelsByConn[connState.defaultConnId]?.find((c) => c.name === name && (c.mode ?? 'chat') === mode);
  if (ch) { setMembersFor(ch.id); send(connState.defaultConnId, { t: 'channelRoster' }); }
}}
// (Channels ⋯메뉴는 논리 채널 id=name을 넘기므로 name으로 조회. 만약 Channels가 실제 id를 넘기면 그대로 사용.)

// 렌더(모달, showManage 근처):
{membersFor && (() => {
  const ch = channelsByConn[connState.defaultConnId]?.find((c) => c.id === membersFor);
  if (!ch) return null;
  return (
    <ChannelMembers
      roster={roster}
      memberIds={ch.memberIds ?? []}
      creatorId={ch.creatorId}
      visibility={ch.visibility ?? 'public'}
      onSetMembers={(memberIds) => send(connState.defaultConnId, { t: 'setChannelMembers', id: ch.id, memberIds })}
      onSetVisibility={(v) => send(connState.defaultConnId, { t: 'setChannelVisibility', id: ch.id, visibility: v })}
      onClose={() => setMembersFor(null)}
    />
  );
})()}
```

주의: 사이드바 `sidebarChannels`가 `visibility`/`memberIds`/`creatorId`를 실어야 자물쇠(T5)·⋯게이트가 동작한다. T5에서 creatorId는 이미 실림(16b). `visibility`도 실어준다:

```tsx
// sidebarChannels 합성에 visibility 추가(any = 기본 연결 매칭 채널):
return { id: name, name, respondMode: any?.respondMode ?? 'all', mode,
  ...(any?.creatorId ? { creatorId: any.creatorId } : {}),
  ...(any?.visibility ? { visibility: any.visibility } : {}) };
```

- [ ] **Step 4: 통과 확인**

Run(renderer): `npx vitest run && npx tsc --noEmit`, 그리고 백엔드 `npm test` + 양쪽 `npm run build` 클린.
Expected: 전부 PASS·클린

- [ ] **Step 5: 커밋**

```bash
git add renderer/src
git commit -m "feat(phase16c): 멤버 관리 패널 + ⋯메뉴 주인 게이트 + roster 배선"
```

---

## 수동 스모크(구현 밖 — 최종 검증용)

1. member A가 "비공개 채널" 생성 → A만 목록에 보임. owner·다른 member는 안 보임.
2. A가 ⋯메뉴 "멤버 관리"에서 B 초대 → B 목록에 그 채널 자물쇠와 함께 나타남, 입장·대화 가능.
3. B가 A를 내보낼 수 없음(멤버 관리 메뉴는 주인 A에게만).
4. owner가 비공개 채널을 목록에서 못 봄(감시 방지) — UI상.
5. 무인증 로컬 앱: 채널 전부 공개처럼 동작(회귀 없음).

## Self-Review 노트

- 스펙 §1(모델)=T1·T2, §2.1(접근 헬퍼)=T2·T4, §2.2(목록 필터)=T2, §2.3(메시지 방어)=T3, §2.4(멤버 프레임)=T4, §2.5(roster)=T4, §3.1(생성)=T5, §3.2(자물쇠)=T5, §3.3(멤버 UI)=T6, §3.4(무인증)=각 헬퍼의 `!authDeps` 단락, §4(브로드캐스트 변경)=T2·T3, §5(테스트)=각 태스크. 갭 없음.
- 타입 일관성: `visibility`/`memberIds`(T1 store→T2 protocol Channel→T5/T6 렌더), `canAccessChannel`(T2)→T3·T4 소비, `canAdminChannel`(T4)→case, `broadcastChannels`(T2)→T2·T4 case, `broadcastToChannel`(T3)→onSend/reply/postToChannel, `RosterEntry`(T4)→T6. 시그니처 일치.
- `creatorId` 재활용(16b)·`ownerId` 미사용은 §1대로. 비공개 관리=주인전용, 공개=16b 규칙.
- YAGNI: 위키 네임스페이스·DM 전용 UX·소유권 이전·초대 수락 절차·owner 감사모드는 스펙 §7대로 제외.
