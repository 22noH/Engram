import type { UserDto } from '../../shared/protocol';

// 두뇌 /auth/* http 창구 클라이언트. 실패는 { error } 값으로(throw 안 함 — UI 분기 단순화).

export function httpBase(endpoint: string): string {
  return endpoint.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/$/, '');
}

// localFree: 배포 형태 분리(2026-07-19 설계 §2.1) — 계정 0개+루프백 요청이면 true(서버가 붙임).
// true면 렌더러는 게이트를 생략한다(§2.2, 기존 null=무인증 서버와 같은 결).
export interface AuthStatus { configured: boolean; oidc: boolean; serverName?: string; localFree?: boolean }

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
