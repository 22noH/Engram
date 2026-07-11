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
