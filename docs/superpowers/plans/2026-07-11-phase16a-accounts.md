# Phase 16a — 계정·신원 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1인 1계정(아이디/비밀번호 + OIDC SSO)·소유자 승인 가입·앱 로그인 게이트·앱 내 관리 화면을 만들고, Phase 13 공유 토큰·Phase 14 자가선언 닉네임을 대체한다.

**Architecture:** 계정·세션·인증 http·OIDC를 `src/edge/auth/`의 독립 모듈 4개로 만들고, `self.adapter`는 ① `/auth/` http 위임 ② ws 세션 게이트(+authorId 서버 스탬프) ③ owner 전용 admin 프레임만 추가한다(계정 내부 모름). 클라는 세션 저장 + 로그인 게이트 + Admin 영역. 같은 런타임이 `role: 'server' | 'brain'` 두 모드로 뜬다(brain=계정·위키승인·team 없음, 127.0.0.1 고정).

**Tech Stack:** Node 내장만(crypto scrypt/randomBytes/JWK verify, http, global fetch). 신규 의존성 0. 백엔드 테스트 jest(`npx jest <파일>`), 렌더러 vitest(renderer 폴더에서 `npx vitest run <파일>`).

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-07-11-phase16a-accounts-design.md`. 배포 전이므로 마이그레이션 없음 — 공유 토큰·자가선언 닉네임은 **제거 대체**.
- **UI 문구 영어 기본 / ko 로케일 한국어**(`renderer/src/i18n.ts`의 `ko` 삼항 관례).
- 두뇌 코어(brain/agent-layer/knowledge-core 위키·RAG)는 손대지 않는다. 손대는 백엔드는 `src/edge/`와 `src/main.ts`, 설정 로더뿐.
- 보안(스펙 §4): scrypt+사용자별 salt+`timingSafeEqual`, 세션=`randomBytes(32)`, 로그인 실패 균일 응답+고정 지연, OIDC state·`iss`/`aud`/`exp` 검증, setup 코드 1회용. 로그에 토큰·비밀번호 원문 금지.
- `engram`은 예약 이름 — loginId/displayName으로 사용 불가(가입·setup에서 거부).
- 파일 store는 손상 파일 fault-tolerant 로드(chat-store 관례: try/catch → 기본값).
- 커밋 메시지 규약: `feat(phase16a): …` / `test(phase16a): …`. 공동 작업자(Co-Authored-By) 넣지 않는다.
- 각 태스크 완료 시 전체 스위트 회귀 확인: 백엔드 `npm test`, 렌더러 `renderer`에서 `npx vitest run`.

---

### Task 1: AccountStore — 계정 저장·비밀번호 해시

**Files:**
- Create: `src/edge/auth/account-store.ts`
- Test: `src/edge/auth/account-store.spec.ts`

**Interfaces:**
- Consumes: 없음(Node crypto·fs만).
- Produces(후속 태스크가 사용):
  ```ts
  export type AccountRole = 'owner' | 'member';
  export type AccountStatus = 'pending' | 'active' | 'suspended';
  export interface Account {
    id: string; loginId: string; displayName: string;
    pass?: { salt: string; hash: string };
    oidc?: { issuer: string; sub: string; email?: string };
    role: AccountRole; status: AccountStatus; createdAt: string;
  }
  export class AccountStore {
    constructor(stateDir: string);
    count(): number;
    list(): Account[];
    get(id: string): Account | null;
    getByLoginId(loginId: string): Account | null;
    getByOidc(issuer: string, sub: string): Account | null;
    createPassword(loginId: string, password: string, displayName: string,
      opts?: { role?: AccountRole; status?: AccountStatus }): Account; // 중복 loginId/예약어 → throw
    createOidc(o: { issuer: string; sub: string; email?: string; displayName: string }): Account; // pending member
    verifyPassword(loginId: string, password: string): Account | null; // 자격증명만 검증(상태 분기는 호출자)
    setStatus(id: string, status: AccountStatus): boolean;
    setPassword(id: string, password: string): boolean;
  }
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/edge/auth/account-store.spec.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AccountStore } from './account-store';

