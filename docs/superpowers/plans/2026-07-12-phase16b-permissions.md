# Phase 16b — 권한·역할(RBAC 코어) 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자별 세분 권한(`wiki.approve`·`channels.manage`)을 도입해 "로그인만 하면 누구나 위키 승인" 구멍을 닫고, 자기가 만든 채널은 소유자가 관리하되 남의 채널은 권한자만 관리하게 한다. owner는 전권 슈퍼유저.

**Architecture:** 백엔드에 순수 `can(account, perm)` 헬퍼 + `Account.permissions`/`Channel.creatorId` 필드를 더하고, `self.adapter`의 wiki·channel 프레임에 게이트를 끼운다(계정 켜진 서버 모드에서만; 위반은 조용히 무시). 클라는 `authOk`가 실어주는 자기 permissions로 버튼을 표시/숨김하고, owner 전용 AdminArea에 권한 체크박스를 단다. 이중 방어(서버 게이트=권위, 클라 숨김=UX).

**Tech Stack:** Node 내장만(신규 의존성 0). 백엔드 jest(`npx jest <파일>`), 렌더러 vitest(renderer 폴더에서 `npx vitest run <파일>`).

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-07-12-phase16b-permissions-design.md`.
- 16b 권한 키는 **정확히 두 개**: `wiki.approve`, `channels.manage`. 그 외 키는 저장 시 버린다.
- **owner는 항상 전권**(`can`이 role==='owner'에서 단락). **부여/회수는 owner 전용**(adminSetPermissions는 기존 owner-only ADMIN_FRAMES 게이트에 합류).
- **게이트는 `authDeps` 주입된 서버 모드에서만.** `authDeps` 없으면(무인증 로컬·brain) 현행대로 전부 통과 — 회귀 금지.
- **채널 생성 = 로그인한 누구나 자유**(게이트 없음, `creatorId=me.id` 기록). **자기 채널은 소유자가 관리**: 관리 게이트 = `can(me,'channels.manage') || ch.creatorId===me.id`. `creatorId` 없는 기존 채널은 `channels.manage` 보유자만.
- 위반 프레임은 **조용히 무시**(admin 프레임 관례). 클라는 애초에 버튼 미표시.
- 두뇌 코어·위키/제안 로직·16a 세션 게이트/authorId/kickUser 무변경(재사용만).
- `ChatChannel.ownerId`/`visibility`(16c 비공개 채널 씨앗)는 건드리지 않는다 — 16b는 별도 `creatorId`.
- UI 문구 **영어 기본 / ko 로케일 한국어**(`renderer/src/i18n.ts`의 `ko` 삼항).
- 커밋 메시지 `feat(phase16b): …` / `test(phase16b): …`. 공동 작업자(Co-Authored-By) 넣지 않는다.
- 각 태스크 완료 시 회귀 확인: 백엔드 `npm test`, 렌더러 `renderer`에서 `npx vitest run`.

---

### Task 1: 권한 헬퍼 `permissions.ts`

**Files:**
- Create: `src/edge/auth/permissions.ts`
- Test: `src/edge/auth/permissions.spec.ts`

**Interfaces:**
- Consumes: 없음.
- Produces:
  ```ts
  export const PERMISSIONS: readonly ['wiki.approve', 'channels.manage'];
  export type Permission = 'wiki.approve' | 'channels.manage';
  export function can(account: { role: string; permissions?: string[] } | undefined, perm: Permission): boolean;
  export function isPermission(v: unknown): v is Permission;
  export function sanitizePermissions(v: unknown): Permission[]; // 배열에서 유효 키만·중복 제거
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/edge/auth/permissions.spec.ts
import { can, isPermission, sanitizePermissions, PERMISSIONS } from './permissions';

