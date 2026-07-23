import type { UserDto, AttachmentMeta } from '../../shared/protocol';

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

// 채팅 첨부(Task 4) — 업로드/다운로드 헬퍼. /auth/*와 같은 결로 httpBase 재사용, 실패는 값으로.

// 업로드: raw body(요청 스펙 — multipart 아님), Content-Type=파일 mime, x-attachment-name=인코딩된
// 원본 파일명, 세션 있는 연결은 Authorization: Bearer(무인증 로컬 연결은 헤더 생략 — 서버가 localFree로 게이트 생략).
export async function uploadAttachment(
  endpoint: string, channelId: string, file: File, token?: string,
): Promise<AttachmentMeta | { error: string }> {
  try {
    const headers: Record<string, string> = {
      'content-type': file.type || 'application/octet-stream',
      'x-attachment-name': encodeURIComponent(file.name),
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(`${httpBase(endpoint)}/attachments/${encodeURIComponent(channelId)}`, {
      method: 'POST', headers, body: file,
    });
    const body = await r.json().catch(() => ({}));
    if (r.ok) return body as AttachmentMeta;
    return { error: typeof (body as { error?: string }).error === 'string' ? (body as { error: string }).error : `http ${r.status}` };
  } catch { return { error: 'network' }; }
}

export function attachmentUrl(endpoint: string, channelId: string, id: string): string {
  return `${httpBase(endpoint)}/attachments/${encodeURIComponent(channelId)}/${encodeURIComponent(id)}`;
}

// 다운로드를 blob URL로: 인증 연결은 <img src>/평범한 링크가 Authorization 헤더를 못 실어(브라우저
// 한계) fetch+blob으로 통일한다(무인증도 같은 경로 — 렌더러 단순화, 브리프 재량 허용).
// 실패(네트워크·401/403/404)는 null — 호출부가 로딩 상태로 남겨두고 조용히 포기한다.
export async function fetchAttachmentBlobUrl(
  endpoint: string, channelId: string, id: string, token?: string,
): Promise<string | null> {
  try {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(attachmentUrl(endpoint, channelId, id), { headers });
    if (!r.ok) return null;
    const blob = await r.blob();
    return URL.createObjectURL(blob);
  } catch { return null; }
}