describe('AccountStore', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('비밀번호 계정 생성·조회·검증', () => {
    const s = new AccountStore(dir);
    const a = s.createPassword('kim', 'pw1234', 'Kim', { role: 'owner', status: 'active' });
    expect(a.id).toBeTruthy();
    expect(s.count()).toBe(1);
    expect(s.getByLoginId('kim')?.id).toBe(a.id);
    expect(s.verifyPassword('kim', 'pw1234')?.id).toBe(a.id);
    expect(s.verifyPassword('kim', 'wrong')).toBeNull();
    expect(s.verifyPassword('nobody', 'pw1234')).toBeNull();
  });

  it('비밀번호는 원문 저장 안 함(파일에 pw 미포함)', () => {
    const s = new AccountStore(dir);
    s.createPassword('kim', 'secretpw', 'Kim');
    const raw = fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8');
    expect(raw).not.toContain('secretpw');
  });

  it('중복 loginId·예약어 engram 거부', () => {
    const s = new AccountStore(dir);
    s.createPassword('kim', 'pw', 'Kim');
    expect(() => s.createPassword('kim', 'pw2', 'Kim2')).toThrow();
    expect(() => s.createPassword('Engram', 'pw', 'x')).toThrow();
    expect(() => s.createPassword('lee', 'pw', 'engram')).toThrow();
  });

  it('OIDC 계정: pending member로 생성, issuer+sub 조회', () => {
    const s = new AccountStore(dir);
    const a = s.createOidc({ issuer: 'https://idp', sub: 'u1', email: 'a@b.c', displayName: 'Lee' });
    expect(a.status).toBe('pending');
    expect(a.role).toBe('member');
    expect(s.getByOidc('https://idp', 'u1')?.id).toBe(a.id);
    expect(s.getByOidc('https://idp', 'zz')).toBeNull();
  });

  it('setStatus·setPassword·재로드 영속', () => {
    const s = new AccountStore(dir);
    const a = s.createPassword('kim', 'pw', 'Kim');
    expect(s.setStatus(a.id, 'suspended')).toBe(true);
    expect(s.setPassword(a.id, 'newpw')).toBe(true);
    const s2 = new AccountStore(dir); // 재로드
    expect(s2.get(a.id)?.status).toBe('suspended');
    expect(s2.verifyPassword('kim', 'newpw')?.id).toBe(a.id);
    expect(s2.setStatus('없는id', 'active')).toBe(false);
  });

  it('손상 파일 fault-tolerant: 빈 store로 시작', () => {
    fs.writeFileSync(path.join(dir, 'accounts.json'), '{broken');
    expect(new AccountStore(dir).count()).toBe(0);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/auth/account-store.spec.ts`
Expected: FAIL — `Cannot find module './account-store'`

- [ ] **Step 3: 최소 구현**

```ts
// src/edge/auth/account-store.ts
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

// 계정 저장소(Phase 16a 스펙 §2.2). accounts.json 단일 파일, 손상 시 빈 목록(chat-store 관례).
// 비밀번호 = scrypt(사용자별 salt) 해시만 저장. 'engram'은 예약(사칭 방지).

export type AccountRole = 'owner' | 'member';
export type AccountStatus = 'pending' | 'active' | 'suspended';
export interface Account {
  id: string; loginId: string; displayName: string;
  pass?: { salt: string; hash: string };
  oidc?: { issuer: string; sub: string; email?: string };
  role: AccountRole; status: AccountStatus; createdAt: string;
}

const RESERVED = 'engram';
function hashPw(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

export class AccountStore {
  constructor(private readonly stateDir: string) {}

  private file(): string { return path.join(this.stateDir, 'accounts.json'); }

  private load(): Account[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as unknown;
      return Array.isArray(raw) ? (raw as Account[]) : [];
    } catch { return []; }
  }
  private save(list: Account[]): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.writeFileSync(this.file(), JSON.stringify(list, null, 2));
  }

  count(): number { return this.load().length; }
  list(): Account[] { return this.load(); }
  get(id: string): Account | null { return this.load().find((a) => a.id === id) ?? null; }
  getByLoginId(loginId: string): Account | null {
    const k = loginId.trim().toLowerCase();
    return this.load().find((a) => a.loginId.toLowerCase() === k) ?? null;
  }
  getByOidc(issuer: string, sub: string): Account | null {
    return this.load().find((a) => a.oidc?.issuer === issuer && a.oidc?.sub === sub) ?? null;
  }

  private assertNames(loginId: string, displayName: string): void {
    if (!loginId.trim() || !displayName.trim()) throw new Error('empty name');
    if (loginId.trim().toLowerCase() === RESERVED || displayName.trim().toLowerCase() === RESERVED) {
      throw new Error('reserved name');
    }
    if (this.getByLoginId(loginId)) throw new Error('duplicate loginId');
  }

  createPassword(loginId: string, password: string, displayName: string,
    opts?: { role?: AccountRole; status?: AccountStatus }): Account {
    this.assertNames(loginId, displayName);
    const salt = randomBytes(16).toString('hex');
    const a: Account = {
      id: randomUUID(), loginId: loginId.trim(), displayName: displayName.trim(),
      pass: { salt, hash: hashPw(password, salt) },
      role: opts?.role ?? 'member', status: opts?.status ?? 'pending',
      createdAt: new Date().toISOString(),
    };
    const list = this.load(); list.push(a); this.save(list);
    return a;
  }

  createOidc(o: { issuer: string; sub: string; email?: string; displayName: string }): Account {
    // loginId는 이메일(없으면 issuer의 sub) — 로그인용이 아니라 식별 표시용. 충돌 시 sub를 붙여 유일화.
    let loginId = (o.email ?? `${o.sub}`).trim() || o.sub;
    if (this.getByLoginId(loginId)) loginId = `${loginId}#${o.sub}`;
    const name = o.displayName.trim().toLowerCase() === RESERVED ? loginId : o.displayName;
    const a: Account = {
      id: randomUUID(), loginId, displayName: name.trim() || loginId,
      oidc: { issuer: o.issuer, sub: o.sub, ...(o.email ? { email: o.email } : {}) },
      role: 'member', status: 'pending', createdAt: new Date().toISOString(),
    };
    const list = this.load(); list.push(a); this.save(list);
    return a;
  }

  verifyPassword(loginId: string, password: string): Account | null {
    const a = this.getByLoginId(loginId);
    // 계정 없어도 같은 비용의 해시를 계산(타이밍으로 존재 여부 유출 방지).
    const salt = a?.pass?.salt ?? '00'.repeat(16);
    const got = Buffer.from(hashPw(password, salt), 'hex');
    const want = Buffer.from(a?.pass?.hash ?? '00'.repeat(64), 'hex');
    const ok = got.length === want.length && timingSafeEqual(got, want);
    return ok && a?.pass ? a : null;
  }

  setStatus(id: string, status: AccountStatus): boolean {
    const list = this.load();
    const a = list.find((x) => x.id === id);
    if (!a) return false;
    a.status = status; this.save(list);
    return true;
  }

  setPassword(id: string, password: string): boolean {
    const list = this.load();
    const a = list.find((x) => x.id === id);
    if (!a) return false;
    const salt = randomBytes(16).toString('hex');
    a.pass = { salt, hash: hashPw(password, salt) };
    this.save(list);
    return true;
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/auth/account-store.spec.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/edge/auth/account-store.ts src/edge/auth/account-store.spec.ts
git commit -m "feat(phase16a): AccountStore — 계정 저장·scrypt 해시·예약어/중복 거부"
```

---

### Task 2: SessionStore — 세션 발급·만료·무효화

**Files:**
- Create: `src/edge/auth/session-store.ts`
- Test: `src/edge/auth/session-store.spec.ts`

**Interfaces:**
- Consumes: 없음.
- Produces:
  ```ts
  export interface Session { token: string; userId: string; createdAt: string; expiresAt: string }
  export class SessionStore {
    constructor(stateDir: string, ttlMs?: number); // 기본 30일
    issue(userId: string): Session;
    resolve(token: string): Session | null; // 만료/미존재 → null(만료건은 삭제)
    revoke(token: string): void;
    revokeAllFor(userId: string): void;
  }
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/edge/auth/session-store.spec.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionStore } from './session-store';

describe('SessionStore', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ses-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('issue → resolve, 토큰은 64자 hex', () => {
    const s = new SessionStore(dir);
    const sess = s.issue('u1');
    expect(sess.token).toMatch(/^[0-9a-f]{64}$/);
    expect(s.resolve(sess.token)?.userId).toBe('u1');
    expect(s.resolve('없는토큰')).toBeNull();
  });

  it('만료된 세션은 null + 삭제', () => {
    const s = new SessionStore(dir, -1000); // 즉시 만료 TTL
    const sess = s.issue('u1');
    expect(s.resolve(sess.token)).toBeNull();
    const raw = fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8');
    expect(raw).not.toContain(sess.token);
  });

  it('revoke·revokeAllFor·재로드 영속', () => {
    const s = new SessionStore(dir);
    const a = s.issue('u1'); const b = s.issue('u1'); const c = s.issue('u2');
    s.revoke(a.token);
    expect(s.resolve(a.token)).toBeNull();
    s.revokeAllFor('u1');
    expect(s.resolve(b.token)).toBeNull();
    expect(new SessionStore(dir).resolve(c.token)?.userId).toBe('u2');
  });

  it('손상 파일 fault-tolerant', () => {
    fs.writeFileSync(path.join(dir, 'sessions.json'), 'not json');
    expect(new SessionStore(dir).resolve('x')).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/auth/session-store.spec.ts`
Expected: FAIL — `Cannot find module './session-store'`

- [ ] **Step 3: 최소 구현**

```ts
// src/edge/auth/session-store.ts
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

// 세션 저장소(스펙 §2.2). sessions.json, 만료 기본 30일 — 검사 시점은 제시될 때(resolve).

export interface Session { token: string; userId: string; createdAt: string; expiresAt: string }

export class SessionStore {
  constructor(
    private readonly stateDir: string,
    private readonly ttlMs: number = 30 * 24 * 3600 * 1000,
  ) {}

  private file(): string { return path.join(this.stateDir, 'sessions.json'); }
  private load(): Session[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as unknown;
      return Array.isArray(raw) ? (raw as Session[]) : [];
    } catch { return []; }
  }
  private save(list: Session[]): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.writeFileSync(this.file(), JSON.stringify(list, null, 2));
  }

  issue(userId: string): Session {
    const now = Date.now();
    const s: Session = {
      token: randomBytes(32).toString('hex'), userId,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.ttlMs).toISOString(),
    };
    const list = this.load(); list.push(s); this.save(list);
    return s;
  }

  resolve(token: string): Session | null {
    const list = this.load();
    const s = list.find((x) => x.token === token);
    if (!s) return null;
    if (new Date(s.expiresAt).getTime() <= Date.now()) {
      this.save(list.filter((x) => x.token !== token)); // 만료건 청소
      return null;
    }
    return s;
  }

  revoke(token: string): void {
    this.save(this.load().filter((x) => x.token !== token));
  }
  revokeAllFor(userId: string): void {
    this.save(this.load().filter((x) => x.userId !== userId));
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/auth/session-store.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/edge/auth/session-store.ts src/edge/auth/session-store.spec.ts
git commit -m "feat(phase16a): SessionStore — 세션 발급·만료 청소·사용자 단위 무효화"
```

---

### Task 3: 인증 설정(auth.json) + setup-code

**Files:**
- Create: `src/edge/auth/auth.config.ts`
- Create: `src/edge/auth/setup-code.ts`
- Test: `src/edge/auth/auth.config.spec.ts`, `src/edge/auth/setup-code.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  // auth.config.ts
  export interface OidcSettings { issuer: string; clientId: string; clientSecret: string }
  export interface AuthSettings { serverName?: string; oidc?: OidcSettings }
  export function loadAuthSettings(configDir: string): AuthSettings;
  export function saveAuthSettings(configDir: string, s: AuthSettings): void;
  export const OIDC_PRESETS: Record<string, string>; // 이름 → issuer. { google: 'https://accounts.google.com' }
  // setup-code.ts
  export function ensureSetupCode(stateDir: string): string;      // 없으면 생성(32자 hex), 있으면 그 값
  export function readSetupCode(stateDir: string): string | null; // 파일 없으면 null
  export function clearSetupCode(stateDir: string): void;
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/edge/auth/auth.config.spec.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadAuthSettings, saveAuthSettings, OIDC_PRESETS } from './auth.config';

describe('auth.config', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('없으면 빈 설정, save→load 왕복', () => {
    expect(loadAuthSettings(dir)).toEqual({});
    saveAuthSettings(dir, { serverName: 'Team', oidc: { issuer: 'https://idp', clientId: 'c', clientSecret: 's' } });
    expect(loadAuthSettings(dir).serverName).toBe('Team');
    expect(loadAuthSettings(dir).oidc?.issuer).toBe('https://idp');
  });

  it('손상 파일 → 빈 설정 / 프리셋에 google', () => {
    fs.writeFileSync(path.join(dir, 'auth.json'), '{bad');
    expect(loadAuthSettings(dir)).toEqual({});
    expect(OIDC_PRESETS.google).toBe('https://accounts.google.com');
  });
});
```

```ts
// src/edge/auth/setup-code.spec.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureSetupCode, readSetupCode, clearSetupCode } from './setup-code';

describe('setup-code', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('ensure는 멱등(두 번 불러도 같은 코드), read/clear', () => {
    const c1 = ensureSetupCode(dir);
    expect(c1).toMatch(/^[0-9a-f]{32}$/);
    expect(ensureSetupCode(dir)).toBe(c1);
    expect(readSetupCode(dir)).toBe(c1);
    clearSetupCode(dir);
    expect(readSetupCode(dir)).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/auth/auth.config.spec.ts src/edge/auth/setup-code.spec.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 최소 구현**

```ts
// src/edge/auth/auth.config.ts
import * as fs from 'fs';
import * as path from 'path';

// 서버 인증 설정(스펙 §2.2). config/auth.json — 서버 이름 + OIDC 연동. 관리 화면에서 수정.

export interface OidcSettings { issuer: string; clientId: string; clientSecret: string }
export interface AuthSettings { serverName?: string; oidc?: OidcSettings }

export const OIDC_PRESETS: Record<string, string> = { google: 'https://accounts.google.com' };

export function loadAuthSettings(configDir: string): AuthSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'auth.json'), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const r = raw as Partial<AuthSettings>;
    const out: AuthSettings = {};
    if (typeof r.serverName === 'string' && r.serverName.trim()) out.serverName = r.serverName.trim();
    const o = r.oidc;
    if (o && typeof o.issuer === 'string' && typeof o.clientId === 'string' && typeof o.clientSecret === 'string') {
      out.oidc = { issuer: o.issuer, clientId: o.clientId, clientSecret: o.clientSecret };
    }
    return out;
  } catch { return {}; }
}

export function saveAuthSettings(configDir: string, s: AuthSettings): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify(s, null, 2));
}
```

```ts
// src/edge/auth/setup-code.ts
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

// 1회용 서버 초기 설정 코드(스펙 §2.4). state/setup-code 파일 — 첫 owner 생성 성공 시 삭제.

function file(stateDir: string): string { return path.join(stateDir, 'setup-code'); }

export function ensureSetupCode(stateDir: string): string {
  const existing = readSetupCode(stateDir);
  if (existing) return existing;
  const code = randomBytes(16).toString('hex');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file(stateDir), code);
  return code;
}

export function readSetupCode(stateDir: string): string | null {
  try {
    const c = fs.readFileSync(file(stateDir), 'utf8').trim();
    return c || null;
  } catch { return null; }
}

export function clearSetupCode(stateDir: string): void {
  try { fs.rmSync(file(stateDir)); } catch { /* 없으면 무시 */ }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/auth/auth.config.spec.ts src/edge/auth/setup-code.spec.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/edge/auth/auth.config.ts src/edge/auth/setup-code.ts src/edge/auth/auth.config.spec.ts src/edge/auth/setup-code.spec.ts
git commit -m "feat(phase16a): auth.json 설정 로더 + 1회용 setup-code"
```

---

### Task 4: AuthHttp — 비밀번호 경로(status/setup/login/register/logout)

**Files:**
- Create: `src/edge/auth/auth-http.ts`
- Test: `src/edge/auth/auth-http.spec.ts`

**Interfaces:**
- Consumes: `AccountStore`(T1), `SessionStore`(T2), `AuthSettings/loadAuthSettings`(T3), `readSetupCode/clearSetupCode`(T3).
- Produces:
  ```ts
  export interface AuthUserDto { id: string; displayName: string; role: 'owner' | 'member' }
  export interface AuthHttpDeps {
    accounts: AccountStore; sessions: SessionStore; stateDir: string;
    settings: { load(): AuthSettings };
    delayMs?: number;             // 실패 지연(기본 500, 테스트 0)
    makeOidc?: (o: OidcSettings) => OidcService; // Task 6에서 사용(테스트 주입)
    polls?: PollStore;                            // Task 6
  }
  export class AuthHttp {
    constructor(deps: AuthHttpDeps);
    handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>; // /auth/*만 true
  }
  ```
  (Task 4 시점에는 `makeOidc`/`polls`/`OidcService`/`PollStore` 타입 참조가 아직 없으므로 **이 두 필드는 Task 6에서 추가**한다 — Task 4의 deps는 `accounts/sessions/stateDir/settings/delayMs`만.)

- [ ] **Step 1: 실패하는 테스트 작성**

테스트 헬퍼: 실제 `http.createServer`에 붙여 `fetch`로 검증(포트 0).

```ts
// src/edge/auth/auth-http.spec.ts
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AccountStore } from './account-store';
import { SessionStore } from './session-store';
import { ensureSetupCode, readSetupCode } from './setup-code';
import { AuthHttp } from './auth-http';

describe('AuthHttp(비밀번호 경로)', () => {
  let dir: string; let server: http.Server; let base: string;
  let accounts: AccountStore; let sessions: SessionStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-'));
    accounts = new AccountStore(dir);
    sessions = new SessionStore(dir);
    const ah = new AuthHttp({ accounts, sessions, stateDir: dir, settings: { load: () => ({ serverName: 'T' }) }, delayMs: 0 });
    server = http.createServer((req, res) => { void ah.handle(req, res).then((hit) => { if (!hit) { res.writeHead(404); res.end(); } }); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const post = (p: string, body: unknown) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it('/auth/ 밖 경로는 false(404)', async () => {
    expect((await fetch(base + '/other')).status).toBe(404);
  });

  it('status: 미설정 → configured:false, CORS 헤더', async () => {
    const r = await fetch(base + '/auth/status');
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(await r.json()).toEqual({ configured: false, oidc: false, serverName: 'T' });
  });

  it('OPTIONS 프리플라이트 → 204', async () => {
    const r = await fetch(base + '/auth/login', { method: 'OPTIONS' });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-headers')).toContain('content-type');
  });

  it('setup: 올바른 코드 → owner 생성+세션, 코드 소멸, 재시도 403', async () => {
    const code = ensureSetupCode(dir);
    const r = await post('/auth/setup', { code, loginId: 'boss', password: 'pw', displayName: 'Boss' });
    expect(r.status).toBe(200);
    const j = await r.json() as { token: string; user: { role: string } };
    expect(j.user.role).toBe('owner');
    expect(sessions.resolve(j.token)).toBeTruthy();
    expect(readSetupCode(dir)).toBeNull();
    expect(accounts.getByLoginId('boss')?.status).toBe('active');
    expect((await post('/auth/setup', { code, loginId: 'x', password: 'p' })).status).toBe(403);
  });

  it('setup: 틀린 코드 403 / 계정 있으면 403', async () => {
    ensureSetupCode(dir);
    expect((await post('/auth/setup', { code: 'wrong', loginId: 'a', password: 'p' })).status).toBe(403);
  });

  it('login: 성공 → token+user / 오답·무계정 → 균일 401 / pending·suspended → 403', async () => {
    accounts.createPassword('kim', 'pw', 'Kim', { status: 'active' });
    accounts.createPassword('wait', 'pw', 'Wait'); // pending
    const ok = await post('/auth/login', { loginId: 'kim', password: 'pw' });
    expect(ok.status).toBe(200);
    const j = await ok.json() as { token: string; user: { displayName: string } };
    expect(j.user.displayName).toBe('Kim');
    const bad = await post('/auth/login', { loginId: 'kim', password: 'x' });
    const none = await post('/auth/login', { loginId: 'ghost', password: 'x' });
    expect(bad.status).toBe(401);
    expect(none.status).toBe(401);
    expect(JSON.stringify(await bad.json())).toBe(JSON.stringify(await none.json())); // 균일 응답
    expect((await post('/auth/login', { loginId: 'wait', password: 'pw' })).status).toBe(403);
    expect((await post('/auth/login', { loginId: 'wait', password: 'pw' }).then(r => r.json()))).toEqual({ error: 'pending' });
  });

  it('register: pending 생성 / 중복 409 / engram 400', async () => {
    const r = await post('/auth/register', { loginId: 'lee', password: 'pw', displayName: 'Lee' });
    expect(r.status).toBe(200);
    expect(accounts.getByLoginId('lee')?.status).toBe('pending');
    expect((await post('/auth/register', { loginId: 'lee', password: 'pw', displayName: 'L2' })).status).toBe(409);
    expect((await post('/auth/register', { loginId: 'engram', password: 'pw', displayName: 'x' })).status).toBe(400);
  });

  it('logout: 세션 무효화 204', async () => {
    const a = accounts.createPassword('kim', 'pw', 'Kim', { status: 'active' });
    const s = sessions.issue(a.id);
    expect((await post('/auth/logout', { token: s.token })).status).toBe(204);
    expect(sessions.resolve(s.token)).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/auth/auth-http.spec.ts`
Expected: FAIL — `Cannot find module './auth-http'`

- [ ] **Step 3: 최소 구현**

```ts
// src/edge/auth/auth-http.ts
import type * as http from 'http';
import { AccountStore, Account } from './account-store';
import { SessionStore } from './session-store';
import type { AuthSettings } from './auth.config';
import { readSetupCode, clearSetupCode } from './setup-code';

// /auth/* http 창구(스펙 §2.3). 파싱/응답만 — 로직은 store에 위임. CORS 개방(*):
// 자격증명은 본문으로만 오가고 쿠키를 안 쓰므로 교차출처 허용이 안전하다(렌더러는 file://).

export interface AuthUserDto { id: string; displayName: string; role: 'owner' | 'member' }
export interface AuthHttpDeps {
  accounts: AccountStore; sessions: SessionStore; stateDir: string;
  settings: { load(): AuthSettings };
  delayMs?: number; // 실패 균일 지연(무차별 대입 완화). 기본 500ms, 테스트 0.
}

export function toUserDto(a: Account): AuthUserDto {
  return { id: a.id, displayName: a.displayName, role: a.role };
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += String(c); if (data.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(data) as unknown;
        resolve(j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, unknown> : {});
      } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

export class AuthHttp {
  constructor(private readonly deps: AuthHttpDeps) {}

  private json(res: http.ServerResponse, status: number, body?: unknown): void {
    res.writeHead(status, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }

  private async fail(res: http.ServerResponse, status: number, error: string): Promise<void> {
    await new Promise((r) => setTimeout(r, this.deps.delayMs ?? 500));
    this.json(res, status, { error });
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const url = (req.url ?? '').split('?')[0];
    if (!url.startsWith('/auth/')) return false;
    if (req.method === 'OPTIONS') { this.json(res, 204); return true; }
    const { accounts, sessions } = this.deps;

    if (req.method === 'GET' && url === '/auth/status') {
      const s = this.deps.settings.load();
      this.json(res, 200, {
        configured: accounts.count() > 0,
        oidc: !!s.oidc,
        ...(s.serverName ? { serverName: s.serverName } : {}),
      });
      return true;
    }

    if (req.method === 'POST' && url === '/auth/setup') {
      const b = await readBody(req);
      const code = readSetupCode(this.deps.stateDir);
      if (accounts.count() > 0 || !code || b.code !== code) { await this.fail(res, 403, 'setup'); return true; }
      try {
        const a = accounts.createPassword(String(b.loginId ?? ''), String(b.password ?? ''),
          String(b.displayName ?? b.loginId ?? ''), { role: 'owner', status: 'active' });
        clearSetupCode(this.deps.stateDir);
        this.json(res, 200, { token: sessions.issue(a.id).token, user: toUserDto(a) });
      } catch { await this.fail(res, 400, 'invalid'); }
      return true;
    }

    if (req.method === 'POST' && url === '/auth/login') {
      const b = await readBody(req);
      const a = accounts.verifyPassword(String(b.loginId ?? ''), String(b.password ?? ''));
      if (!a) { await this.fail(res, 401, 'invalid'); return true; }
      if (a.status !== 'active') { await this.fail(res, 403, a.status === 'pending' ? 'pending' : 'suspended'); return true; }
      this.json(res, 200, { token: sessions.issue(a.id).token, user: toUserDto(a) });
      return true;
    }

    if (req.method === 'POST' && url === '/auth/register') {
      const b = await readBody(req);
      try {
        accounts.createPassword(String(b.loginId ?? ''), String(b.password ?? ''), String(b.displayName ?? ''));
        this.json(res, 200, { pending: true });
      } catch (e) {
        if (String(e).includes('duplicate')) { await this.fail(res, 409, 'duplicate'); }
        else { await this.fail(res, 400, 'invalid'); }
      }
      return true;
    }

    if (req.method === 'POST' && url === '/auth/logout') {
      const b = await readBody(req);
      sessions.revoke(String(b.token ?? ''));
      this.json(res, 204);
      return true;
    }

    this.json(res, 404, { error: 'unknown' });
    return true;
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/auth/auth-http.spec.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/edge/auth/auth-http.ts src/edge/auth/auth-http.spec.ts
git commit -m "feat(phase16a): AuthHttp — status/setup/login/register/logout + CORS·균일 실패 지연"
```

---

### Task 5: OIDC 코어 — 디스커버리·교환·id_token 검증·PollStore

**Files:**
- Create: `src/edge/auth/oidc.ts`
- Test: `src/edge/auth/oidc.spec.ts`

**Interfaces:**
- Consumes: `OidcSettings`(T3).
- Produces:
  ```ts
  export class PollStore {
    create(): string;                                                     // 폴링 코드(32자 hex), TTL 10분
    complete(code: string, result: { token: string; user: AuthUserDto }): boolean;
    take(code: string): { status: 'pending' } | { status: 'done'; token: string; user: AuthUserDto } | null; // done은 1회 반환 후 소멸
  }
  export class OidcService {
    constructor(cfg: OidcSettings, fetchFn?: typeof fetch);
    authUrl(redirectUri: string, state: string): Promise<string>;        // 디스커버리 → authorization_endpoint URL
    exchange(code: string, redirectUri: string): Promise<{ issuer: string; sub: string; email?: string; name?: string }>;
  }
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

가짜 IdP: 디스커버리/JWKS/token 응답을 주입 fetch로 흉내. id_token은 테스트에서 실제 RSA 키로 서명.

```ts
// src/edge/auth/oidc.spec.ts
import { generateKeyPairSync, createSign } from 'crypto';
import { OidcService, PollStore } from './oidc';

const ISSUER = 'https://idp.example';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

function b64u(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}
function signIdToken(payload: Record<string, unknown>): string {
  const header = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1' }));
  const body = b64u(JSON.stringify(payload));
  const sig = createSign('RSA-SHA256').update(`${header}.${body}`).sign(privateKey);
  return `${header}.${body}.${b64u(sig)}`;
}

function fakeFetch(idToken: string): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u === `${ISSUER}/.well-known/openid-configuration`) {
      return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authz`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
    }
    if (u === `${ISSUER}/jwks`) {
      return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }] });
    }
    if (u === `${ISSUER}/token`) {
      expect(init?.method).toBe('POST');
      return json({ id_token: idToken });
    }
    throw new Error('unexpected url ' + u);
  }) as typeof fetch;
}

const CFG = { issuer: ISSUER, clientId: 'cid', clientSecret: 'sec' };

describe('OidcService', () => {
  it('authUrl: 디스커버리 기반 인가 URL(클라이언트·리다이렉트·state 포함)', async () => {
    const svc = new OidcService(CFG, fakeFetch('unused'));
    const url = new URL(await svc.authUrl('http://me/auth/oidc/callback', 'st1'));
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authz`);
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('http://me/auth/oidc/callback');
    expect(url.searchParams.get('state')).toBe('st1');
    expect(url.searchParams.get('scope')).toContain('openid');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('exchange: 서명·iss·aud·exp 검증 후 클레임 반환', async () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = signIdToken({ iss: ISSUER, aud: 'cid', exp: now + 600, sub: 'u1', email: 'a@b.c', name: 'Lee' });
    const svc = new OidcService(CFG, fakeFetch(tok));
    const r = await svc.exchange('authcode', 'http://me/cb');
    expect(r).toEqual({ issuer: ISSUER, sub: 'u1', email: 'a@b.c', name: 'Lee' });
  });

  it.each([
    ['잘못된 iss', { iss: 'https://evil', aud: 'cid', exp: 9999999999, sub: 'u1' }],
    ['잘못된 aud', { iss: ISSUER, aud: 'other', exp: 9999999999, sub: 'u1' }],
    ['만료', { iss: ISSUER, aud: 'cid', exp: 1, sub: 'u1' }],
  ])('exchange 거부: %s', async (_n, payload) => {
    const svc = new OidcService(CFG, fakeFetch(signIdToken(payload)));
    await expect(svc.exchange('c', 'http://me/cb')).rejects.toThrow();
  });

  it('exchange 거부: 서명 위조(본문 변조)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = signIdToken({ iss: ISSUER, aud: 'cid', exp: now + 600, sub: 'u1' });
    const [h, , s] = tok.split('.');
    const forged = `${h}.${b64u(JSON.stringify({ iss: ISSUER, aud: 'cid', exp: now + 600, sub: 'HACK' }))}.${s}`;
    const svc = new OidcService(CFG, fakeFetch(forged));
    await expect(svc.exchange('c', 'http://me/cb')).rejects.toThrow();
  });
});

describe('PollStore', () => {
  it('create→pending→complete→done 1회 반환 후 소멸', () => {
    const p = new PollStore();
    const code = p.create();
    expect(p.take(code)).toEqual({ status: 'pending' });
    expect(p.complete(code, { token: 't', user: { id: 'u', displayName: 'U', role: 'member' } })).toBe(true);
    expect(p.take(code)).toEqual({ status: 'done', token: 't', user: { id: 'u', displayName: 'U', role: 'member' } });
    expect(p.take(code)).toBeNull(); // 1회용
    expect(p.take('없음')).toBeNull();
    expect(p.complete('없음', { token: 't', user: { id: 'u', displayName: 'U', role: 'member' } })).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/auth/oidc.spec.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 최소 구현**

```ts
// src/edge/auth/oidc.ts
import { createPublicKey, createVerify, randomBytes } from 'crypto';
import type { OidcSettings } from './auth.config';
import type { AuthUserDto } from './auth-http';

// OIDC 인가 코드 흐름(스펙 §2.3). 디스커버리 → 인가 URL → 콜백 코드 교환 → id_token 서명·클레임 검증.
// 외부 라이브러리 없이 Node crypto(JWK import + RSA-SHA256 verify)로 검증한다.

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }

function b64uJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export class OidcService {
  private disco?: Discovery;
  constructor(
    private readonly cfg: OidcSettings,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async discover(): Promise<Discovery> {
    if (this.disco) return this.disco;
    const r = await this.fetchFn(`${this.cfg.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    if (!r.ok) throw new Error(`oidc discovery ${r.status}`);
    this.disco = await r.json() as Discovery;
    return this.disco;
  }

  async authUrl(redirectUri: string, state: string): Promise<string> {
    const d = await this.discover();
    const u = new URL(d.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.cfg.clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('state', state);
    return u.toString();
  }

  async exchange(code: string, redirectUri: string): Promise<{ issuer: string; sub: string; email?: string; name?: string }> {
    const d = await this.discover();
    const r = await this.fetchFn(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret,
      }).toString(),
    });
    if (!r.ok) throw new Error(`oidc token ${r.status}`);
    const body = await r.json() as { id_token?: string };
    if (!body.id_token) throw new Error('no id_token');
    const claims = await this.verifyIdToken(body.id_token, d);
    return {
      issuer: this.cfg.issuer, sub: String(claims.sub),
      ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
      ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
    };
  }

  private async verifyIdToken(idToken: string, d: Discovery): Promise<Record<string, unknown>> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('bad jwt');
    const header = b64uJson(parts[0]);
    const payload = b64uJson(parts[1]);
    const jwksRes = await this.fetchFn(d.jwks_uri);
    if (!jwksRes.ok) throw new Error(`jwks ${jwksRes.status}`);
    const jwks = await jwksRes.json() as { keys: Array<Record<string, unknown>> };
    const jwk = jwks.keys.find((k) => !header.kid || k.kid === header.kid) ?? jwks.keys[0];
    if (!jwk) throw new Error('no jwk');
    const key = createPublicKey({ key: jwk as unknown as import('crypto').JsonWebKey, format: 'jwk' });
    const ok = createVerify('RSA-SHA256')
      .update(`${parts[0]}.${parts[1]}`)
      .verify(key, Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new Error('bad signature');
    // aud는 문자열 또는 배열(표준 허용) — 둘 다 수용.
    const aud = payload.aud;
    const audOk = aud === this.cfg.clientId || (Array.isArray(aud) && aud.includes(this.cfg.clientId));
    if (payload.iss !== this.cfg.issuer) throw new Error('bad iss');
    if (!audOk) throw new Error('bad aud');
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) throw new Error('expired');
    if (!payload.sub) throw new Error('no sub');
    return payload;
  }
}

// 데스크톱 앱이 SSO 결과(세션)를 받아가는 1회용 폴링함(스펙 §2.3). 메모리 상주 — 재시작=진행중 SSO 무효(재시도).
interface PollEntry { exp: number; done?: { token: string; user: AuthUserDto } }

export class PollStore {
  private readonly map = new Map<string, PollEntry>();
  private readonly ttlMs = 10 * 60 * 1000;

  create(): string {
    const code = randomBytes(16).toString('hex');
    this.map.set(code, { exp: Date.now() + this.ttlMs });
    return code;
  }
  private live(code: string): PollEntry | null {
    const e = this.map.get(code);
    if (!e) return null;
    if (e.exp <= Date.now()) { this.map.delete(code); return null; }
    return e;
  }
  complete(code: string, result: { token: string; user: AuthUserDto }): boolean {
    const e = this.live(code);
    if (!e) return false;
    e.done = result;
    return true;
  }
  take(code: string): { status: 'pending' } | { status: 'done'; token: string; user: AuthUserDto } | null {
    const e = this.live(code);
    if (!e) return null;
    if (!e.done) return { status: 'pending' };
    this.map.delete(code); // 1회용
    return { status: 'done', token: e.done.token, user: e.done.user };
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/auth/oidc.spec.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/edge/auth/oidc.ts src/edge/auth/oidc.spec.ts
git commit -m "feat(phase16a): OIDC 코어 — 디스커버리·코드 교환·id_token 서명/클레임 검증·PollStore"
```

---

### Task 6: AuthHttp — OIDC 경로(begin/callback/poll)

**Files:**
- Modify: `src/edge/auth/auth-http.ts`
- Test: `src/edge/auth/auth-http.spec.ts` (describe 추가)

**Interfaces:**
- Consumes: `OidcService`/`PollStore`(T5), `OIDC_PRESETS`는 클라 몫이므로 여기선 안 씀.
- Produces: `AuthHttpDeps`에 추가 —
  ```ts
  makeOidc?: (o: OidcSettings) => OidcService; // 기본 new OidcService(o). 테스트가 가짜 주입.
  polls?: PollStore;                            // 기본 new PollStore()
  ```
  라우트: `POST /auth/oidc/begin` → `{ authUrl, pollCode }` | 503(oidc 미설정) ·
  `GET /auth/oidc/callback?code&state` → 200 text/html 안내 ·
  `GET /auth/oidc/poll?code` → 200 `{token,user}` | 202 | 404.

- [ ] **Step 1: 실패하는 테스트 추가**

`auth-http.spec.ts`에 describe 추가(기존 테스트 무변경):

```ts
import { OidcService, PollStore } from './oidc';

describe('AuthHttp(OIDC 경로)', () => {
  let dir: string; let server: http.Server; let base: string;
  let accounts: AccountStore; let sessions: SessionStore;
  const fakeOidc = {
    authUrl: async (_r: string, state: string) => `https://idp/authz?state=${state}`,
    exchange: async () => ({ issuer: 'https://idp', sub: 'u9', email: 'x@y.z', name: 'Nine' }),
  } as unknown as OidcService;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-'));
    accounts = new AccountStore(dir);
    sessions = new SessionStore(dir);
    const ah = new AuthHttp({
      accounts, sessions, stateDir: dir, delayMs: 0,
      settings: { load: () => ({ oidc: { issuer: 'https://idp', clientId: 'c', clientSecret: 's' } }) },
      makeOidc: () => fakeOidc, polls: new PollStore(),
    });
    server = http.createServer((req, res) => { void ah.handle(req, res); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('begin → authUrl+pollCode, 미설정이면 503', async () => {
    const r = await fetch(base + '/auth/oidc/begin', { method: 'POST' });
    expect(r.status).toBe(200);
    const j = await r.json() as { authUrl: string; pollCode: string };
    expect(j.authUrl).toContain('https://idp/authz?state=');
    expect(j.pollCode).toMatch(/^[0-9a-f]{32}$/);

    const ah2 = new AuthHttp({ accounts, sessions, stateDir: dir, delayMs: 0, settings: { load: () => ({}) } });
    const s2 = http.createServer((req, res) => { void ah2.handle(req, res); });
    await new Promise<void>((r2) => s2.listen(0, '127.0.0.1', r2));
    const a2 = s2.address();
    const r2 = await fetch(`http://127.0.0.1:${typeof a2 === 'object' && a2 ? a2.port : 0}/auth/oidc/begin`, { method: 'POST' });
    expect(r2.status).toBe(503);
    await new Promise<void>((r3) => s2.close(() => r3()));
  });

  it('첫 SSO 로그인: callback → pending 계정 생성, poll은 403 pending', async () => {
    const { pollCode, authUrl } = await (await fetch(base + '/auth/oidc/begin', { method: 'POST' })).json() as { authUrl: string; pollCode: string };
    const state = new URL(authUrl).searchParams.get('state')!;
    const cb = await fetch(base + `/auth/oidc/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(200);
    expect(accounts.getByOidc('https://idp', 'u9')?.status).toBe('pending');
    const p = await fetch(base + `/auth/oidc/poll?code=${pollCode}`);
    expect(p.status).toBe(403); // pending — 승인 대기
    expect(await p.json()).toEqual({ error: 'pending' });
  });

  it('승인된 SSO 계정: callback→poll로 세션 수령, poll 1회용', async () => {
    const acc = accounts.createOidc({ issuer: 'https://idp', sub: 'u9', displayName: 'Nine' });
    accounts.setStatus(acc.id, 'active');
    const { pollCode, authUrl } = await (await fetch(base + '/auth/oidc/begin', { method: 'POST' })).json() as { authUrl: string; pollCode: string };
    const state = new URL(authUrl).searchParams.get('state')!;
    await fetch(base + `/auth/oidc/callback?code=abc&state=${state}`);
    const p = await fetch(base + `/auth/oidc/poll?code=${pollCode}`);
    expect(p.status).toBe(200);
    const j = await p.json() as { token: string; user: { id: string } };
    expect(j.user.id).toBe(acc.id);
    expect(sessions.resolve(j.token)?.userId).toBe(acc.id);
    expect((await fetch(base + `/auth/oidc/poll?code=${pollCode}`)).status).toBe(404);
  });

  it('state 불일치 콜백은 400', async () => {
    expect((await fetch(base + '/auth/oidc/callback?code=abc&state=forged')).status).toBe(400);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/auth/auth-http.spec.ts`
Expected: FAIL — begin 404 등

- [ ] **Step 3: 구현**

`auth-http.ts` 수정 — deps 확장과 라우트 추가:

```ts
// import 추가
import { OidcService, PollStore } from './oidc';
import type { OidcSettings } from './auth.config';

// AuthHttpDeps에 추가:
//   makeOidc?: (o: OidcSettings) => OidcService;
//   polls?: PollStore;

// 클래스 필드/생성자:
export class AuthHttp {
  private readonly polls: PollStore;
  // state → pollCode 매핑(CSRF 검증 — 우리가 만든 state만 콜백 수용). 메모리 상주.
  private readonly states = new Map<string, string>();
  constructor(private readonly deps: AuthHttpDeps) {
    this.polls = deps.polls ?? new PollStore();
  }
  // ... 기존 메서드 유지 ...

  // handle() 스위치에 추가(기존 404 폴스루 앞):
  //
  // if (req.method === 'POST' && url === '/auth/oidc/begin') {
  //   const o = this.deps.settings.load().oidc;
  //   if (!o) { this.json(res, 503, { error: 'oidc not configured' }); return true; }
  //   const svc = (this.deps.makeOidc ?? ((c: OidcSettings) => new OidcService(c)))(o);
  //   const pollCode = this.polls.create();
  //   const state = randomBytes(16).toString('hex');       // crypto import 추가
  //   this.states.set(state, pollCode);
  //   const proto = String(req.headers['x-forwarded-proto'] ?? 'http');
  //   const redirectUri = `${proto}://${String(req.headers.host)}/auth/oidc/callback`;
  //   try {
  //     this.json(res, 200, { authUrl: await svc.authUrl(redirectUri, state), pollCode });
  //   } catch (e) { this.json(res, 502, { error: 'idp unreachable' }); }
  //   return true;
  // }
  //
  // if (req.method === 'GET' && url === '/auth/oidc/callback') {
  //   const q = new URL(req.url ?? '', 'http://x').searchParams;
  //   const state = q.get('state') ?? ''; const code = q.get('code') ?? '';
  //   const pollCode = this.states.get(state);
  //   if (!pollCode || !code) { this.json(res, 400, { error: 'bad state' }); return true; }
  //   this.states.delete(state); // 1회용
  //   const o = this.deps.settings.load().oidc;
  //   if (!o) { this.json(res, 503, { error: 'oidc not configured' }); return true; }
  //   const svc = (this.deps.makeOidc ?? ((c: OidcSettings) => new OidcService(c)))(o);
  //   try {
  //     const proto = String(req.headers['x-forwarded-proto'] ?? 'http');
  //     const claims = await svc.exchange(code, `${proto}://${String(req.headers.host)}/auth/oidc/callback`);
  //     let acc = this.deps.accounts.getByOidc(claims.issuer, claims.sub);
  //     if (!acc) acc = this.deps.accounts.createOidc({ issuer: claims.issuer, sub: claims.sub, email: claims.email, displayName: claims.name ?? claims.email ?? claims.sub });
  //     if (acc.status === 'active') {
  //       this.polls.complete(pollCode, { token: this.deps.sessions.issue(acc.id).token, user: toUserDto(acc) });
  //     } else {
  //       this.polls.complete(pollCode, { token: '', user: toUserDto(acc) }); // 빈 토큰 = pending 표식
  //     }
  //     res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  //     res.end('<html><body>Signed in. Return to the Engram app. / 로그인 완료 — Engram 앱으로 돌아가세요.</body></html>');
  //   } catch { this.json(res, 502, { error: 'exchange failed' }); }
  //   return true;
  // }
  //
  // if (req.method === 'GET' && url === '/auth/oidc/poll') {
  //   const q = new URL(req.url ?? '', 'http://x').searchParams;
  //   const r = this.polls.take(q.get('code') ?? '');
  //   if (!r) { this.json(res, 404, { error: 'unknown' }); return true; }
  //   if (r.status === 'pending') { this.json(res, 202, { pending: true }); return true; }
  //   if (!r.token) { this.json(res, 403, { error: 'pending' }); return true; } // 계정 승인 대기
  //   this.json(res, 200, { token: r.token, user: r.user });
  //   return true;
  // }
}
```

위 주석 블록을 실제 코드로 반영한다(주석 아님). `crypto`의 `randomBytes` import를 추가한다.

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/auth/auth-http.spec.ts src/edge/auth/oidc.spec.ts`
Expected: PASS 전부

- [ ] **Step 5: 커밋**

```bash
git add src/edge/auth/auth-http.ts src/edge/auth/auth-http.spec.ts
git commit -m "feat(phase16a): AuthHttp OIDC — begin/callback/poll, state 1회용·pending 분기"
```

---

### Task 7: 프로토콜 확장 + adapter 세션 게이트·authorId 서버 스탬프

**Files:**
- Modify: `shared/protocol.ts`
- Modify: `src/edge/messenger/chat-store.ts:114-130` (appendMessage에 `authorName` 통과)
- Modify: `src/edge/messenger/self.adapter.ts`
- Test: `src/edge/messenger/self.adapter.spec.ts` (describe 추가 + Phase 13 공유 토큰 테스트를 세션 방식으로 치환)

**Interfaces:**
- Consumes: `AccountStore`/`Account`(T1), `SessionStore`(T2), `AuthHttp`(T4).
- Produces:
  ```ts
  // shared/protocol.ts 추가
  export interface UserDto { id: string; displayName: string; role: 'owner' | 'member' }
  export interface AdminUserDto extends UserDto { loginId: string; status: 'pending' | 'active' | 'suspended'; createdAt: string; sso: boolean }
  export interface AdminSettings { serverName?: string; oidc?: { issuer: string; clientId: string; clientSecret: string } }
  // Message에 authorName?: string 추가. send 프레임의 authorId?는 이번 태스크에선 유지(서버가 무시) — 제거는 Task 14.
  // ServerFrame에 | { t: 'authOk'; user: UserDto } 추가(admin 프레임은 Task 8).
  // self.adapter
  export interface AuthDeps {
    accounts: AccountStore; sessions: SessionStore; http: AuthHttp;
    settings: { load(): AuthSettings; save(s: AuthSettings): void };
  }
  // SelfMessenger 생성자 5번째 인자: authDeps?: AuthDeps
  // SelfMessenger.kickUser(userId: string): void
  ```
  규칙: `authDeps` 미주입=무인증(현행 무토큰과 동일 — 테스트·brain 모드), 주입=모든 소켓 세션 필수.
  `cfg.token` 분기는 삭제(공유 토큰 폐기 — ChatConfig 필드 제거는 Task 14).

- [ ] **Step 1: 실패하는 테스트 작성**

`self.adapter.spec.ts`의 기존 "Phase 13 토큰 인증" describe를 아래 세션 describe로 **대체**한다(무토큰·무authDeps 경로 테스트는 그대로 두면 통과 유지). 테스트 파일 상단에 필요한 import 추가:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AccountStore } from '../auth/account-store';
import { SessionStore } from '../auth/session-store';
import { AuthHttp } from '../auth/auth-http';
import type { AuthDeps } from './self.adapter';

function makeAuthDeps(dir: string): AuthDeps {
  const accounts = new AccountStore(dir);
  const sessions = new SessionStore(dir);
  const http = new AuthHttp({ accounts, sessions, stateDir: dir, settings: { load: () => ({}) }, delayMs: 0 });
  return { accounts, sessions, http, settings: { load: () => ({}), save: () => {} } };
}

describe('세션 인증(Phase 16a)', () => {
  // 기존 spec의 서버 기동 헬퍼(포트 0 + addressPort) 관례를 그대로 사용한다.
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('유효 세션 auth → authOk(user) + 정상 처리', async () => {
    const deps = makeAuthDeps(dir);
    const acc = deps.accounts.createPassword('kim', 'pw', 'Kim', { status: 'active' });
    const sess = deps.sessions.issue(acc.id);
    // 서버 생성: new SelfMessenger(cfg(port:0), store, {logger}, undefined, deps) → start()
    // 클라 ws 접속 → {t:'auth', token: sess.token} 전송
    // 기대: {t:'authOk', user:{id:acc.id, displayName:'Kim', role:'member'}} 수신
    // 이후 {t:'channels'} 요청 → {t:'channels'} 응답 수신
  });

  it('무효/만료 세션 → authErr + 종료', async () => {
    const deps = makeAuthDeps(dir);
    // {t:'auth', token:'wrong'} → {t:'authErr'} 후 close 대기
  });

  it('suspended 계정 세션 → authErr', async () => {
    const deps = makeAuthDeps(dir);
    const acc = deps.accounts.createPassword('kim', 'pw', 'Kim', { status: 'active' });
    const sess = deps.sessions.issue(acc.id);
    deps.accounts.setStatus(acc.id, 'suspended');
    // auth → authErr
  });

  it('send의 작성자는 서버가 세션에서 스탬프(클라 authorId 주장 무시)', async () => {
    const deps = makeAuthDeps(dir);
    const acc = deps.accounts.createPassword('kim', 'pw', 'Kim', { status: 'active' });
    // 인증 후 {t:'send', channelId, text:'hi', authorId:'사칭engram'} 전송
    // 브로드캐스트 msg의 message.authorId === acc.id, message.authorName === 'Kim'
  });

  it('/auth/ http는 AuthHttp로 위임(status 200), 헬스 프로브는 기존대로', async () => {
    // http.get(`http://127.0.0.1:${port}/auth/status`) → 200 {configured:false,...}
    // http.get('/') → 200 {ok:true}
  });

  it('kickUser: 그 사용자 소켓 즉시 종료', async () => {
    // 인증된 소켓 확보 → adapter.kickUser(acc.id) → 소켓 close 이벤트 수신
  });

  it('authDeps 미주입 = 무인증 통과(현행) + authorId owner 고정', async () => {
    // 기존 무토큰 테스트와 동일 경로. send에 authorId:'x' 줘도 msg.authorId==='owner'
  });
});
```

(위 골격의 주석 부분은 기존 spec 파일의 ws 연결 헬퍼 관례 — `new WebSocket(...)`, 메시지 수집 배열, `await` 폴링 — 로 완성한다. 기존 파일에 이미 같은 패턴의 테스트가 있으니 그대로 따른다.)

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: FAIL — `authOk` 미발신·AuthDeps 미존재 등

- [ ] **Step 3: 구현**

`shared/protocol.ts`:

```ts
// Message에 필드 추가
export interface Message {
  id: string;
  authorId: string; // 'engram' | 계정 id | 'owner'(무인증 모드)
  authorName?: string; // 작성 시점 표시이름(서버 스탬프) — 렌더용
  text: string;
  ts: string;
  threadId?: string;
  actions?: Action[];
}

export interface UserDto { id: string; displayName: string; role: 'owner' | 'member' }
export interface AdminUserDto extends UserDto { loginId: string; status: 'pending' | 'active' | 'suspended'; createdAt: string; sso: boolean }
export interface AdminSettings { serverName?: string; oidc?: { issuer: string; clientId: string; clientSecret: string } }

// ServerFrame에 추가:
//  | { t: 'authOk'; user: UserDto }
```

`chat-store.ts` — `appendMessage` input에 `authorName?: string` 추가하고 msg 생성에 `...(input.authorName ? { authorName: input.authorName } : {})` 스프레드 한 줄.

`self.adapter.ts`:

```ts
// import 추가
import type { AccountStore, Account } from '../auth/account-store';
import type { SessionStore } from '../auth/session-store';
import type { AuthHttp } from '../auth/auth-http';
import type { AuthSettings } from '../auth/auth.config';

export interface AuthDeps {
  accounts: AccountStore; sessions: SessionStore; http: AuthHttp;
  settings: { load(): AuthSettings; save(s: AuthSettings): void };
}

// 클래스 필드 추가:
//   private users = new Map<WebSocket, Account>(); // 인증 소켓 → 계정(세션 모드)
// 생성자 5번째 인자:
//   private readonly authDeps?: AuthDeps,

// start()의 http.createServer 콜백 최상단에 /auth/ 위임:
//   if (this.authDeps && (req.url ?? '').startsWith('/auth/')) {
//     void this.authDeps.http.handle(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch { /* 격리 */ } });
//     return;
//   }

// wss.on('connection') 게이트 교체(cfg.token 분기 삭제):
//   if (!this.authDeps) {
//     this.authed.add(ws); // 무인증(테스트·brain 모드) — 현행 무토큰과 동일
//   } else {
//     const timer = setTimeout(() => { ...기존 authErr+close 동일... }, 5000);
//     ws.once('close', () => { clearTimeout(timer); this.users.delete(ws); });
//   }

// handleFrame의 인증 게이트 교체:
//   if (this.authDeps && !this.authed.has(ws)) {
//     const sess = f?.t === 'auth' && typeof f.token === 'string' ? this.authDeps.sessions.resolve(f.token) : null;
//     const acc = sess ? this.authDeps.accounts.get(sess.userId) : null;
//     if (acc && acc.status === 'active') {
//       this.authed.add(ws);
//       this.users.set(ws, acc);
//       this.sendTo(ws, { t: 'authOk', user: { id: acc.id, displayName: acc.displayName, role: acc.role } });
//     } else {
//       this.sendTo(ws, { t: 'authErr' });
//       try { ws.close(); } catch { /* 격리 */ }
//     }
//     return;
//   }

// onSend의 작성자 결정 교체(자가선언+engram 강등 삭제):
//   const me = this.users.get(ws);
//   const msg = this.store.appendMessage(channelId, {
//     authorId: me ? me.id : 'owner',
//     ...(me ? { authorName: me.displayName } : {}),
//     text,
//     threadId: ...기존...,
//   });

// 메서드 추가:
//   kickUser(userId: string): void {
//     for (const [ws, acc] of this.users) {
//       if (acc.id === userId) { try { ws.close(); } catch { /* 격리 */ } this.users.delete(ws); }
//     }
//   }
```

주석 블록을 실제 코드로 반영한다. `MentionEvent.authorId`는 `msg.authorId`(계정 id) 그대로 — 두뇌 쪽 정책(`engram` 비교)은 계정 id와 충돌하지 않는다.

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts && npm test`
Expected: 신규 PASS + 전체 회귀 통과(공유 토큰 테스트는 치환됨)

- [ ] **Step 5: 커밋**

```bash
git add shared/protocol.ts src/edge/messenger/chat-store.ts src/edge/messenger/self.adapter.ts src/edge/messenger/self.adapter.spec.ts
git commit -m "feat(phase16a): ws 세션 게이트·authOk·authorId 서버 스탬프 — 공유 토큰 게이트 대체"
```

---

### Task 8: adapter admin 프레임(owner 전용)

**Files:**
- Modify: `shared/protocol.ts` (admin 프레임)
- Modify: `src/edge/messenger/self.adapter.ts`
- Test: `src/edge/messenger/self.adapter.spec.ts` (describe 추가)

**Interfaces:**
- Consumes: T7의 `users` 맵·`kickUser`·`AuthDeps`.
- Produces(프로토콜):
  ```ts
  // ClientFrame 추가
  | { t: 'adminUsers' }
  | { t: 'adminApprove'; id: string }
  | { t: 'adminSuspend'; id: string }
  | { t: 'adminRestore'; id: string }
  | { t: 'adminResetPassword'; id: string; password: string }
  | { t: 'adminForceLogout'; id: string }
  | { t: 'adminGetSettings' }
  | { t: 'adminSetSettings'; settings: AdminSettings }
  // ServerFrame 추가
  | { t: 'adminUsers'; list: AdminUserDto[] }
  | { t: 'adminSettings'; settings: AdminSettings }
  ```
  규칙: owner 세션이 아닌 소켓의 admin 프레임은 **조용히 무시**. 변이 후엔 그 소켓에 최신 `adminUsers`를 재전송. `adminSuspend`는 owner 대상이면 무시(잠금 방지). suspend·forceLogout은 `sessions.revokeAllFor`+`kickUser`.

- [ ] **Step 1: 실패하는 테스트 추가**

```ts
describe('admin 프레임(Phase 16a)', () => {
  // makeAuthDeps 재사용. owner 계정 + member 계정 만들고 각각 세션으로 두 소켓 인증.

  it('owner: adminUsers → 전체 목록(AdminUserDto)', async () => {
    // owner 소켓이 {t:'adminUsers'} → {t:'adminUsers', list:[...]} 수신, list에 loginId/status/sso 포함
  });

  it('member의 admin 프레임은 무시(응답 없음)', async () => {
    // member 소켓이 {t:'adminUsers'} 전송 → 일정 시간 내 adminUsers 미수신
  });

  it('adminApprove: pending→active + 목록 재전송', async () => {});

  it('adminSuspend: active→suspended + 그 사용자 소켓 끊김 + 세션 무효', async () => {
    // member 소켓 인증 상태에서 owner가 suspend → member 소켓 close 수신,
    // deps.sessions.resolve(memberToken) === null
  });

  it('adminSuspend: owner 대상은 무시(자기 잠금 방지)', async () => {});

  it('adminRestore·adminResetPassword·adminForceLogout 동작', async () => {
    // restore: suspended→active / resetPassword 후 verifyPassword(new) OK / forceLogout: 세션 무효+소켓 close
  });

  it('adminGetSettings/adminSetSettings: settings.load/save 위임', async () => {
    // save 스파이로 전달값 확인, get → {t:'adminSettings', settings}
  });
});
```

(연결·인증 헬퍼는 Task 7 테스트와 동일 관례로 완성.)

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: FAIL — admin 프레임 무시됨

- [ ] **Step 3: 구현**

`shared/protocol.ts`에 위 프레임 추가. `self.adapter.ts`의 `handleFrame` switch에 추가:

```ts
// case 문 앞부분에 공통 게이트:
//   admin 프레임 집합이면 → const me = this.users.get(ws); if (!this.authDeps || me?.role !== 'owner') return;
// (별도 helper: private adminGate(ws): boolean)

private adminList(): AdminUserDto[] {
  return this.authDeps!.accounts.list().map((a) => ({
    id: a.id, displayName: a.displayName, role: a.role,
    loginId: a.loginId, status: a.status, createdAt: a.createdAt, sso: !!a.oidc,
  }));
}

// case 'adminUsers': this.sendTo(ws, { t: 'adminUsers', list: this.adminList() }); return;
// case 'adminApprove': if (typeof f.id === 'string') { const t = this.authDeps!.accounts.get(f.id); if (t?.status === 'pending') this.authDeps!.accounts.setStatus(f.id, 'active'); } this.sendTo(ws, { t: 'adminUsers', list: this.adminList() }); return;
// case 'adminSuspend': if (typeof f.id === 'string') { const t = this.authDeps!.accounts.get(f.id); if (t && t.role !== 'owner') { this.authDeps!.accounts.setStatus(f.id, 'suspended'); this.authDeps!.sessions.revokeAllFor(f.id); this.kickUser(f.id); } } this.sendTo(ws, { t: 'adminUsers', list: this.adminList() }); return;
// case 'adminRestore': if (typeof f.id === 'string') { const t = this.authDeps!.accounts.get(f.id); if (t?.status === 'suspended') this.authDeps!.accounts.setStatus(f.id, 'active'); } this.sendTo(ws, { t: 'adminUsers', list: this.adminList() }); return;
// case 'adminResetPassword': if (typeof f.id === 'string' && typeof f.password === 'string' && f.password) this.authDeps!.accounts.setPassword(f.id, f.password); this.sendTo(ws, { t: 'adminUsers', list: this.adminList() }); return;
// case 'adminForceLogout': if (typeof f.id === 'string') { this.authDeps!.sessions.revokeAllFor(f.id); this.kickUser(f.id); } this.sendTo(ws, { t: 'adminUsers', list: this.adminList() }); return;
// case 'adminGetSettings': this.sendTo(ws, { t: 'adminSettings', settings: this.authDeps!.settings.load() }); return;
// case 'adminSetSettings': if (f.settings && typeof f.settings === 'object') this.authDeps!.settings.save(f.settings as AdminSettings); this.sendTo(ws, { t: 'adminSettings', settings: this.authDeps!.settings.load() }); return;
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts && npm test`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add shared/protocol.ts src/edge/messenger/self.adapter.ts src/edge/messenger/self.adapter.spec.ts
git commit -m "feat(phase16a): admin 프레임 — 승인/정지/복구/비번리셋/강제로그아웃/설정, owner 전용"
```

---

### Task 9: 실행 모드(role) + src/main.ts 서버 배선

**Files:**
- Modify: `src/edge/messenger/chat.config.ts` (`role` 추가)
- Modify: `src/edge/messenger/self.adapter.ts` (brain 모드 team 채널 거부 1줄)
- Modify: `src/main.ts` (auth 스토어 생성·주입·setup-code 로그·brain 게이트)
- Test: `src/edge/messenger/chat.config.spec.ts`(있으면 추가, 없으면 생성), `src/edge/messenger/self.adapter.spec.ts`(team 거부 1건)

**Interfaces:**
- Produces: `ChatConfig.role: 'server' | 'brain'`(기본 `'server'`, env `ENGRAM_CHAT_ROLE`). `role==='brain'`이면 `bind`는 무조건 `'127.0.0.1'`.

- [ ] **Step 1: 실패하는 테스트**

```ts
// chat.config.spec.ts에 추가
it('role: 기본 server, env/파일 brain, brain은 bind 강제 127.0.0.1', () => {
  expect(loadChatConfig(dir).role).toBe('server');
  fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ role: 'brain', bind: '0.0.0.0' }));
  const c = loadChatConfig(dir);
  expect(c.role).toBe('brain');
  expect(c.bind).toBe('127.0.0.1'); // brain은 원격 노출 불가
  expect(loadChatConfig(dir, { ENGRAM_CHAT_ROLE: 'brain' } as NodeJS.ProcessEnv).role).toBe('brain');
});
```

```ts
// self.adapter.spec.ts에 추가
it('brain 모드: team 채널 생성 무시', async () => {
  // cfg { ...port0, role:'brain' } 서버 → createChannel {mode:'team'} → 채널 목록에 team 없음
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/chat.config.spec.ts src/edge/messenger/self.adapter.spec.ts`
Expected: FAIL

- [ ] **Step 3: 구현**

`chat.config.ts`:

```ts
export interface ChatConfig {
  enabled: boolean; port: number; bind: string; language?: string;
  token?: string; // Task 14에서 제거
  role: 'server' | 'brain'; // brain=계정·team·위키승인 없음, 127.0.0.1 고정(스펙 §2.1)
}
// loadChatConfig 내:
const role = (env.ENGRAM_CHAT_ROLE === 'brain' || raw.role === 'brain') ? 'brain' : 'server';
const bind = role === 'brain' ? '127.0.0.1' : /* 기존 bind 계산 */;
return { enabled: raw.enabled !== false, port, bind, language, token, role };
```

`self.adapter.ts`의 `createChannel` case에 게이트:

```ts
case 'createChannel':
  if (this.cfg.role === 'brain' && f.mode === 'team') return; // brain=개인 연산용, 팀 방 없음
  ...기존...
```

`src/main.ts`의 self 생성부 교체:

```ts
import { AccountStore } from './edge/auth/account-store';
import { SessionStore } from './edge/auth/session-store';
import { AuthHttp } from './edge/auth/auth-http';
import { loadAuthSettings, saveAuthSettings } from './edge/auth/auth.config';
import { ensureSetupCode } from './edge/auth/setup-code';
import type { AuthDeps } from './edge/messenger/self.adapter';

// if (chatCfg.enabled) 블록:
const isServer = chatCfg.role !== 'brain';
chatStore = new ChatStore(path.join(paths.getStateDir(), 'chat'));
let authDeps: AuthDeps | undefined;
if (isServer) {
  const accounts = new AccountStore(paths.getStateDir());
  const sessions = new SessionStore(paths.getStateDir());
  const settings = {
    load: () => loadAuthSettings(paths.getConfigDir()),
    save: (s: ReturnType<typeof loadAuthSettings>) => saveAuthSettings(paths.getConfigDir(), s),
  };
  const authHttp = new AuthHttp({ accounts, sessions, stateDir: paths.getStateDir(), settings });
  authDeps = { accounts, sessions, http: authHttp, settings };
  if (accounts.count() === 0) {
    logger.log(`서버 미설정 — 초기 설정 코드: ${ensureSetupCode(paths.getStateDir())}`, 'Auth');
  }
}
self = new SelfMessenger(chatCfg, chatStore, { logger },
  isServer ? { wiki: app.get(WikiEngine), proposals: app.get(ProposalStore), applier: app.get(ProposalApplier) } : undefined,
  authDeps);
```

- [ ] **Step 4: 통과 확인**

Run: `npm test && npm run build`
Expected: 전체 PASS, tsc 클린

- [ ] **Step 5: 커밋**

```bash
git add src/edge/messenger/chat.config.ts src/edge/messenger/chat.config.spec.ts src/edge/messenger/self.adapter.ts src/edge/messenger/self.adapter.spec.ts src/main.ts
git commit -m "feat(phase16a): 실행 모드 role(server/brain) + 상주 배선 — brain은 계정·team 미탑재·루프백 고정"
```

---

### Task 10: renderer — sessions 저장소 + auth-api

**Files:**
- Create: `renderer/src/sessions.ts`, `renderer/src/auth-api.ts`
- Test: `renderer/src/sessions.test.ts`, `renderer/src/auth-api.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // sessions.ts — localStorage 'engram.sessions' = Record<connId, sessionToken>
  export function loadSessions(): Record<string, string>;
  export function saveSessionFor(connId: string, token: string): Record<string, string>; // 저장 후 새 맵 반환
  export function clearSessionFor(connId: string): Record<string, string>;
  // auth-api.ts
  export function httpBase(endpoint: string): string; // ws://→http://, wss://→https://
  export interface AuthStatus { configured: boolean; oidc: boolean; serverName?: string }
  export async function fetchStatus(endpoint: string): Promise<AuthStatus | null>; // 404/네트워크 실패 = null(무인증 서버)
  export async function apiLogin(endpoint: string, loginId: string, password: string): Promise<{ token: string; user: UserDto } | { error: string }>;
  export async function apiRegister(endpoint: string, loginId: string, password: string, displayName: string): Promise<{ ok: true } | { error: string }>;
  export async function apiSetup(endpoint: string, code: string, loginId: string, password: string): Promise<{ token: string; user: UserDto } | { error: string }>;
  export async function apiOidcBegin(endpoint: string): Promise<{ authUrl: string; pollCode: string } | { error: string }>;
  export async function apiOidcPoll(endpoint: string, pollCode: string): Promise<{ token: string; user: UserDto } | { pending: true } | { error: string }>;
  ```

- [ ] **Step 1: 실패하는 테스트**

```ts
// renderer/src/sessions.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { loadSessions, saveSessionFor, clearSessionFor } from './sessions';

describe('sessions', () => {
  beforeEach(() => localStorage.clear());
  it('저장·로드·삭제 왕복', () => {
    expect(loadSessions()).toEqual({});
    const m = saveSessionFor('c1', 'tok1');
    expect(m).toEqual({ c1: 'tok1' });
    expect(loadSessions()).toEqual({ c1: 'tok1' });
    expect(clearSessionFor('c1')).toEqual({});
  });
  it('손상 저장소 → 빈 맵', () => {
    localStorage.setItem('engram.sessions', '{bad');
    expect(loadSessions()).toEqual({});
  });
});
```

```ts
// renderer/src/auth-api.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { httpBase, fetchStatus, apiLogin } from './auth-api';

describe('auth-api', () => {
  afterEach(() => vi.restoreAllMocks());
  it('httpBase: ws/wss → http/https', () => {
    expect(httpBase('ws://h:1')).toBe('http://h:1');
    expect(httpBase('wss://h/x/')).toBe('https://h/x');
  });
  it('fetchStatus: 200 → 상태 / 404·실패 → null', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    f.mockResolvedValueOnce(new Response(JSON.stringify({ configured: true, oidc: false }), { status: 200 }));
    expect(await fetchStatus('ws://h:1')).toEqual({ configured: true, oidc: false });
    f.mockResolvedValueOnce(new Response('nf', { status: 404 }));
    expect(await fetchStatus('ws://h:1')).toBeNull();
    f.mockRejectedValueOnce(new Error('net'));
    expect(await fetchStatus('ws://h:1')).toBeNull();
  });
  it('apiLogin: 200 → 세션 / 401 → error 코드', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    f.mockResolvedValueOnce(new Response(JSON.stringify({ token: 't', user: { id: 'u', displayName: 'U', role: 'member' } }), { status: 200 }));
    expect(await apiLogin('ws://h:1', 'a', 'b')).toMatchObject({ token: 't' });
    f.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid' }), { status: 401 }));
    expect(await apiLogin('ws://h:1', 'a', 'b')).toEqual({ error: 'invalid' });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run(renderer 폴더): `npx vitest run src/sessions.test.ts src/auth-api.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

```ts
// renderer/src/sessions.ts
// 연결별 세션 토큰(localStorage). 로그인하면 저장 — 매번 로그인하지 않는다(스펙 §2.5).
const KEY = 'engram.sessions';

export function loadSessions(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, string> : {};
  } catch { return {}; }
}
function save(m: Record<string, string>): Record<string, string> {
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* 무시 */ }
  return m;
}
export function saveSessionFor(connId: string, token: string): Record<string, string> {
  return save({ ...loadSessions(), [connId]: token });
}
export function clearSessionFor(connId: string): Record<string, string> {
  const m = { ...loadSessions() };
  delete m[connId];
  return save(m);
}
```

```ts
// renderer/src/auth-api.ts
import type { UserDto } from '../../shared/protocol';

// 두뇌 /auth/* http 창구 클라이언트. 실패는 { error } 값으로(throw 안 함 — UI 분기 단순화).

export function httpBase(endpoint: string): string {
  return endpoint.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/$/, '');
}

export interface AuthStatus { configured: boolean; oidc: boolean; serverName?: string }

async function jsonOrError<T>(p: Promise<Response>): Promise<T | { error: string }> {
  try {
    const r = await p;
    const body = await r.json().catch(() => ({}));
    if (r.ok) return body as T;
    return { error: typeof (body as { error?: string }).error === 'string' ? (body as { error: string }).error : `http ${r.status}` };
  } catch { return { error: 'network' }; }
}
const post = (endpoint: string, p: string, body: unknown) => fetch(httpBase(endpoint) + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

export async function fetchStatus(endpoint: string): Promise<AuthStatus | null> {
  try {
    const r = await fetch(httpBase(endpoint) + '/auth/status');
    if (!r.ok) return null; // 404 = 인증 미탑재(brain/구버전) → 게이트 없음
    return await r.json() as AuthStatus;
  } catch { return null; }
}
export const apiLogin = (e: string, loginId: string, password: string) =>
  jsonOrError<{ token: string; user: UserDto }>(post(e, '/auth/login', { loginId, password }));
export const apiRegister = async (e: string, loginId: string, password: string, displayName: string) => {
  const r = await jsonOrError<{ pending: true }>(post(e, '/auth/register', { loginId, password, displayName }));
  return 'error' in r ? r : { ok: true as const };
};
export const apiSetup = (e: string, code: string, loginId: string, password: string) =>
  jsonOrError<{ token: string; user: UserDto }>(post(e, '/auth/setup', { code, loginId, password }));
export const apiOidcBegin = (e: string) =>
  jsonOrError<{ authUrl: string; pollCode: string }>(post(e, '/auth/oidc/begin', {}));
export async function apiOidcPoll(e: string, pollCode: string): Promise<{ token: string; user: UserDto } | { pending: true } | { error: string }> {
  try {
    const r = await fetch(httpBase(e) + `/auth/oidc/poll?code=${encodeURIComponent(pollCode)}`);
    if (r.status === 202) return { pending: true };
    const body = await r.json().catch(() => ({}));
    if (r.ok) return body as { token: string; user: UserDto };
    return { error: typeof (body as { error?: string }).error === 'string' ? (body as { error: string }).error : `http ${r.status}` };
  } catch { return { error: 'network' }; }
}
```

- [ ] **Step 4: 통과 확인**

Run(renderer): `npx vitest run src/sessions.test.ts src/auth-api.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add renderer/src/sessions.ts renderer/src/auth-api.ts renderer/src/sessions.test.ts renderer/src/auth-api.test.ts
git commit -m "feat(phase16a): renderer 세션 저장소 + /auth API 클라이언트"
```

---

### Task 11: renderer — 소켓 인증을 세션으로(connections-client)

**Files:**
- Modify: `renderer/src/ws/connections-client.ts`
- Test: `renderer/src/ws/connections-client.test.ts` (토큰 테스트를 세션 방식으로 치환)

**Interfaces:**
- Produces: 시그니처 변경 —
  ```ts
  export function useConnections(
    connections: Connection[],
    sessions: Record<string, string>,       // connId → 세션 토큰
    onFrame: (connId: string, f: ServerFrame) => void,
    onOpen?: (connId: string) => void,
  ): { send: (connId: string, f: ClientFrame) => void; statusById: Record<string, boolean> };
  ```
  동작: open 시 `sessions[connId]` 있으면 `{t:'auth', token}` 전송. 세션 값이 바뀌면(로그인/로그아웃) 그 소켓 재접속. `authErr`는 기존대로 재연결 중단 + onFrame 전달(App이 게이트 처리).

- [ ] **Step 1: 실패하는 테스트 수정/추가**

기존 `connections-client.test.ts`의 "토큰" 케이스를 세션 인자 기반으로 바꾼다:

```ts
it('세션 있으면 open 직후 auth 프레임 선전송', async () => {
  // useConnections([conn], { [conn.id]: 'sess1' }, ...) → 가짜 서버가 auth 프레임 수신 확인
});
it('세션 변경 시 그 연결만 재접속', async () => {
  // rerender로 sessions 맵 값 교체 → 소켓 close→재open 확인
});
it('세션 없으면 auth 미전송(무인증 서버 대응)', async () => {});
```

(기존 파일의 가짜 ws 서버·rerender 관례 그대로.)

- [ ] **Step 2: 실패 확인**

Run(renderer): `npx vitest run src/ws/connections-client.test.ts`
Expected: FAIL — 시그니처 불일치

- [ ] **Step 3: 구현**

`connections-client.ts` 변경점:

```ts
// Slot.token → Slot.session 개명(의미 변화 반영).
// useConnections(connections, sessions, onFrame, onOpen):
//   const sessionsRef = useRef(sessions); sessionsRef.current = sessions;
//   const ids = connections.map((c) => `${c.id}:${sessions[c.id] ?? ''}`).join(','); // 세션 변경=재접속 트리거
//   슬롯 유지 판정: w && (sessions[id] ?? '') === (slot.session ?? '')
//   슬롯 생성: session: sessions[conn.id]
//   ws.onopen: const tok = sessionsRef.current[connId]; if (tok) ws.send(JSON.stringify({ t: 'auth', token: tok }));
// conn.token 참조는 모두 제거.
```

useEffect deps의 `ids`가 세션을 포함하므로 로그인 직후 자동 재접속된다.

- [ ] **Step 4: 통과 확인**

Run(renderer): `npx vitest run src/ws/connections-client.test.ts`
Expected: PASS (App.tsx가 아직 옛 시그니처면 이 시점 렌더러 전체 빌드는 깨질 수 있음 — Task 12에서 App을 맞춘다. vitest 단일 파일은 통과해야 함)

- [ ] **Step 5: App.tsx 호출부 최소 수정(컴파일 유지)**

```tsx
// App.tsx
import { loadSessions } from './sessions';
const [sessions, setSessions] = useState<Record<string, string>>(() => loadSessions());
const { send, statusById } = useConnections(connState.connections, sessions, onFrame, onOpen);
```

Run(renderer): `npx vitest run`
Expected: 전체 PASS

- [ ] **Step 6: 커밋**

```bash
git add renderer/src/ws/connections-client.ts renderer/src/ws/connections-client.test.ts renderer/src/App.tsx
git commit -m "feat(phase16a): 소켓 인증을 연결별 세션 토큰으로 — 로그인 시 자동 재접속"
```

---

### Task 12: renderer — LoginGate(로그인/가입/초기설정/SSO) + App 게이트

**Files:**
- Create: `renderer/src/components/LoginGate.tsx`
- Test: `renderer/src/components/LoginGate.test.tsx`
- Modify: `renderer/src/App.tsx`, `renderer/src/i18n.ts`, `renderer/src/desktop.d.ts`

**Interfaces:**
- Consumes: `fetchStatus/apiLogin/apiRegister/apiSetup/apiOidcBegin/apiOidcPoll`(T10), `saveSessionFor`(T10), `authOk`/`UserDto`(T7).
- Produces:
  ```tsx
  export function LoginGate(props: {
    connName: string;
    status: AuthStatus;                 // fetchStatus 결과(null이면 App이 게이트 자체를 안 띄움)
    setupCode?: string | null;          // 데스크톱 로컬 서버면 ipc로 자동 주입("내 서버 만들기")
    onLogin(loginId: string, password: string): void;
    onRegister(loginId: string, password: string, displayName: string): void;
    onSetup(code: string, loginId: string, password: string): void;
    onSso(): void;
    error?: string;                     // 'invalid' | 'pending' | 'suspended' | 'network' ...
    notice?: string;                    // 가입 신청 완료 안내 등
  }): JSX.Element;
  ```
  App 게이트 규칙: 기본 연결(defaultConnId)에 대해 ① 저장 세션 없음 && `fetchStatus`가 non-null → 게이트 표시(configured=false면 setup 폼) ② `authErr` 수신 → 세션 삭제+게이트 ③ `authOk` 수신 → `meByConn` 저장·게이트 해제. `fetchStatus`가 null(무인증 서버·brain)이면 게이트 없음(현행 동작).

- [ ] **Step 1: 실패하는 테스트**

```tsx
// renderer/src/components/LoginGate.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LoginGate } from './LoginGate';

const base = { connName: 'Local', onLogin: vi.fn(), onRegister: vi.fn(), onSetup: vi.fn(), onSso: vi.fn() };

describe('LoginGate', () => {
  it('미설정 서버 → setup 폼(코드·아이디·비밀번호), 제출 시 onSetup', () => {
    const onSetup = vi.fn();
    render(<LoginGate {...base} onSetup={onSetup} status={{ configured: false, oidc: false }} setupCode="abc" />);
    fireEvent.change(screen.getByPlaceholderText(/id/i), { target: { value: 'boss' } });
    fireEvent.change(screen.getByPlaceholderText(/password/i), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(onSetup).toHaveBeenCalledWith('abc', 'boss', 'pw'); // setupCode 자동 주입
  });

  it('설정된 서버 → 로그인 폼, oidc면 SSO 버튼', () => {
    render(<LoginGate {...base} status={{ configured: true, oidc: true, serverName: 'Team' }} />);
    expect(screen.getByText('Team')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/id/i), { target: { value: 'kim' } });
    fireEvent.change(screen.getByPlaceholderText(/password/i), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(base.onLogin).toHaveBeenCalledWith('kim', 'pw');
    fireEvent.click(screen.getByRole('button', { name: /sso/i }));
    expect(base.onSso).toHaveBeenCalled();
  });

  it('가입 전환 → onRegister / error=pending 안내 노출', () => {
    const onRegister = vi.fn();
    const r = render(<LoginGate {...base} onRegister={onRegister} status={{ configured: true, oidc: false }} />);
    fireEvent.click(screen.getByText(/register/i));
    fireEvent.change(screen.getByPlaceholderText(/id/i), { target: { value: 'lee' } });
    fireEvent.change(screen.getByPlaceholderText(/password/i), { target: { value: 'pw' } });
    fireEvent.change(screen.getByPlaceholderText(/display name/i), { target: { value: 'Lee' } });
    fireEvent.click(screen.getByRole('button', { name: /request/i }));
    expect(onRegister).toHaveBeenCalledWith('lee', 'pw', 'Lee');
    r.rerender(<LoginGate {...base} status={{ configured: true, oidc: false }} error="pending" />);
    expect(screen.getByText(/waiting for approval/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run(renderer): `npx vitest run src/components/LoginGate.test.tsx`
Expected: FAIL — 컴포넌트 없음

- [ ] **Step 3: 구현**

`i18n.ts`에 추가(영어 기본/ko):

```ts
// Phase 16a — 계정
signIn: ko ? '로그인' : 'Sign in',
signInTitle: (name: string) => (ko ? `${name}에 로그인` : `Sign in to ${name}`),
loginIdPh: ko ? '아이디' : 'ID',
passwordPh: ko ? '비밀번호' : 'Password',
displayNameFieldPh: ko ? '표시 이름' : 'Display name',
registerLink: ko ? '가입 신청' : 'Register',
registerBtn: ko ? '가입 요청' : 'Request access',
backToLogin: ko ? '로그인으로' : 'Back to sign in',
ssoBtn: ko ? 'SSO로 로그인' : 'Sign in with SSO',
setupTitle: ko ? '내 서버 만들기' : 'Create your server',
setupCodePh: ko ? '설정 코드(서버 로그 참조)' : 'Setup code (see server log)',
setupBtn: ko ? '생성' : 'Create',
errInvalid: ko ? '아이디 또는 비밀번호가 올바르지 않아요' : 'Incorrect ID or password',
errPending: ko ? '가입 승인 대기 중이에요' : 'Waiting for approval',
errSuspended: ko ? '정지된 계정이에요' : 'This account is suspended',
errNetwork: ko ? '서버에 연결할 수 없어요' : 'Cannot reach the server',
registered: ko ? '가입 신청 완료 — 승인되면 로그인할 수 있어요' : 'Requested — you can sign in once approved',
```

```tsx
// renderer/src/components/LoginGate.tsx
import { useState } from 'react';
import type { AuthStatus } from '../auth-api';
import { T } from '../i18n';

// 앱 로그인 게이트(스펙 §2.5). 미설정 서버=setup 폼("내 서버 만들기"), 설정됨=로그인/가입.
// 순수 UI — 호출은 App이 콜백으로. XSS: 전부 React 텍스트 노드.
export function LoginGate(props: {
  connName: string; status: AuthStatus; setupCode?: string | null;
  onLogin: (loginId: string, password: string) => void;
  onRegister: (loginId: string, password: string, displayName: string) => void;
  onSetup: (code: string, loginId: string, password: string) => void;
  onSso: () => void;
  error?: string; notice?: string;
}) {
  const { status } = props;
  const [view, setView] = useState<'login' | 'register'>('login');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState('');

  const errText = props.error === 'invalid' ? T.errInvalid
    : props.error === 'pending' ? T.errPending
    : props.error === 'suspended' ? T.errSuspended
    : props.error ? T.errNetwork : '';

  const fields = (
    <>
      <input type="text" placeholder={T.loginIdPh} value={loginId} onChange={(e) => setLoginId(e.target.value)} />
      <input type="password" placeholder={T.passwordPh} value={password} onChange={(e) => setPassword(e.target.value)} />
    </>
  );

  return (
    <div id="loginGate">
      <div id="loginCard">
        {!status.configured ? (
          <>
            <h2>{T.setupTitle}</h2>
            {!props.setupCode && (
              <input type="text" placeholder={T.setupCodePh} value={code} onChange={(e) => setCode(e.target.value)} />
            )}
            {fields}
            <button type="button" onClick={() => props.onSetup(props.setupCode ?? code, loginId, password)}>{T.setupBtn}</button>
          </>
        ) : view === 'login' ? (
          <>
            <h2>{T.signInTitle(status.serverName ?? props.connName)}</h2>
            {fields}
            <button type="button" onClick={() => props.onLogin(loginId, password)}>{T.signIn}</button>
            {status.oidc && <button type="button" className="sso" onClick={props.onSso}>{T.ssoBtn}</button>}
            <a onClick={() => setView('register')}>{T.registerLink}</a>
          </>
        ) : (
          <>
            <h2>{T.registerLink}</h2>
            {fields}
            <input type="text" placeholder={T.displayNameFieldPh} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            <button type="button" onClick={() => props.onRegister(loginId, password, displayName)}>{T.registerBtn}</button>
            <a onClick={() => setView('login')}>{T.backToLogin}</a>
          </>
        )}
        {errText && <div className="err">{errText}</div>}
        {props.notice && <div className="notice">{props.notice}</div>}
      </div>
    </div>
  );
}
```

`desktop.d.ts`에 추가(Task 15가 구현할 ipc — 지금은 옵셔널 타입만):

```ts
interface Window {
  engramDesktop?: {
    pickFolder(): Promise<string | null>;
    setupCode?(): Promise<string | null>; // Task 15
  };
}
```

`App.tsx` 게이트 배선:

```tsx
import { LoginGate } from './components/LoginGate';
import { fetchStatus, apiLogin, apiRegister, apiSetup, apiOidcBegin, apiOidcPoll, type AuthStatus } from './auth-api';
import { saveSessionFor, clearSessionFor, loadSessions } from './sessions';
import type { UserDto } from '../../shared/protocol';

// state 추가:
const [meByConn, setMeByConn] = useState<Record<string, UserDto>>({});
const [gateStatus, setGateStatus] = useState<AuthStatus | null>(null); // 기본 연결의 /auth/status
const [gateError, setGateError] = useState<string | undefined>();
const [gateNotice, setGateNotice] = useState<string | undefined>();
const [localSetupCode, setLocalSetupCode] = useState<string | null>(null);

// onFrame에 추가(에러 분기 근처):
} else if (f.t === 'authOk') {
  setMeByConn((prev) => ({ ...prev, [connId]: f.user }));
} else if (f.t === 'authErr') {
  setSessions(clearSessionFor(connId)); // 만료/철회 → 게이트로
  setErrText((prev) => ({ ...prev, [connId]: T.authFailed }));
}

// 기본 연결 상태 조회(연결 변경·세션 삭제 시):
const defId = connState.defaultConnId;
const defConn = connState.connections.find((c) => c.id === defId);
useEffect(() => {
  let alive = true;
  setGateStatus(null); setGateError(undefined); setGateNotice(undefined);
  if (!defConn || sessions[defId]) return; // 세션 있으면 게이트 없음(authErr가 오면 위에서 삭제됨)
  void fetchStatus(defConn.endpoint).then((s) => { if (alive) setGateStatus(s); });
  void window.engramDesktop?.setupCode?.().then((c) => { if (alive) setLocalSetupCode(c ?? null); }).catch(() => {});
  return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [defId, defConn?.endpoint, sessions[defId]]);

const acceptSession = (token: string, user: UserDto) => {
  setSessions(saveSessionFor(defId, token));
  setMeByConn((prev) => ({ ...prev, [defId]: user }));
  setGateStatus(null); setGateError(undefined);
};
const handleAuthResult = (r: { token: string; user: UserDto } | { error: string }) => {
  if ('error' in r) setGateError(r.error); else acceptSession(r.token, r.user);
};
const startSso = async () => {
  if (!defConn) return;
  const b = await apiOidcBegin(defConn.endpoint);
  if ('error' in b) { setGateError(b.error); return; }
  window.open(b.authUrl, '_blank'); // 데스크톱은 main.ts 핸들러가 기본 브라우저로 연다
  const tick = async (): Promise<void> => {
    const p = await apiOidcPoll(defConn.endpoint, b.pollCode);
    if ('pending' in p) { setTimeout(() => { void tick(); }, 2000); return; }
    handleAuthResult(p);
  };
  void tick();
};

// 렌더 최상단(titlebar 아래) — 게이트가 뜨면 앱 본체 대신 게이트만:
if (gateStatus && defConn && !sessions[defId]) {
  return (
    <>
      <div id="titlebar"><span id="tbtitle">Engram Desktop</span></div>
      <LoginGate
        connName={defConn.name} status={gateStatus} setupCode={localSetupCode}
        error={gateError} notice={gateNotice}
        onLogin={(l, p) => { void apiLogin(defConn.endpoint, l, p).then(handleAuthResult); }}
        onRegister={(l, p, d) => { void apiRegister(defConn.endpoint, l, p, d).then((r) => { if ('error' in r) setGateError(r.error); else { setGateNotice(T.registered); setGateError(undefined); } }); }}
        onSetup={(c, l, p) => { void apiSetup(defConn.endpoint, c, l, p).then(handleAuthResult); }}
        onSso={() => { void startSso(); }}
      />
    </>
  );
}
```

간단한 게이트 CSS는 렌더러의 기존 스타일 파일(모달 `#manageModal` 스타일 관례)을 따라 `#loginGate`(오버레이)·`#loginCard`(카드) 추가.

- [ ] **Step 4: 통과 확인**

Run(renderer): `npx vitest run`
Expected: 전체 PASS (App 테스트가 게이트 때문에 깨지면: 기존 App 테스트는 무인증 가짜 서버 → `fetchStatus`가 null이라 게이트 안 뜸 — fetch mock이 필요한 경우 `vi.spyOn(globalThis,'fetch').mockRejectedValue(...)`를 setup에 추가)

- [ ] **Step 5: 커밋**

```bash
git add renderer/src/components/LoginGate.tsx renderer/src/components/LoginGate.test.tsx renderer/src/App.tsx renderer/src/i18n.ts renderer/src/desktop.d.ts
git commit -m "feat(phase16a): 앱 로그인 게이트 — 로그인/가입/내 서버 만들기/SSO 폴링"
```

---

### Task 13: renderer — Admin 영역 + authorName 렌더 + 닉네임 입력 대체

**Files:**
- Create: `renderer/src/components/AdminArea.tsx`
- Test: `renderer/src/components/AdminArea.test.tsx`
- Modify: `renderer/src/areas.ts`, `renderer/src/areas.test.ts`, `renderer/src/components/Channels.tsx`, `renderer/src/components/Message.tsx`, `renderer/src/components/Message.test.tsx`, `renderer/src/App.tsx`, `renderer/src/i18n.ts`

**Interfaces:**
- Consumes: `AdminUserDto`/`AdminSettings`(T8 프레임), `meByConn`(T12).
- Produces:
  ```tsx
  export function AdminArea(props: {
    users: AdminUserDto[];
    settings: AdminSettings | null;
    onApprove(id: string): void; onSuspend(id: string): void; onRestore(id: string): void;
    onResetPassword(id: string, password: string): void; onForceLogout(id: string): void;
    onSaveSettings(s: AdminSettings): void;
  }): JSX.Element;
  // areas.ts
  export function areaTabs(teamChat: boolean, admin?: boolean): ('chat' | 'code' | 'team' | 'wiki' | 'admin')[];
  ```
  Message 렌더: `who`에 `m.authorName ?? m.authorId` 사용, `isMe` 판정은 `myName`(=내 계정 id) 비교를 `m.authorId === myId`로. App은 `myId = meByConn[defaultConnId]?.id`를 team 모드에 전달(자가선언 displayName 입력칸 삭제).

- [ ] **Step 1: 실패하는 테스트**

```tsx
// renderer/src/components/AdminArea.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AdminArea } from './AdminArea';

const users = [
  { id: 'u1', loginId: 'kim', displayName: 'Kim', role: 'owner' as const, status: 'active' as const, createdAt: '2026-01-01', sso: false },
  { id: 'u2', loginId: 'lee', displayName: 'Lee', role: 'member' as const, status: 'pending' as const, createdAt: '2026-01-02', sso: true },
];
const noop = { onApprove: vi.fn(), onSuspend: vi.fn(), onRestore: vi.fn(), onResetPassword: vi.fn(), onForceLogout: vi.fn(), onSaveSettings: vi.fn() };

describe('AdminArea', () => {
  it('pending 사용자에 승인/거부(=정지) 버튼, 클릭 시 콜백', () => {
    render(<AdminArea users={users} settings={{}} {...noop} />);
    expect(screen.getByText('Lee')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(noop.onApprove).toHaveBeenCalledWith('u2');
  });
  it('active member에 suspend/forceLogout, owner 행엔 suspend 버튼 없음', () => {
    const activeUsers = [users[0], { ...users[1], status: 'active' as const }];
    render(<AdminArea users={activeUsers} settings={{}} {...noop} />);
    fireEvent.click(screen.getByRole('button', { name: /suspend/i }));
    expect(noop.onSuspend).toHaveBeenCalledWith('u2');
    expect(screen.getAllByRole('button', { name: /suspend/i }).length).toBe(1); // owner 제외
  });
  it('설정 폼: 서버 이름·OIDC 저장', () => {
    render(<AdminArea users={users} settings={{ serverName: 'Old' }} {...noop} />);
    fireEvent.change(screen.getByPlaceholderText(/server name/i), { target: { value: 'Team' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(noop.onSaveSettings).toHaveBeenCalledWith(expect.objectContaining({ serverName: 'Team' }));
  });
});
```

```ts
// areas.test.ts에 추가
it('admin=true면 admin 탭 포함(맨 뒤)', () => {
  expect(areaTabs(true, true)).toEqual(['chat', 'team', 'code', 'wiki', 'admin']);
  expect(areaTabs(true, false)).toEqual(['chat', 'team', 'code', 'wiki']);
});
```

```tsx
// Message.test.tsx에 추가
it('authorName 우선 렌더, myId 비교로 나/남 구분', () => {
  const m = { id: '1', authorId: 'uid-2', authorName: 'Lee', text: 'hi', ts: new Date().toISOString() };
  render(<Message m={m} myName="uid-1" />);
  expect(screen.getByText(/Lee/)).toBeTruthy(); // 남 → 이름 표시
});
```

- [ ] **Step 2: 실패 확인**

Run(renderer): `npx vitest run src/components/AdminArea.test.tsx src/areas.test.ts src/components/Message.test.tsx`
Expected: FAIL

- [ ] **Step 3: 구현**

`i18n.ts` 추가:

```ts
tabAdmin: ko ? '관리' : 'Admin',
adminMembers: ko ? '멤버' : 'Members',
adminApprove: ko ? '승인' : 'Approve',
adminSuspend: ko ? '정지' : 'Suspend',
adminRestore: ko ? '복구' : 'Restore',
adminResetPw: ko ? '비밀번호 리셋' : 'Reset password',
adminNewPwPrompt: ko ? '새 비밀번호:' : 'New password:',
adminForceLogout: ko ? '강제 로그아웃' : 'Force logout',
adminSettings: ko ? '서버 설정' : 'Server settings',
adminServerNamePh: ko ? '서버 이름' : 'Server name',
adminOidcIssuerPh: ko ? 'OIDC 발급자 URL' : 'OIDC issuer URL',
adminOidcClientIdPh: ko ? '클라이언트 ID' : 'Client ID',
adminOidcSecretPh: ko ? '클라이언트 시크릿' : 'Client secret',
adminPresetGoogle: ko ? 'Google 프리셋' : 'Google preset',
adminSave: ko ? '저장' : 'Save',
statusPending: ko ? '대기' : 'pending',
statusActive: ko ? '활성' : 'active',
statusSuspended: ko ? '정지' : 'suspended',
```

`areas.ts`:

```ts
export function areaTabs(teamChat: boolean, admin = false): ('chat' | 'code' | 'team' | 'wiki' | 'admin')[] {
  const base: ('chat' | 'code' | 'team' | 'wiki' | 'admin')[] = teamChat ? ['chat', 'team', 'code', 'wiki'] : ['chat', 'code', 'wiki'];
  return admin ? [...base, 'admin'] : base;
}
```

```tsx
// renderer/src/components/AdminArea.tsx
import { useEffect, useState } from 'react';
import type { AdminUserDto, AdminSettings } from '../../../shared/protocol';
import { T } from '../i18n';

// 관리 영역(스펙 §2.5) — owner에게만 App이 렌더. 순수 UI, 통신은 App 콜백(ws admin 프레임).
export function AdminArea(props: {
  users: AdminUserDto[]; settings: AdminSettings | null;
  onApprove: (id: string) => void; onSuspend: (id: string) => void; onRestore: (id: string) => void;
  onResetPassword: (id: string, password: string) => void; onForceLogout: (id: string) => void;
  onSaveSettings: (s: AdminSettings) => void;
}) {
  const [serverName, setServerName] = useState('');
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  useEffect(() => {
    setServerName(props.settings?.serverName ?? '');
    setIssuer(props.settings?.oidc?.issuer ?? '');
    setClientId(props.settings?.oidc?.clientId ?? '');
    setClientSecret(props.settings?.oidc?.clientSecret ?? '');
  }, [props.settings]);

  const statusLabel: Record<AdminUserDto['status'], string> = {
    pending: T.statusPending, active: T.statusActive, suspended: T.statusSuspended,
  };

  return (
    <div id="adminArea">
      <h3>{T.adminMembers}</h3>
      <div id="adminUsers">
        {props.users.map((u) => (
          <div key={u.id} className="adminRow">
            <span className="name">{u.displayName}</span>
            <span className="login">{u.loginId}{u.sso ? ' (SSO)' : ''}</span>
            <span className={'status ' + u.status}>{statusLabel[u.status]}{u.role === 'owner' ? ' · owner' : ''}</span>
            {u.status === 'pending' && <button onClick={() => props.onApprove(u.id)}>{T.adminApprove}</button>}
            {u.status === 'pending' && <button className="danger" onClick={() => props.onSuspend(u.id)}>{T.adminSuspend}</button>}
            {u.status === 'active' && u.role !== 'owner' && <button className="danger" onClick={() => props.onSuspend(u.id)}>{T.adminSuspend}</button>}
            {u.status === 'suspended' && <button onClick={() => props.onRestore(u.id)}>{T.adminRestore}</button>}
            {!u.sso && <button onClick={() => { const p = window.prompt(T.adminNewPwPrompt); if (p) props.onResetPassword(u.id, p); }}>{T.adminResetPw}</button>}
            {u.status === 'active' && <button onClick={() => props.onForceLogout(u.id)}>{T.adminForceLogout}</button>}
          </div>
        ))}
      </div>
      <h3>{T.adminSettings}</h3>
      <div id="adminSettings">
        <input type="text" placeholder={T.adminServerNamePh} value={serverName} onChange={(e) => setServerName(e.target.value)} />
        <button type="button" onClick={() => setIssuer('https://accounts.google.com')}>{T.adminPresetGoogle}</button>
        <input type="text" placeholder={T.adminOidcIssuerPh} value={issuer} onChange={(e) => setIssuer(e.target.value)} />
        <input type="text" placeholder={T.adminOidcClientIdPh} value={clientId} onChange={(e) => setClientId(e.target.value)} />
        <input type="password" placeholder={T.adminOidcSecretPh} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
        <button type="button" onClick={() => props.onSaveSettings({
          ...(serverName.trim() ? { serverName: serverName.trim() } : {}),
          ...(issuer.trim() && clientId.trim() ? { oidc: { issuer: issuer.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim() } } : {}),
        })}>{T.adminSave}</button>
      </div>
    </div>
  );
}
```

`Message.tsx` — 표시명·나 판정:

```tsx
const isMe = !isEngram && (myName === undefined || m.authorId === myName); // myName에는 이제 "내 계정 id"가 온다
const who = isEngram ? 'Engram' : isMe ? (ko ? '나' : 'me') : (m.authorName ?? m.authorId);
```

`Channels.tsx` — mode 유니언에 `'admin'` 추가(props 타입 3곳), `label`에 `admin: T.tabAdmin`, `tabs = areaTabs(TEAM_CHAT, props.showAdmin)` — props에 `showAdmin?: boolean` 추가. `mode !== 'wiki'` 채널 목록 가드들을 `mode !== 'wiki' && mode !== 'admin'`으로.

`App.tsx`:

```tsx
// state
const [adminUsers, setAdminUsers] = useState<AdminUserDto[]>([]);
const [adminSettings, setAdminSettings] = useState<AdminSettings | null>(null);
// mode 유니언에 'admin' 추가: useState<'chat' | 'code' | 'team' | 'wiki' | 'admin'>('chat')

// onFrame 기본연결 분기에 추가:
else if (f.t === 'adminUsers') setAdminUsers(f.list);
else if (f.t === 'adminSettings') setAdminSettings(f.settings);

// admin 모드 진입 시 목록·설정 요청(wiki useEffect와 동형):
useEffect(() => {
  if (mode !== 'admin') return;
  const id = connState.defaultConnId;
  if (!statusById[id]) return;
  send(id, { t: 'adminUsers' });
  send(id, { t: 'adminGetSettings' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [mode, connState.defaultConnId, statusById[connState.defaultConnId]]);

// Channels에 showAdmin 전달:
<Channels ... showAdmin={meByConn[connState.defaultConnId]?.role === 'owner'} ... />

// #main 분기에 admin 추가(wiki 분기와 나란히):
{mode === 'admin' ? (
  <AdminArea users={adminUsers} settings={adminSettings}
    onApprove={(id) => send(connState.defaultConnId, { t: 'adminApprove', id })}
    onSuspend={(id) => send(connState.defaultConnId, { t: 'adminSuspend', id })}
    onRestore={(id) => send(connState.defaultConnId, { t: 'adminRestore', id })}
    onResetPassword={(id, password) => send(connState.defaultConnId, { t: 'adminResetPassword', id, password })}
    onForceLogout={(id) => send(connState.defaultConnId, { t: 'adminForceLogout', id })}
    onSaveSettings={(s) => send(connState.defaultConnId, { t: 'adminSetSettings', settings: s })}
  />
) : mode === 'wiki' ? ( ...기존... )}

// team 닉네임 입력(#teamName div)과 displayName state·import 제거,
// Thread에 myName={mode === 'team' ? meByConn[connState.defaultConnId]?.id : undefined},
// sendText의 displayName 가드·authorId 첨부 제거(서버 스탬프가 대체):
//   if (mode === 'team' && !meByConn[connState.defaultConnId]) return; // 미인증 team 전송 차단
//   send(...{ t:'send', channelId, text, threadId })  // authorId 없음
// sidebarChannels·fanoutToName의 wiki 가드에 admin 추가.
```

`Thread.tsx`는 `myName`을 Message로 흘려보내기만 하므로 무변경(값의 의미만 displayName→계정 id로 바뀜).

- [ ] **Step 4: 통과 확인**

Run(renderer): `npx vitest run`
Expected: 전체 PASS (App.multi.test 등에서 displayName 입력을 만지던 테스트는 meByConn 주입 방식으로 수정)

- [ ] **Step 5: 커밋**

```bash
git add renderer/src
git commit -m "feat(phase16a): Admin 영역(승인함·멤버·서버설정) + authorName 렌더 — 자가선언 닉네임 대체"
```

---

### Task 14: 잔재 정리 — 공유 토큰·display-name 제거 + README

**Files:**
- Modify: `src/edge/messenger/chat.config.ts`(+spec) — `token` 필드·env 제거
- Modify: `shared/protocol.ts` — send 프레임 `authorId?` 제거
- Delete: `renderer/src/display-name.ts`, `renderer/src/display-name.test.ts`
- Modify: `renderer/src/connections.ts`(+test) — `Connection.token`·`LOCAL_TOKEN` 패치 제거
- Modify: `renderer/src/config.ts` — `LOCAL_TOKEN` 제거
- Modify: `renderer/src/components/ManageEngrams.tsx`(+test) — 토큰 입력칸 제거
- Modify: `renderer/src/i18n.ts` — `tokenPh`·`displayNamePh` 제거
- Modify: `src/desktop/main.ts:167-168` — `?token=` 주입 제거
- Modify: `README.md` — 스펙 §7대로 재작성(계정 흐름·서버 세우기·SSO·로컬 두뇌)
- Modify: `docs/superpowers/specs/2026-07-11-phase16a-accounts-design.md` — `/auth/oidc/start`를 `begin`(JSON) 방식으로 소폭 갱신

- [ ] **Step 1: 실패(컴파일·테스트) 확인 방식**

이 태스크는 삭제 중심 — 테스트를 먼저 고친다: `connections.test.ts`에서 token 관련 케이스 삭제, `ManageEngrams.test.tsx`에서 토큰 입력 케이스 삭제. `chat.config.spec.ts`에서 token 케이스 삭제.

- [ ] **Step 2: 구현**

- `chat.config.ts`: `token` 필드·`ENGRAM_CHAT_TOKEN` 파싱 삭제.
- `protocol.ts`: send에서 `authorId?: string` 삭제.
- `connections.ts`: `token` 필드, `loadConnections(localToken)` 파라미터·패치 블록, `addConnection`의 token 인자 삭제.
- `config.ts`: `LOCAL_TOKEN` 삭제.
- `ManageEngrams.tsx`: token state·입력·`onAdd` 3번째 인자 삭제. `App.tsx` 호출부도.
- `src/desktop/main.ts`: `const auth = ...` 줄과 `${auth}` 삭제.
- `display-name.ts`(+test) 삭제 — App.tsx의 import는 Task 13에서 이미 제거됨.
- README: "인증 · 원격 접속" 절 교체 —

```markdown
### 계정 · 원격 접속 (Phase 16a)

Engram 서버(두뇌)는 1인 1계정이다. 앱은 서버에 로그인해야 쓸 수 있다.

1. **서버 세우기**: 서버 머신에서 Engram을 실행하면 로그에 1회용 **설정 코드**가 찍힌다.
   앱 첫 화면("Create your server" — 내 컴퓨터면 코드 자동 입력)에 코드+아이디/비밀번호를
   넣으면 첫 계정(소유자)이 만들어진다.
2. **팀원 초대**: 서버 주소(`ws://…`)를 알려주거나, 주소가 미리 설정된 앱을 나눠준다.
   팀원은 로그인 화면에서 **가입 신청**(또는 SSO 로그인) → 소유자가 관리(Admin) 탭에서 승인.
3. **SSO(선택)**: 관리 탭 서버 설정에 OIDC 발급자·클라이언트를 넣으면(구글 프리셋 버튼)
   "Sign in with SSO" 버튼이 열린다.
4. **로컬 두뇌(+)**: 연산을 내 컴퓨터에서 돌리고 싶으면 Manage Engrams에서 로컬 두뇌를
   추가한다(두뇌 전용 모드 — 로그인 불필요, 지식은 중앙 위키로 합류).

⚠️ 인터넷 노출은 여전히 TLS 앞단(터널/리버스 프록시)이 필수다 — 평문 ws://를 그대로 열지 말 것.
```

팀채팅 절의 닉네임 문단은 "이름은 계정의 표시 이름"으로 교체.

- [ ] **Step 3: 전체 확인**

Run: `npm test && npm run build`, renderer에서 `npx vitest run && npm run build`(renderer build 스크립트)
Expected: 전부 PASS·클린

- [ ] **Step 4: 커밋**

```bash
git add -A
git commit -m "feat(phase16a): 공유 토큰·자가선언 닉네임 잔재 제거 + README 계정 안내"
```

---

### Task 15: 데스크톱 — 로컬 setup-code ipc + 배포 프리셋 + 로컬 두뇌 추가(+)

**Files:**
- Modify: `src/desktop/main.ts`, `src/desktop/chat-preload.ts`
- Create: `src/desktop/local-brains.ts`
- Test: `src/desktop/local-brains.spec.ts`
- Modify: `renderer/src/connections.ts`(+test) — 프리셋 시드
- Modify: `renderer/src/config.ts` — 프리셋 파라미터
- Modify: `renderer/src/components/ManageEngrams.tsx`(+test) — "Add local brain" 버튼(데스크톱에서만)
- Modify: `renderer/src/desktop.d.ts`, `renderer/src/i18n.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/desktop/local-brains.ts — 로컬 두뇌 목록 영속(설정 폴더 local-brains.json)
  export interface LocalBrain { id: string; name: string; port: number; dataDir: string }
  export function loadLocalBrains(configDir: string): LocalBrain[];
  export function addLocalBrain(configDir: string, dataRoot: string, name: string, usedPorts: number[]): LocalBrain; // 포트=47801부터 빈 곳
  // preload
  window.engramDesktop.setupCode(): Promise<string | null>;
  window.engramDesktop.addLocalBrain(name: string): Promise<{ endpoint: string; name: string } | null>;
  // renderer/src/config.ts
  export const PRESET: { name: string; endpoint: string } | null; // ?presetName=&presetEndpoint=
  ```
  desktop main: 부팅 시 `loadLocalBrains` 각각을 `ENGRAM_CHAT_ROLE=brain`·`ENGRAM_CHAT_PORT`·`ENGRAM_DATA_DIR=<dataDir>`로 fork(감독은 메인 child와 달리 단순 — ponytail: 죽으면 재시작 안 함, 필요해지면 backoff 재사용). `configDir/preset.json`(`{name,endpoint}`)이 있으면 renderer 로드 URL에 `presetName`/`presetEndpoint` 주입. `connections.ts`의 `seed()`는 프리셋이 있으면 `[{id:'preset',...}, local]`에 default='preset'.

- [ ] **Step 1: 실패하는 테스트(local-brains)**

```ts
// src/desktop/local-brains.spec.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadLocalBrains, addLocalBrain } from './local-brains';

describe('local-brains', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('add → load 왕복, 포트는 47801부터 사용중 회피', () => {
    const b1 = addLocalBrain(dir, path.join(dir, 'data'), 'My brain', [47800]);
    expect(b1.port).toBe(47801);
    const b2 = addLocalBrain(dir, path.join(dir, 'data'), 'Second', [47800, 47801]);
    expect(b2.port).toBe(47802);
    const list = loadLocalBrains(dir);
    expect(list.map((b) => b.name)).toEqual(['My brain', 'Second']);
    expect(b1.dataDir).toContain('brains'); // dataRoot/brains/<id>
  });

  it('손상 파일 → 빈 목록', () => {
    fs.writeFileSync(path.join(dir, 'local-brains.json'), 'bad');
    expect(loadLocalBrains(dir)).toEqual([]);
  });
});
```

```ts
// renderer/src/connections.test.ts에 추가
it('프리셋이 있으면 preset이 기본 연결', () => {
  // loadConnections(preset 인자) 또는 PRESET 주입 방식 — 시드가 [{id:'preset', name, endpoint}, local], default='preset'
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/desktop/local-brains.spec.ts` / renderer `npx vitest run src/connections.test.ts`
Expected: FAIL

- [ ] **Step 3: 구현**

```ts
// src/desktop/local-brains.ts
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

// '+ 로컬 두뇌'(스펙 §2.1/§2.5) 목록 영속. 실행은 desktop main이 brain 모드로 fork.

export interface LocalBrain { id: string; name: string; port: number; dataDir: string }

function file(configDir: string): string { return path.join(configDir, 'local-brains.json'); }

export function loadLocalBrains(configDir: string): LocalBrain[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file(configDir), 'utf8')) as unknown;
    return Array.isArray(raw) ? raw as LocalBrain[] : [];
  } catch { return []; }
}

export function addLocalBrain(configDir: string, dataRoot: string, name: string, usedPorts: number[]): LocalBrain {
  const list = loadLocalBrains(configDir);
  const used = new Set([...usedPorts, ...list.map((b) => b.port)]);
  let port = 47801;
  while (used.has(port)) port++;
  const id = randomUUID();
  const b: LocalBrain = { id, name: name.trim() || 'Local brain', port, dataDir: path.join(dataRoot, 'brains', id) };
  list.push(b);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file(configDir), JSON.stringify(list, null, 2));
  return b;
}
```

`src/desktop/main.ts`:

```ts
import { loadLocalBrains, addLocalBrain } from './local-brains';
import { readSetupCode } from '../edge/auth/setup-code';

// 로컬 두뇌 fork(brain 모드). ponytail: 죽어도 재시작 안 함(다음 앱 부팅에 다시 뜸) — 필요 시 Backoff 재사용.
const brainProcs: UtilityProcess[] = [];
function startLocalBrain(b: { port: number; dataDir: string }): void {
  const entry = path.join(app.getAppPath(), 'dist', 'src', 'main.js');
  brainProcs.push(utilityProcess.fork(entry, [], {
    env: {
      ...childEnv,
      ENGRAM_DATA_DIR: b.dataDir, ENGRAM_MODEL_CACHE_DIR: path.join(dataDir, 'models'), // 모델 캐시는 공유
      ENGRAM_CHAT_ROLE: 'brain', ENGRAM_CHAT_PORT: String(b.port),
    },
    stdio: 'ignore', serviceName: 'engram-brain',
  }));
}

// registerIpc()에 추가:
ipcMain.handle('engram:setup-code', () => readSetupCode(path.join(dataDir, 'state')));
ipcMain.handle('engram:add-local-brain', (_e, name: string) => {
  const cfg = loadChatConfig(configDir, childEnv);
  const b = addLocalBrain(configDir, dataDir, name, [cfg.port]);
  startLocalBrain(b);
  return { endpoint: `ws://127.0.0.1:${b.port}`, name: b.name };
});

// 부팅(whenReady)에서 startChild() 다음에:
for (const b of loadLocalBrains(configDir)) startLocalBrain(b);
// before-quit에서 brainProcs.forEach((p) => p.kill());

// openChat()의 loadFile search에 프리셋 주입:
let preset = '';
try {
  const p = JSON.parse(fs.readFileSync(path.join(configDir, 'preset.json'), 'utf8')) as { name?: string; endpoint?: string };
  if (p.endpoint) preset = `&presetName=${encodeURIComponent(p.name ?? 'Server')}&presetEndpoint=${encodeURIComponent(p.endpoint)}`;
} catch { /* 프리셋 없음 */ }
// search: `port=${cfg.port}&lang=${lang}${preset}`
```

`chat-preload.ts`:

```ts
contextBridge.exposeInMainWorld('engramDesktop', {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('engram:pick-folder'),
  setupCode: (): Promise<string | null> => ipcRenderer.invoke('engram:setup-code'),
  addLocalBrain: (name: string): Promise<{ endpoint: string; name: string } | null> => ipcRenderer.invoke('engram:add-local-brain', name),
});
```

`renderer/src/config.ts`:

```ts
const pn = new URLSearchParams(window.location.search).get('presetName');
const pe = new URLSearchParams(window.location.search).get('presetEndpoint');
export const PRESET = pe ? { name: pn || 'Server', endpoint: pe } : null;
```

`renderer/src/connections.ts`의 `seed()`:

```ts
import { WS_URL, PRESET } from './config';
function seed(): State {
  const local: Connection = { id: 'local', name: 'Local', endpoint: defaultEndpoint() };
  if (PRESET) {
    return { connections: [{ id: 'preset', name: PRESET.name, endpoint: PRESET.endpoint }, local], defaultConnId: 'preset' };
  }
  return { connections: [local], defaultConnId: 'local' };
}
```

`ManageEngrams.tsx` — 데스크톱에서만 보이는 버튼(+i18n `addLocalBrain: ko ? '로컬 두뇌 추가' : 'Add local brain'`):

```tsx
{window.engramDesktop?.addLocalBrain && (
  <button type="button" onClick={() => {
    void window.engramDesktop!.addLocalBrain!(name.trim() || 'Local brain').then((r) => {
      if (r) onAdd(r.name, r.endpoint);
    });
  }}>{T.addLocalBrain}</button>
)}
```

`desktop.d.ts`에 `addLocalBrain` 타입 추가.

- [ ] **Step 4: 통과 확인**

Run: `npm test && npm run build`, renderer `npx vitest run`
Expected: 전부 PASS. Electron 실동작(프리셋·로컬 두뇌 fork)은 수동 스모크 항목으로 남긴다(아래 참고).

- [ ] **Step 5: 커밋**

```bash
git add -A
git commit -m "feat(phase16a): 데스크톱 — setup-code ipc·배포 프리셋·로컬 두뇌 추가(brain 모드 fork)"
```

---

## 수동 스모크(구현 밖 — 사용자/최종 검증용 체크리스트)

1. `npm run desktop:dev` → 첫 실행 로그인 게이트에 "Create your server" → 코드 자동 → owner 생성 → 채팅 동작.
2. 관리 탭: 두 번째 클라(브라우저)에서 가입 신청 → 승인 → 로그인 → team 채팅에 계정 이름 표시.
3. 정지 → 그 클라 즉시 끊김·재로그인 불가. 복구 → 재로그인.
4. (선택) 실제 Google OIDC 클라이언트로 SSO 로그인.
5. Manage에서 로컬 두뇌 추가 → Ask에서 그 두뇌 선택·응답 확인.

## Self-Review 노트

- 스펙 §2.1(모드)=T9·T15, §2.2(모듈 4개)=T1~T4, §2.3(프로토콜)=T4·T6·T7, §2.4(setup)=T3·T4·T15, §2.5(클라)=T10~T13·T15, §2.6(정리)=T7·T14, §4(보안)=T1(scrypt/타이밍)·T2(랜덤)·T4(균일지연)·T5(서명검증)·T6(state 1회용), §5(테스트)=각 태스크, §7(README)=T14. 갭 없음.
- 타입 일관성: `AuthDeps`(T7 정의→T8·T9 소비), `AuthUserDto`(T4)와 protocol `UserDto`(T7)는 구조 동일(중복이지만 shared는 런타임 0 원칙이라 백엔드 값 타입을 따로 둠), `useConnections` 새 시그니처(T11 정의→T12·T13 소비), `areaTabs(teamChat, admin?)`(T13).
- 스펙과 다른 소소한 결정: `/auth/oidc/start`(redirect) 대신 `/auth/oidc/begin`(JSON) — 앱이 pollCode를 받아야 해서. T14에서 스펙 문서를 이에 맞게 1줄 갱신한다.
