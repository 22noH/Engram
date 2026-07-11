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
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlMs?: number, maxSize?: number) {
    this.ttlMs = ttlMs ?? 10 * 60 * 1000;
    this.maxSize = Math.max(1, maxSize ?? 10000); // <1이면 eviction 루프가 무한 스핀 — 하한 1로 클램프.
  }

  create(): string {
    const now = Date.now();

    // Prune expired entries
    for (const [code, entry] of this.map.entries()) {
      if (entry.exp <= now) {
        this.map.delete(code);
      }
    }

    // Evict oldest entries if at or over max size
    while (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest) this.map.delete(oldest);
    }

    const code = randomBytes(16).toString('hex');
    this.map.set(code, { exp: now + this.ttlMs });
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