describe('permissions', () => {
  it('키 목록은 정확히 두 개', () => {
    expect([...PERMISSIONS]).toEqual(['wiki.approve', 'channels.manage']);
  });

  it('can: owner는 권한 배열 무관 전권', () => {
    expect(can({ role: 'owner' }, 'wiki.approve')).toBe(true);
    expect(can({ role: 'owner', permissions: [] }, 'channels.manage')).toBe(true);
  });

  it('can: member는 보유 권한만 true', () => {
    expect(can({ role: 'member', permissions: ['wiki.approve'] }, 'wiki.approve')).toBe(true);
    expect(can({ role: 'member', permissions: ['wiki.approve'] }, 'channels.manage')).toBe(false);
    expect(can({ role: 'member' }, 'wiki.approve')).toBe(false); // permissions 없음
  });

  it('can: 계정 undefined면 false', () => {
    expect(can(undefined, 'wiki.approve')).toBe(false);
  });

  it('isPermission: 유효 키만 true', () => {
    expect(isPermission('wiki.approve')).toBe(true);
    expect(isPermission('channels.manage')).toBe(true);
    expect(isPermission('wiki.delete')).toBe(false);
    expect(isPermission(42)).toBe(false);
  });

  it('sanitizePermissions: 유효 키만·중복 제거·비배열은 빈 배열', () => {
    expect(sanitizePermissions(['wiki.approve', 'bogus', 'channels.manage', 'wiki.approve']))
      .toEqual(['wiki.approve', 'channels.manage']);
    expect(sanitizePermissions('nope')).toEqual([]);
    expect(sanitizePermissions(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/auth/permissions.spec.ts`
Expected: FAIL — `Cannot find module './permissions'`

- [ ] **Step 3: 최소 구현**

```ts
// src/edge/auth/permissions.ts
// 행위별 권한(Phase 16b 스펙 §2.1). owner는 전권(role 단락). 무인증 경로는 호출자가 게이트를
// 아예 건너뛰므로 이 함수는 "계정이 있을 때"의 판정만 담당한다.

export const PERMISSIONS = ['wiki.approve', 'channels.manage'] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function can(account: { role: string; permissions?: string[] } | undefined, perm: Permission): boolean {
  if (!account) return false;
  return account.role === 'owner' || (account.permissions ?? []).includes(perm);
}

export function isPermission(v: unknown): v is Permission {
  return typeof v === 'string' && (PERMISSIONS as readonly string[]).includes(v);
}

export function sanitizePermissions(v: unknown): Permission[] {
  if (!Array.isArray(v)) return [];
  const out: Permission[] = [];
  for (const x of v) if (isPermission(x) && !out.includes(x)) out.push(x);
  return out;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/auth/permissions.spec.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/edge/auth/permissions.ts src/edge/auth/permissions.spec.ts
git commit -m "feat(phase16b): 권한 헬퍼 can/isPermission/sanitizePermissions"
```

---

### Task 2: AccountStore `permissions` 필드 + `setPermissions`

**Files:**
- Modify: `src/edge/auth/account-store.ts`
- Test: `src/edge/auth/account-store.spec.ts` (describe 추가)

**Interfaces:**
- Consumes: `sanitizePermissions`, `Permission`(T1).
- Produces:
  ```ts
  // Account 인터페이스에 permissions?: string[] 추가
  // AccountStore에:
  setPermissions(id: string, permissions: Permission[]): boolean; // owner 대상 no-op(true 반환), 알 수 없는 키는 sanitize로 버림, 없는 id는 false
  ```

- [ ] **Step 1: 실패하는 테스트 추가**

`account-store.spec.ts` 하단에 추가:

```ts
describe('AccountStore.setPermissions (Phase 16b)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accp-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('member 권한 설정·재로드 영속·알 수 없는 키 필터', () => {
    const s = new AccountStore(dir);
    const a = s.createPassword('kim', 'pw', 'Kim', { status: 'active' });
    expect(s.setPermissions(a.id, ['wiki.approve', 'bogus' as any])).toBe(true);
    expect(new AccountStore(dir).get(a.id)?.permissions).toEqual(['wiki.approve']);
  });

  it('owner 대상은 no-op(권한 배열 미기록, true 반환)', () => {
    const s = new AccountStore(dir);
    const o = s.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
    expect(s.setPermissions(o.id, ['wiki.approve'])).toBe(true);
    expect(s.get(o.id)?.permissions).toBeUndefined(); // owner는 전권이라 배열 무의미
  });

  it('없는 id는 false', () => {
    expect(new AccountStore(dir).setPermissions('없음', ['wiki.approve'])).toBe(false);
  });
});
```

(파일 상단 import에 `fs`/`os`/`path`가 이미 있으면 재사용 — 기존 spec 관례를 따른다.)

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/auth/account-store.spec.ts`
Expected: FAIL — `setPermissions is not a function`

- [ ] **Step 3: 구현**

`account-store.ts` 변경:

```ts
// import 추가(맨 위 import 블록에)
import { sanitizePermissions, type Permission } from './permissions';

// Account 인터페이스에 필드 추가:
export interface Account {
  id: string; loginId: string; displayName: string;
  pass?: { salt: string; hash: string };
  oidc?: { issuer: string; sub: string; email?: string };
  role: AccountRole; status: AccountStatus; createdAt: string;
  permissions?: string[]; // Phase 16b — member의 세분 권한. owner는 전권이라 무시.
}

// 클래스에 메서드 추가(setPassword 근처):
setPermissions(id: string, permissions: Permission[]): boolean {
  const list = this.load();
  const a = list.find((x) => x.id === id);
  if (!a) return false;
  if (a.role === 'owner') return true; // owner는 전권 — 배열 미기록(혼동 방지)
  a.permissions = sanitizePermissions(permissions);
  this.save(list);
  return true;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/auth/account-store.spec.ts`
Expected: PASS (기존 + 3 신규)

- [ ] **Step 5: 커밋**

```bash
git add src/edge/auth/account-store.ts src/edge/auth/account-store.spec.ts
git commit -m "feat(phase16b): AccountStore permissions 필드 + setPermissions(owner no-op·키 sanitize)"
```

---

### Task 3: ChatStore `creatorId` + `createChannel` 시그니처

**Files:**
- Modify: `src/edge/messenger/chat-store.ts`
- Test: `src/edge/messenger/chat-store.spec.ts` (describe 추가)

**Interfaces:**
- Consumes: 없음.
- Produces:
  ```ts
  // ChatChannel에 creatorId?: string 추가
  createChannel(name: string, mode?: 'chat' | 'code' | 'team', creatorId?: string): ChatChannel | null; // creatorId 있으면 기록
  ```

- [ ] **Step 1: 실패하는 테스트 추가**

`chat-store.spec.ts` 하단에 추가:

```ts
describe('ChatStore.createChannel creatorId (Phase 16b)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chc-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('creatorId 전달 시 채널에 기록', () => {
    const s = new ChatStore(dir);
    const ch = s.createChannel('general', 'chat', 'user-1');
    expect(ch?.creatorId).toBe('user-1');
    expect(s.listChannels().find((c) => c.id === ch!.id)?.creatorId).toBe('user-1');
  });

  it('creatorId 없으면 미기록(기존 동작)', () => {
    const s = new ChatStore(dir);
    const ch = s.createChannel('general', 'chat');
    expect(ch?.creatorId).toBeUndefined();
  });
});
```

(파일 상단에 `fs`/`os`/`path` import·`ChatStore` import가 이미 있으면 재사용.)

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/chat-store.spec.ts`
Expected: FAIL — creatorId undefined(3번째 인자 무시됨)

- [ ] **Step 3: 구현**

`chat-store.ts` 변경:

```ts
// ChatChannel 인터페이스에 필드 추가(repoPath 근처):
export interface ChatChannel {
  id: string;
  name: string;
  respondMode: 'all' | 'mention';
  mode?: 'chat' | 'code' | 'team';
  repoPath?: string;
  creatorId?: string;                  // Phase 16b: 만든 사람 계정 id(소유권 예외 판정용)
  ownerId?: string;                    // 9b/16c: 비공개 채널 소유자(별개 — 건드리지 않음)
  visibility?: 'public' | 'private';   // 9b/16c
}

// createChannel 시그니처·구현:
createChannel(name: string, mode: 'chat' | 'code' | 'team' = 'chat', creatorId?: string): ChatChannel | null {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return null;
  const list = this.listChannels();
  const m = mode === 'code' ? 'code' : mode === 'team' ? 'team' : 'chat';
  const ch: ChatChannel = {
    id: randomUUID(), name: trimmed, respondMode: m === 'team' ? 'mention' : 'all', mode: m,
    ...(creatorId ? { creatorId } : {}),
  };
  list.push(ch);
  this.save(list);
  return ch;
}
```

(기존 `createChannel` 본문 중 respondMode·id 생성 로직은 그대로 유지하고 creatorId 스프레드만 추가.)

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/messenger/chat-store.spec.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/edge/messenger/chat-store.ts src/edge/messenger/chat-store.spec.ts
git commit -m "feat(phase16b): ChatChannel creatorId + createChannel 소유자 기록"
```

---

### Task 4: self.adapter 게이트 — wiki 승인 + 채널 관리 + createChannel creatorId + authOk permissions

**Files:**
- Modify: `shared/protocol.ts` (Channel.creatorId, UserDto.permissions)
- Modify: `src/edge/messenger/self.adapter.ts`
- Test: `src/edge/messenger/self.adapter.spec.ts` (describe 추가)

**Interfaces:**
- Consumes: `can`, `Permission`(T1); `Account.permissions`(T2); `createChannel(name,mode,creatorId)`(T3).
- Produces:
  ```ts
  // protocol: Channel에 creatorId?: string; UserDto에 permissions?: string[]
  // self.adapter 내부 게이트 헬퍼(private):
  //   allowed(ws, perm: Permission): boolean  — authDeps 없으면 true, 아니면 can(users.get(ws), perm)
  //   canManageChannel(ws, ch): boolean       — authDeps 없으면 true, 아니면 owner||channels.manage||ch.creatorId===me.id
  ```

- [ ] **Step 1: 실패하는 테스트 추가**

`self.adapter.spec.ts`에 describe 추가(기존 세션 헬퍼 `makeAuthDeps` + 서버 기동 관례 재사용):

```ts
describe('권한 게이트(Phase 16b)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('authOk가 자기 permissions를 실어 보냄', async () => {
    // makeAuthDeps(dir)로 deps 생성, member 계정 active + setPermissions(id, ['wiki.approve'])
    // 세션 발급 → ws auth → 수신한 {t:'authOk'} 의 user.permissions === ['wiki.approve']
  });

  it('wiki.approve 없는 member의 proposalApprove는 무시(제안 그대로 pending)', async () => {
    // wikiDeps(FakeProposalStore 등 기존 spec 픽스처) + authDeps 주입 서버.
    // 권한 없는 member 인증 후 {t:'proposalApprove', id} → applier.apply 호출 안 됨(제안 pending 유지).
  });

  it('wiki.approve 보유 member의 proposalApprove는 통과', async () => {
    // setPermissions(id, ['wiki.approve']) 후 approve → applier.apply 호출됨(wikiChanged 브로드캐스트).
  });

  it('내가 만든 채널은 channels.manage 없이도 삭제 가능', async () => {
    // member 인증 → createChannel → 그 채널 creatorId===me.id → deleteChannel 성공(목록에서 사라짐).
  });

  it('남이 만든 채널은 channels.manage 없으면 삭제 무시', async () => {
    // 채널을 다른 creatorId로 미리 생성(store.createChannel(name,'chat','other')) →
    // 권한 없는 member의 deleteChannel → 채널 그대로.
  });

  it('channels.manage 보유 member는 남 채널도 삭제 가능', async () => {
    // setPermissions(id, ['channels.manage']) → 남의 채널 deleteChannel 성공.
  });

  it('무인증 모드(authDeps 없음)는 전부 통과(회귀)', async () => {
    // authDeps 미주입 서버 → 아무 채널 deleteChannel·proposalApprove 다 동작(현행).
  });
});
```

(주석 골격은 기존 spec의 ws 연결·인증·수신 수집 관례로 완성. 위키 관련은 파일에 이미 있는 FakeProposal/Applier 픽스처를 재사용.)

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: FAIL — permissions 미전달·게이트 없음

- [ ] **Step 3: 구현**

`shared/protocol.ts`:

```ts
// Channel에 필드 추가
export interface Channel {
  id: string;
  name: string;
  respondMode: 'all' | 'mention';
  mode?: 'chat' | 'code' | 'team';
  repoPath?: string;
  creatorId?: string; // Phase 16b: 만든 사람(소유권 예외)
}

// UserDto에 permissions 추가(authOk가 클라에 전달)
export interface UserDto { id: string; displayName: string; role: 'owner' | 'member'; permissions?: string[] }
```

`self.adapter.ts`:

```ts
// import 추가
import { can, type Permission } from '../auth/permissions';
import type { ChatChannel } from './chat-store';

// 게이트 헬퍼(클래스 private 메서드로 추가):
private allowed(ws: WebSocket, perm: Permission): boolean {
  if (!this.authDeps) return true;         // 무인증 모드 통과
  return can(this.users.get(ws), perm);
}
private canManageChannel(ws: WebSocket, ch: ChatChannel | undefined): boolean {
  if (!this.authDeps) return true;
  const me = this.users.get(ws);
  if (!me) return false;
  return can(me, 'channels.manage') || (!!ch?.creatorId && ch.creatorId === me.id);
}

// authOk 전송부(handleFrame의 인증 성공 분기)에서 user에 permissions 추가:
//   this.sendTo(ws, { t: 'authOk', user: { id: acc.id, displayName: acc.displayName, role: acc.role, permissions: acc.permissions ?? [] } });

// createChannel case: creatorId 기록(무인증이면 me 없음 → undefined)
case 'createChannel': {
  if (this.cfg.role === 'brain' && f.mode === 'team') return;
  const me = this.users.get(ws);
  if (typeof f.name === 'string') {
    this.store.createChannel(f.name, f.mode === 'code' ? 'code' : f.mode === 'team' ? 'team' : 'chat', me?.id);
  }
  this.broadcast({ t: 'channels', list: this.store.listChannels() });
  return;
}

// setRepoPath / deleteChannel / setRespondMode: 관리 게이트
case 'setRepoPath': {
  if (typeof f.id === 'string' && typeof f.repoPath === 'string') {
    const ch = this.store.listChannels().find((c) => c.id === f.id);
    if (this.canManageChannel(ws, ch)) this.store.setRepoPath(f.id, f.repoPath);
  }
  this.broadcast({ t: 'channels', list: this.store.listChannels() });
  return;
}
case 'deleteChannel': {
  if (typeof f.id === 'string') {
    const ch = this.store.listChannels().find((c) => c.id === f.id);
    if (this.canManageChannel(ws, ch)) this.store.deleteChannel(f.id);
  }
  this.broadcast({ t: 'channels', list: this.store.listChannels() });
  return;
}
case 'setRespondMode': {
  if (typeof f.id === 'string' && (f.mode === 'all' || f.mode === 'mention')) {
    const ch = this.store.listChannels().find((c) => c.id === f.id);
    if (this.canManageChannel(ws, ch)) this.store.setRespondMode(f.id, f.mode);
  }
  this.broadcast({ t: 'channels', list: this.store.listChannels() });
  return;
}

// proposalApprove / proposalReject: wiki.approve 게이트(가장 앞에)
case 'proposalApprove': {
  if (!this.wikiDeps || typeof f.id !== 'string') return;
  if (!this.allowed(ws, 'wiki.approve')) return;   // 무권한 무시
  if (this.approving.has(f.id)) return;
  // ...기존 apply 로직 그대로...
}
case 'proposalReject': {
  if (!this.wikiDeps || typeof f.id !== 'string') return;
  if (!this.allowed(ws, 'wiki.approve')) return;   // 무권한 무시
  // ...기존 reject 로직 그대로...
}
```

주석 블록을 실제 코드로 반영한다. `createChannel`이 이제 블록(`{}`)이 되므로 case 라벨 뒤 중괄호를 맞춘다.

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts && npm test`
Expected: 신규 PASS + 전체 회귀 통과

- [ ] **Step 5: 커밋**

```bash
git add shared/protocol.ts src/edge/messenger/self.adapter.ts src/edge/messenger/self.adapter.spec.ts
git commit -m "feat(phase16b): wiki.approve·채널 관리 게이트 + createChannel creatorId + authOk permissions"
```

---

### Task 5: self.adapter `adminSetPermissions` + adminList permissions

**Files:**
- Modify: `shared/protocol.ts` (AdminUserDto.permissions, adminSetPermissions 프레임)
- Modify: `src/edge/messenger/self.adapter.ts`
- Test: `src/edge/messenger/self.adapter.spec.ts` (describe 추가)

**Interfaces:**
- Consumes: `setPermissions`(T2), `sanitizePermissions`(T1), owner 게이트(16a `adminGate`/`ADMIN_FRAMES`).
- Produces:
  ```ts
  // protocol: AdminUserDto에 permissions: string[]; ClientFrame에 { t:'adminSetPermissions'; id: string; permissions: string[] }
  ```

- [ ] **Step 1: 실패하는 테스트 추가**

```ts
describe('adminSetPermissions(Phase 16b)', () => {
  // owner + member 두 소켓(makeAuthDeps 관례).

  it('owner: adminSetPermissions로 member 권한 설정 → adminUsers에 반영', async () => {
    // owner 소켓 {t:'adminSetPermissions', id: memberId, permissions:['wiki.approve']}
    // → 응답 {t:'adminUsers'} list에서 그 member.permissions === ['wiki.approve']
  });

  it('member(비owner)의 adminSetPermissions는 무시(권한 미변경)', async () => {
    // member 소켓이 자기/남에게 권한 부여 시도 → accounts.get(id).permissions 변화 없음, adminUsers 미수신
  });

  it('알 수 없는 키는 저장 시 필터', async () => {
    // owner가 ['wiki.approve','bogus'] 전송 → 저장된 건 ['wiki.approve']
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: FAIL

- [ ] **Step 3: 구현**

`shared/protocol.ts`:

```ts
// AdminUserDto에 permissions 추가
export interface AdminUserDto extends UserDto { loginId: string; status: 'pending' | 'active' | 'suspended'; createdAt: string; sso: boolean; permissions: string[] }

// ClientFrame 유니언에 추가:
//   | { t: 'adminSetPermissions'; id: string; permissions: string[] }
```

`self.adapter.ts`:

```ts
// ADMIN_FRAMES Set에 'adminSetPermissions' 추가:
private static readonly ADMIN_FRAMES = new Set([
  'adminUsers', 'adminApprove', 'adminSuspend', 'adminRestore',
  'adminResetPassword', 'adminForceLogout', 'adminGetSettings', 'adminSetSettings',
  'adminSetPermissions',
]);

// adminList()에 permissions 포함:
//   id: a.id, displayName: a.displayName, role: a.role,
//   loginId: a.loginId, status: a.status, createdAt: a.createdAt, sso: !!a.oidc,
//   permissions: a.permissions ?? [],

// handleFrame switch에 case 추가(다른 admin case 옆):
case 'adminSetPermissions': {
  if (typeof f.id === 'string' && Array.isArray(f.permissions)) {
    this.authDeps!.accounts.setPermissions(f.id, f.permissions as Permission[]);
  }
  this.sendAdminList(ws);
  return;
}
```

(`setPermissions`가 내부에서 `sanitizePermissions`로 필터하므로 여기선 배열 여부만 확인. owner 게이트는 ADMIN_FRAMES 공통 게이트가 이미 적용 — 별도 role 체크 불필요.)

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts && npm test`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add shared/protocol.ts src/edge/messenger/self.adapter.ts src/edge/messenger/self.adapter.spec.ts
git commit -m "feat(phase16b): adminSetPermissions(owner 전용) + adminList permissions"
```

---

### Task 6: renderer 권한 헬퍼 `permissions.ts`

**Files:**
- Create: `renderer/src/permissions.ts`
- Test: `renderer/src/permissions.test.ts`

**Interfaces:**
- Consumes: `UserDto`(shared/protocol).
- Produces:
  ```ts
  export function allow(me: UserDto | undefined, perm: string): boolean; // !me → true(무인증), owner → true, else permissions.includes
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// renderer/src/permissions.test.ts
import { describe, it, expect } from 'vitest';
import { allow } from './permissions';

describe('allow', () => {
  it('me 없으면(무인증 서버) true — 버튼 표시', () => {
    expect(allow(undefined, 'wiki.approve')).toBe(true);
  });
  it('owner는 전권', () => {
    expect(allow({ id: 'o', displayName: 'O', role: 'owner' }, 'wiki.approve')).toBe(true);
    expect(allow({ id: 'o', displayName: 'O', role: 'owner', permissions: [] }, 'channels.manage')).toBe(true);
  });
  it('member는 보유 권한만', () => {
    const m = { id: 'm', displayName: 'M', role: 'member' as const, permissions: ['wiki.approve'] };
    expect(allow(m, 'wiki.approve')).toBe(true);
    expect(allow(m, 'channels.manage')).toBe(false);
    expect(allow({ id: 'm', displayName: 'M', role: 'member' as const }, 'wiki.approve')).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run(renderer): `npx vitest run src/permissions.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

```ts
// renderer/src/permissions.ts
import type { UserDto } from '../../shared/protocol';

// UI 게이트용(스펙 §3.1). me가 없으면(=무인증 서버라 authOk가 온 적 없음) 제한 없음으로 버튼 표시.
// me가 있으면 owner 전권 또는 보유 권한으로 판정. 백엔드 순수 can(§2.1)과 달리 !me 단락을 둔다.
export function allow(me: UserDto | undefined, perm: string): boolean {
  if (!me) return true;
  return me.role === 'owner' || (me.permissions ?? []).includes(perm);
}
```

- [ ] **Step 4: 통과 확인**

Run(renderer): `npx vitest run src/permissions.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add renderer/src/permissions.ts renderer/src/permissions.test.ts
git commit -m "feat(phase16b): renderer allow 헬퍼(무인증=표시·owner 전권)"
```

---

### Task 7: renderer WikiArea 승인 버튼 게이트 + App permissions 배선

**Files:**
- Modify: `renderer/src/components/WikiArea.tsx` (+test)
- Modify: `renderer/src/App.tsx`

**Interfaces:**
- Consumes: `allow`(T6), `meByConn`(16a — 이제 `UserDto`에 permissions 포함).
- Produces: `WikiArea`에 `canApprove: boolean` prop 추가.

- [ ] **Step 1: 실패하는 테스트 작성/수정**

`WikiArea.test.tsx`에 케이스 추가(없으면 파일 생성 — 기존 렌더러 테스트 관례 RTL):

```tsx
it('canApprove=false면 승인/거부 버튼 미표시(승인함은 읽기전용)', () => {
  const proposals = [{ id: 'p1', op: 'create' as const, targetSlug: 's', title: 'T', category: 'c', payload: 'body', sources: [], importance: 3, confidence: 0.9, reason: 'why' }];
  render(<WikiArea pages={[]} openPage={null} proposals={proposals} canApprove={false}
    onOpenPage={() => {}} onApprove={() => {}} onReject={() => {}} />);
  // 승인함 탭으로 전환
  fireEvent.click(screen.getByText(/inbox|승인함/i));
  expect(screen.queryByRole('button', { name: /approve|승인/i })).toBeNull();
});

it('canApprove=true면 승인 버튼 표시', () => {
  const proposals = [{ id: 'p1', op: 'create' as const, targetSlug: 's', title: 'T', category: 'c', payload: 'body', sources: [], importance: 3, confidence: 0.9, reason: 'why' }];
  render(<WikiArea pages={[]} openPage={null} proposals={proposals} canApprove={true}
    onOpenPage={() => {}} onApprove={() => {}} onReject={() => {}} />);
  fireEvent.click(screen.getByText(/inbox|승인함/i));
  expect(screen.getByRole('button', { name: /approve|승인/i })).toBeTruthy();
});
```

- [ ] **Step 2: 실패 확인**

Run(renderer): `npx vitest run src/components/WikiArea.test.tsx`
Expected: FAIL — canApprove prop 없음(타입/동작)

- [ ] **Step 3: 구현**

`WikiArea.tsx`: props에 `canApprove: boolean` 추가, 승인/거부 버튼을 감싼다:

```tsx
export function WikiArea(props: {
  pages: WikiPageMeta[];
  openPage: WikiPageDto | null;
  proposals: ProposalDto[];
  canApprove: boolean;
  onOpenPage: (slug: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  // ...기존...
  // propActions 부분:
  {props.canApprove && (
    <div className="propActions">
      <button type="button" onClick={() => props.onApprove(p.id)}>{T.wikiApprove}</button>
      <button type="button" className="danger" onClick={() => props.onReject(p.id)}>{T.wikiReject}</button>
    </div>
  )}
```

`App.tsx`: WikiArea 렌더에 canApprove 전달:

```tsx
import { allow } from './permissions';
// ...
<WikiArea
  pages={wikiPages}
  openPage={wikiOpen}
  proposals={proposals}
  canApprove={allow(meByConn[connState.defaultConnId], 'wiki.approve')}
  onOpenPage={(slug) => send(connState.defaultConnId, { t: 'wikiGet', slug })}
  onApprove={(id) => send(connState.defaultConnId, { t: 'proposalApprove', id })}
  onReject={(id) => send(connState.defaultConnId, { t: 'proposalReject', id })}
/>
```

- [ ] **Step 4: 통과 확인**

Run(renderer): `npx vitest run`
Expected: 전체 PASS (기존 WikiArea 테스트가 canApprove 필수화로 깨지면 그 테스트에 `canApprove={true}` 추가 — 번역이지 gut 아님)

- [ ] **Step 5: 커밋**

```bash
git add renderer/src/components/WikiArea.tsx renderer/src/components/WikiArea.test.tsx renderer/src/App.tsx
git commit -m "feat(phase16b): 위키 승인/거부 버튼을 wiki.approve 권한으로 게이트"
```

---

### Task 8: renderer 채널 ⋯메뉴 소유/권한 게이트

**Files:**
- Modify: `renderer/src/components/Channels.tsx` (+test)
- Modify: `renderer/src/App.tsx`

**Interfaces:**
- Consumes: `allow`(T6), `meByConn`, 채널 `creatorId`(protocol Channel — T4).
- Produces: `Channels`에 `canManageChannels: boolean`·`myId?: string` prop 추가; 사이드바 채널에 `creatorId` 전달.

- [ ] **Step 1: 실패하는 테스트 작성/수정**

`Channels.test.tsx`에 추가:

```tsx
it('남의 채널이고 canManageChannels=false면 ⋯메뉴 숨김', () => {
  const channels = [{ id: 'general', name: 'general', respondMode: 'all' as const, mode: 'chat' as const, creatorId: 'someone-else' }];
  render(<Channels channels={channels} current="general" mode="chat" canManageChannels={false} myId="me"
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} />);
  expect(screen.queryByText('⋯')).toBeNull();
});

it('내 채널이면 권한 없어도 ⋯메뉴 표시', () => {
  const channels = [{ id: 'general', name: 'general', respondMode: 'all' as const, mode: 'chat' as const, creatorId: 'me' }];
  render(<Channels channels={channels} current="general" mode="chat" canManageChannels={false} myId="me"
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} />);
  expect(screen.getByText('⋯')).toBeTruthy();
});

it('canManageChannels=true면 남 채널도 ⋯메뉴 표시', () => {
  const channels = [{ id: 'general', name: 'general', respondMode: 'all' as const, mode: 'chat' as const, creatorId: 'other' }];
  render(<Channels channels={channels} current="general" mode="chat" canManageChannels={true} myId="me"
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} />);
  expect(screen.getByText('⋯')).toBeTruthy();
});
```

- [ ] **Step 2: 실패 확인**

Run(renderer): `npx vitest run src/components/Channels.test.tsx`
Expected: FAIL — props 없음·⋯ 항상 표시

- [ ] **Step 3: 구현**

`Channels.tsx`: props에 `canManageChannels: boolean`·`myId?: string` 추가. ⋯ 렌더 조건을 추가:

```tsx
export function Channels(props: {
  channels: Channel[];
  current: string | null;
  mode: 'chat' | 'code' | 'team' | 'wiki' | 'admin';
  canManageChannels: boolean;
  myId?: string;
  showAdmin?: boolean;
  onSelect: (id: string) => void;
  onSetMode: (m: 'chat' | 'code' | 'team' | 'wiki' | 'admin') => void;
  onCreate: (name: string, mode: 'chat' | 'code' | 'team' | 'wiki' | 'admin') => void;
  onDelete: (id: string) => void;
  onSetRespondMode: (id: string, mode: 'all' | 'mention') => void;
}) {
  // ...
  const canManage = (c: Channel) => props.canManageChannels || (!!props.myId && c.creatorId === props.myId);
  // 채널 목록 렌더에서 ⋯ span:
  {visible.map((c) => (
    <div key={c.id} className={'ch' + (c.id === current ? ' sel' : '')} onClick={() => props.onSelect(c.id)}>
      <span>{'# ' + c.name}</span>
      {canManage(c) && <span className="menu" onClick={(e) => { e.stopPropagation(); openMenu(c.id, e.currentTarget); }}>⋯</span>}
    </div>
  ))}
```

`App.tsx`: sidebarChannels에 creatorId를 실어주고(기본 연결의 실제 채널에서), Channels에 props 전달:

```tsx
// sidebarChannels 합성 시 creatorId 포함(기본 연결의 매칭 채널에서):
const sidebarChannels: Channel[] = mode === 'wiki' || mode === 'admin' ? [] : logicalChannels(viewChannelsByConn, mode).map((name) => {
  const fromDefault = viewChannelsByConn[connState.defaultConnId]?.find((c) => c.name === name && (c.mode ?? 'chat') === mode);
  const any = fromDefault ?? Object.values(viewChannelsByConn).flat().find((c) => c.name === name && (c.mode ?? 'chat') === mode);
  return { id: name, name, respondMode: any?.respondMode ?? 'all', mode, ...(any?.creatorId ? { creatorId: any.creatorId } : {}) };
});

// Channels 렌더:
<Channels
  channels={sidebarChannels} current={currentName} mode={mode}
  canManageChannels={allow(meByConn[connState.defaultConnId], 'channels.manage')}
  myId={meByConn[connState.defaultConnId]?.id}
  showAdmin={meByConn[connState.defaultConnId]?.role === 'owner'}
  onSelect={(name) => setCurrentName(name)} onSetMode={setMode}
  onCreate={(name, m) => { if (m !== 'wiki' && m !== 'admin') send(connState.defaultConnId, { t: 'createChannel', name, mode: m }); }}
  onDelete={(name) => fanoutToName(name, (id) => ({ t: 'deleteChannel', id }))}
  onSetRespondMode={(name, m) => fanoutToName(name, (id) => ({ t: 'setRespondMode', id, mode: m }))}
/>
```

주의: `FolderEmpty`의 setRepoPath 경로도 자기 채널이면 동작(백엔드가 소유 게이트 적용). UI에서 Code 폴더 바인딩 버튼은 그대로 두되(백엔드가 권위), 필요 시 후속.

- [ ] **Step 4: 통과 확인**

Run(renderer): `npx vitest run`
Expected: 전체 PASS (기존 Channels 테스트가 props 필수화로 깨지면 `canManageChannels`/`myId` 추가 — 번역)

- [ ] **Step 5: 커밋**

```bash
git add renderer/src/components/Channels.tsx renderer/src/components/Channels.test.tsx renderer/src/App.tsx
git commit -m "feat(phase16b): 채널 ⋯메뉴를 소유(creatorId)·channels.manage 권한으로 게이트"
```

---

### Task 9: renderer AdminArea 권한 체크박스 + adminSetPermissions 배선

**Files:**
- Modify: `renderer/src/components/AdminArea.tsx` (+test)
- Modify: `renderer/src/App.tsx`, `renderer/src/i18n.ts`

**Interfaces:**
- Consumes: `AdminUserDto.permissions`(T5), `adminSetPermissions` 프레임(T5), `PERMISSIONS` 키.
- Produces: `AdminArea`에 `onSetPermissions(id: string, permissions: string[])` prop 추가.

- [ ] **Step 1: 실패하는 테스트 추가**

`AdminArea.test.tsx`에 추가:

```tsx
it('active member 행에 권한 체크박스 2개, 토글 시 onSetPermissions', () => {
  const onSetPermissions = vi.fn();
  const users = [
    { id: 'o', loginId: 'boss', displayName: 'Boss', role: 'owner' as const, status: 'active' as const, createdAt: '2026-01-01', sso: false, permissions: [] },
    { id: 'm', loginId: 'kim', displayName: 'Kim', role: 'member' as const, status: 'active' as const, createdAt: '2026-01-02', sso: false, permissions: ['wiki.approve'] },
  ];
  render(<AdminArea users={users} settings={{}} onSetPermissions={onSetPermissions}
    onApprove={()=>{}} onSuspend={()=>{}} onRestore={()=>{}} onResetPassword={()=>{}} onForceLogout={()=>{}} onSaveSettings={()=>{}} />);
  // Kim 행: wiki.approve 체크됨, channels.manage 미체크. channels.manage 체크박스 클릭 → 둘 다 포함해 호출.
  const boxes = screen.getAllByRole('checkbox');
  const channelsBox = boxes.find((b) => b.getAttribute('data-perm') === 'channels.manage')!;
  fireEvent.click(channelsBox);
  expect(onSetPermissions).toHaveBeenCalledWith('m', expect.arrayContaining(['wiki.approve', 'channels.manage']));
});

it('owner 행은 "all" 표시·체크박스 없음(disabled)', () => {
  const users = [{ id: 'o', loginId: 'boss', displayName: 'Boss', role: 'owner' as const, status: 'active' as const, createdAt: '2026-01-01', sso: false, permissions: [] }];
  render(<AdminArea users={users} settings={{}} onSetPermissions={()=>{}}
    onApprove={()=>{}} onSuspend={()=>{}} onRestore={()=>{}} onResetPassword={()=>{}} onForceLogout={()=>{}} onSaveSettings={()=>{}} />);
  expect(screen.queryAllByRole('checkbox').length).toBe(0);
});
```

- [ ] **Step 2: 실패 확인**

Run(renderer): `npx vitest run src/components/AdminArea.test.tsx`
Expected: FAIL — 체크박스·onSetPermissions 없음

- [ ] **Step 3: 구현**

`i18n.ts` 추가:

```ts
permWikiApprove: ko ? '위키 승인' : 'Approve wiki',
permChannelsManage: ko ? '채널 관리' : 'Manage channels',
permAll: ko ? '전체 (owner)' : 'all (owner)',
adminPermissions: ko ? '권한' : 'Permissions',
```

`AdminArea.tsx`: props에 `onSetPermissions` 추가, 각 member 행에 권한 체크박스(active·비owner일 때):

```tsx
import type { AdminUserDto, AdminSettings } from '../../../shared/protocol';
const PERM_KEYS: { key: string; label: string }[] = [
  { key: 'wiki.approve', label: T.permWikiApprove },
  { key: 'channels.manage', label: T.permChannelsManage },
];

// props에 추가: onSetPermissions: (id: string, permissions: string[]) => void;

// 각 행 렌더에 권한 셀 추가(status 뒤):
{u.role === 'owner' ? (
  <span className="perms">{T.permAll}</span>
) : (
  <span className="perms">
    {PERM_KEYS.map(({ key, label }) => (
      <label key={key} title={label}>
        <input type="checkbox" data-perm={key}
          checked={u.permissions.includes(key)}
          onChange={(e) => {
            const next = e.target.checked
              ? [...u.permissions, key]
              : u.permissions.filter((p) => p !== key);
            props.onSetPermissions(u.id, next);
          }} />
        {label}
      </label>
    ))}
  </span>
)}
```

`App.tsx`: AdminArea 렌더에 onSetPermissions 전달:

```tsx
<AdminArea users={adminUsers} settings={adminSettings}
  onApprove={(id) => send(connState.defaultConnId, { t: 'adminApprove', id })}
  onSuspend={(id) => send(connState.defaultConnId, { t: 'adminSuspend', id })}
  onRestore={(id) => send(connState.defaultConnId, { t: 'adminRestore', id })}
  onResetPassword={(id, password) => send(connState.defaultConnId, { t: 'adminResetPassword', id, password })}
  onForceLogout={(id) => send(connState.defaultConnId, { t: 'adminForceLogout', id })}
  onSaveSettings={(s) => send(connState.defaultConnId, { t: 'adminSetSettings', settings: s })}
  onSetPermissions={(id, permissions) => send(connState.defaultConnId, { t: 'adminSetPermissions', id, permissions })}
/>
```

- [ ] **Step 4: 통과 확인**

Run(renderer): `npx vitest run` — 전체 PASS. 그리고 백엔드 `npm test` + 양쪽 `npm run build`/`npx tsc --noEmit` 클린 확인.
Expected: 전부 PASS·클린

- [ ] **Step 5: 커밋**

```bash
git add renderer/src/components/AdminArea.tsx renderer/src/components/AdminArea.test.tsx renderer/src/App.tsx renderer/src/i18n.ts
git commit -m "feat(phase16b): AdminArea 권한 체크박스 + adminSetPermissions 배선"
```

---

## 수동 스모크(구현 밖 — 최종 검증용)

1. owner로 로그인 → 관리 탭에서 member에게 `wiki.approve` 부여 → 그 member 재로그인 시 위키 승인함에 버튼 보임, 미부여 member는 버튼 없음.
2. member A가 채널 생성 → A는 ⋯메뉴로 삭제 가능, member B(권한 없음)는 그 채널 ⋯메뉴 안 보임.
3. owner가 member에게 `channels.manage` 부여 → 그 member는 남의 채널도 ⋯메뉴로 관리 가능.
4. 무인증 로컬 앱: 위키 승인·채널 관리 다 그대로 됨(회귀 없음).

## Self-Review 노트

- 스펙 §1(모델)=T1·T2·T3, §2.1(can)=T1, §2.2(저장소)=T2·T3, §2.3(게이트)=T4, §2.4(adminSetPermissions)=T5, §2.5(프로토콜)=T4·T5, §3.1(allow)=T6, §3.2(WikiArea)=T7, §3.3(Channels)=T8, §3.4(AdminArea)=T9, §3.5·i18n=T7/T9, §4(에러/하위호환)=T4(무인증 통과·조용한 무시), §5(테스트)=각 태스크. 갭 없음.
- 타입 일관성: `Permission`(T1)→T2·T4·T5 소비, `Account.permissions`(T2)→T4 authOk·T5 adminList, `Channel.creatorId`(T4)→T8, `UserDto.permissions`(T4)→T6·T7·T8, `AdminUserDto.permissions`(T5)→T9, `allow`(T6)→T7·T8. 시그니처 일치.
- `creatorId` vs 기존 `ownerId`: 16b는 `creatorId`(관리 소유권), `ownerId`/`visibility`는 16c 비공개 채널 씨앗 — 별개, 안 건드림.
- YAGNI: 파괴적 행위·users.manage/server.settings 위임·권한 위임·역할 프리셋은 스펙 §7대로 제외.
