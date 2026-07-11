import type * as http from 'http';
import { randomBytes } from 'crypto';
import { AccountStore, Account } from './account-store';
import { SessionStore } from './session-store';
import type { AuthSettings, OidcSettings } from './auth.config';
import { readSetupCode, clearSetupCode } from './setup-code';
import { OidcService, PollStore } from './oidc';

// /auth/* http 창구(스펙 §2.3). 파싱/응답만 — 로직은 store에 위임. CORS 개방(*):
// 자격증명은 본문으로만 오가고 쿠키를 안 쓰므로 교차출처 허용이 안전하다(렌더러는 file://).

export interface AuthUserDto { id: string; displayName: string; role: 'owner' | 'member' }
export interface AuthHttpDeps {
  accounts: AccountStore; sessions: SessionStore; stateDir: string;
  settings: { load(): AuthSettings };
  delayMs?: number; // 실패 균일 지연(무차별 대입 완화). 기본 500ms, 테스트 0.
  makeOidc?: (o: OidcSettings) => OidcService; // 기본 new OidcService(o). 테스트가 가짜 주입.
  polls?: PollStore; // 기본 new PollStore()
}

export function toUserDto(a: Account): AuthUserDto {
  return { id: a.id, displayName: a.displayName, role: a.role };
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: Record<string, unknown>) => { if (!settled) { settled = true; resolve(v); } };
    let data = '';
    let oversize = false;
    req.on('data', (c) => {
      if (oversize) return; // 이미 정착 — 소켓은 파괴하지 않고 흘려보내기만(응답 왕복 유지)
      data += String(c);
      if (data.length > 64 * 1024) { oversize = true; settle({}); } // 과대 본문: destroy() 없이 즉시 정착(소켓 파괴 시 응답 자체가 불가능해짐)
    });
    req.on('end', () => {
      if (oversize) return; // 이미 위에서 정착
      try {
        const j = JSON.parse(data) as unknown;
        settle(j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, unknown> : {});
      } catch { settle({}); }
    });
    req.on('error', () => settle({}));
    req.on('close', () => settle({})); // destroy()/중단 시 'end'가 안 옴 — 정착 보장
    req.on('aborted', () => settle({}));
  });
}

export class AuthHttp {
  private readonly polls: PollStore;
  // state → pollCode 매핑(CSRF 검증 — 우리가 만든 state만 콜백 수용). 메모리 상주.
  private readonly states = new Map<string, string>();

  constructor(private readonly deps: AuthHttpDeps) {
    this.polls = deps.polls ?? new PollStore();
  }

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

    if (req.method === 'POST' && url === '/auth/oidc/begin') {
      const o = this.deps.settings.load().oidc;
      if (!o) { this.json(res, 503, { error: 'oidc not configured' }); return true; }
      const svc = (this.deps.makeOidc ?? ((c: OidcSettings) => new OidcService(c)))(o);
      const pollCode = this.polls.create();
      const state = randomBytes(16).toString('hex');
      this.states.set(state, pollCode);
      const proto = String(req.headers['x-forwarded-proto'] ?? 'http');
      const redirectUri = `${proto}://${String(req.headers.host)}/auth/oidc/callback`;
      try {
        this.json(res, 200, { authUrl: await svc.authUrl(redirectUri, state), pollCode });
      } catch { this.json(res, 502, { error: 'idp unreachable' }); }
      return true;
    }

    if (req.method === 'GET' && url === '/auth/oidc/callback') {
      const q = new URL(req.url ?? '', 'http://x').searchParams;
      const state = q.get('state') ?? ''; const code = q.get('code') ?? '';
      const pollCode = this.states.get(state);
      if (!pollCode || !code) { this.json(res, 400, { error: 'bad state' }); return true; }
      this.states.delete(state); // 1회용
      const o = this.deps.settings.load().oidc;
      if (!o) { this.json(res, 503, { error: 'oidc not configured' }); return true; }
      const svc = (this.deps.makeOidc ?? ((c: OidcSettings) => new OidcService(c)))(o);
      try {
        const proto = String(req.headers['x-forwarded-proto'] ?? 'http');
        const claims = await svc.exchange(code, `${proto}://${String(req.headers.host)}/auth/oidc/callback`);
        let acc = accounts.getByOidc(claims.issuer, claims.sub);
        if (!acc) acc = accounts.createOidc({ issuer: claims.issuer, sub: claims.sub, email: claims.email, displayName: claims.name ?? claims.email ?? claims.sub });
        if (acc.status === 'active') {
          this.polls.complete(pollCode, { token: sessions.issue(acc.id).token, user: toUserDto(acc) });
        } else {
          this.polls.complete(pollCode, { token: '', user: toUserDto(acc) }); // 빈 토큰 = pending 표식
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body>Signed in. Return to the Engram app. / 로그인 완료 — Engram 앱으로 돌아가세요.</body></html>');
      } catch { this.json(res, 502, { error: 'exchange failed' }); }
      return true;
    }

    if (req.method === 'GET' && url === '/auth/oidc/poll') {
      const q = new URL(req.url ?? '', 'http://x').searchParams;
      const r = this.polls.take(q.get('code') ?? '');
      if (!r) { this.json(res, 404, { error: 'unknown' }); return true; }
      if (r.status === 'pending') { this.json(res, 202, { pending: true }); return true; }
      if (!r.token) { this.json(res, 403, { error: 'pending' }); return true; } // 계정 승인 대기
      this.json(res, 200, { token: r.token, user: r.user });
      return true;
    }

    this.json(res, 404, { error: 'unknown' });
    return true;
  }
}
