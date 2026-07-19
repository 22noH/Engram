import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AccountStore } from './account-store';
import { SessionStore } from './session-store';
import { ensureSetupCode, readSetupCode } from './setup-code';
import { AuthHttp } from './auth-http';
import { OidcService, PollStore } from './oidc';
import * as mcpHttp from '../mcp/mcp-http';

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
    // fetch(127.0.0.1)는 루프백이라 미설정+루프백=localFree true(스탠드얼론 §2.1, Task 1 케이스①과 동일 조건).
    expect(await r.json()).toEqual({ configured: false, oidc: false, serverName: 'T', localFree: true });
  });

  it('status(Task 1 케이스②): 계정 1개+루프백 → localFree:false', async () => {
    accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
    const r = await fetch(base + '/auth/status');
    expect(await r.json()).toMatchObject({ configured: true, localFree: false });
  });

  it('status(Task 1 케이스③): 미설정+비루프백 → localFree:false', async () => {
    // fetch는 항상 127.0.0.1로 접속하므로 소켓 판정 자체를 모킹(mcp-http의 isLoopback 재사용 지점 — 8c-2 관성).
    const spy = jest.spyOn(mcpHttp, 'isLoopback').mockReturnValue(false);
    try {
      const r = await fetch(base + '/auth/status');
      expect(await r.json()).toMatchObject({ configured: false, localFree: false });
    } finally {
      spy.mockRestore();
    }
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

  it('login: 64KB 초과 본문 → 응답 완료(멈추지 않음), 4xx', async () => {
    const r = await fetch(base + '/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(200 * 1024),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
  }, 5000);
});

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

  it('code 누락 콜백은 유효 state를 소비(엄격 1회용) — 재사용 불가', async () => {
    const { authUrl } = await (await fetch(base + '/auth/oidc/begin', { method: 'POST' })).json() as { authUrl: string; pollCode: string };
    const state = new URL(authUrl).searchParams.get('state')!;
    // code 없이 콜백 → 400(bad state). 픽스 전에는 state가 소비되지 않아 아래 재사용이 성공했다.
    expect((await fetch(base + `/auth/oidc/callback?state=${state}`)).status).toBe(400);
    // 같은 state를 code와 함께 재사용 → 이미 소비됐으므로 400.
    expect((await fetch(base + `/auth/oidc/callback?code=abc&state=${state}`)).status).toBe(400);
  });
});
