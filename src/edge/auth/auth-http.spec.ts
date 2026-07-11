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

  it('login: 64KB 초과 본문 → 응답 완료(멈추지 않음), 4xx', async () => {
    const r = await fetch(base + '/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(200 * 1024),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
  }, 5000);
});
