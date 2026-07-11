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

  it('maxSize 초과 시 가장 오래된 항목 제거(하드 캡)', () => {
    const p = new PollStore(10 * 60 * 1000, 3); // MAX=3
    const codes = [p.create(), p.create(), p.create()]; // now: [c1, c2, c3]
    expect(p.take(codes[0])).toEqual({ status: 'pending' }); // c1 exist
    const c4 = p.create(); // should evict c1 (oldest), keep [c2, c3, c4]
    expect(p.take(codes[0])).toBeNull(); // c1 evicted
    expect(p.take(codes[1])).toEqual({ status: 'pending' }); // c2 still there
    expect(p.take(codes[2])).toEqual({ status: 'pending' }); // c3 still there
    expect(p.take(c4)).toEqual({ status: 'pending' }); // c4 new
  });

  it('만료된 항목 정리(create 시 프룬)', async () => {
    const p = new PollStore(100, 10); // TTL=100ms, MAX=10
    const old = p.create();
    // Wait past TTL
    await new Promise(r => setTimeout(r, 150));
    const fresh = p.create(); // Should prune expired 'old'
    expect(p.take(old)).toBeNull(); // old expired and pruned
    expect(p.take(fresh)).toEqual({ status: 'pending' }); // fresh is there
  });

  it('maxSize<=0로 생성해도 무한 루프 없이 하한 1로 동작', () => {
    // 클램프 전에는 eviction 루프(size >= 0)가 무한 스핀했다.
    const p = new PollStore(10 * 60 * 1000, 0);
    const c1 = p.create();
    const c2 = p.create(); // maxSize=1이므로 c1 축출
    expect(p.take(c1)).toBeNull();
    expect(p.take(c2)).toEqual({ status: 'pending' });
  }, 2000); // 무한 루프 회귀면 타임아웃으로 실패(무한 hang 아님)
});
