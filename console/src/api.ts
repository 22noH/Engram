import type { UserDto } from '../../shared/protocol';

// 콘솔 세션·API 창구. 데스크톱 렌더러의 auth-api.ts와 같은 결(실패는 { error }로, throw 안 함).
// 콘솔은 서버가 자기 자신을 /admin 등에서 서빙하므로 endpoint 파라미터 없이 상대경로만 쓴다.

const SESSION_KEY = 'engram.console.session';

export interface Session { token: string; user: UserDto }

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Session>;
    return s && typeof s.token === 'string' && s.user ? (s as Session) : null;
  } catch { return null; }
}

export function saveSession(s: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

// 401 응답 시 App이 구독해 Login으로 복귀 — 컴포넌트 트리를 관통하는 prop 없이 전역 처리.
export const UNAUTHORIZED_EVENT = 'engram:console:unauthorized';

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const session = loadSession();
  const headers = new Headers(init.headers);
  if (session) headers.set('authorization', `Bearer ${session.token}`);
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    clearSession();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  return res;
}

export interface AuthStatus { configured: boolean; oidc: boolean; serverName?: string; localFree?: boolean }

export async function fetchStatus(): Promise<AuthStatus | null> {
  try {
    const r = await fetch('/auth/status');
    if (!r.ok) return null;
    return await r.json() as AuthStatus;
  } catch { return null; }
}

async function postAuth(path: string, body: unknown): Promise<Session | { error: string }> {
  try {
    const r = await fetch(path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const b = await r.json().catch(() => ({}));
    if (r.ok) return b as Session;
    return { error: typeof (b as { error?: string }).error === 'string' ? (b as { error: string }).error : `http ${r.status}` };
  } catch { return { error: 'network' }; }
}

export const apiSetup = (code: string, loginId: string, password: string) =>
  postAuth('/auth/setup', { code, loginId, password });
export const apiLogin = (loginId: string, password: string) =>
  postAuth('/auth/login', { loginId, password });

// T2의 계약(개요 타일 4개 + 처리할 일 2종) — Task 2가 구현.
export interface Overview {
  members: number; pendingMembers: number; channels: number;
  wikiPages: number; pendingProposals: number; todayMessages: number;
  pendingMemberNames: string[]; pendingProposalTitles: string[];
}

export async function fetchOverview(): Promise<Overview | null> {
  try {
    const r = await apiFetch('/admin/api/overview');
    if (!r.ok) return null;
    return await r.json().catch(() => null) as Overview | null;
  } catch { return null; }
}

// ── 멤버·그룹·채널(서버 콘솔 S2 Task 3 — admin-http.ts의 계약 그대로 미러) ──────────

export interface MemberDto {
  id: string; loginId: string; displayName: string; role: string;
  status: 'pending' | 'active' | 'suspended'; permissions: string[]; groups: string[];
}

function postJson(path: string, body: unknown, method = 'POST'): Promise<Response> {
  return apiFetch(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export async function fetchMembers(): Promise<MemberDto[] | null> {
  try {
    const r = await apiFetch('/admin/api/members');
    if (!r.ok) return null;
    const b = await r.json().catch(() => null) as { members?: MemberDto[] } | null;
    return b?.members ?? null;
  } catch { return null; }
}

export async function createMember(
  loginId: string, displayName: string, password: string, groupId?: string,
): Promise<MemberDto | { error: string }> {
  try {
    const r = await postJson('/admin/api/members', { loginId, displayName, password, ...(groupId ? { groupId } : {}) });
    const b = await r.json().catch(() => ({})) as { member?: MemberDto; error?: string };
    if (r.ok && b.member) return b.member;
    return { error: b.error ?? `http ${r.status}` };
  } catch { return { error: 'network' }; }
}

export async function setMemberStatus(id: string, status: 'active' | 'suspended'): Promise<boolean> {
  try {
    const r = await postJson(`/admin/api/members/${encodeURIComponent(id)}/status`, { status });
    return r.ok;
  } catch { return false; }
}

export async function setMemberPermissions(id: string, permissions: string[]): Promise<boolean> {
  try {
    const r = await postJson(`/admin/api/members/${encodeURIComponent(id)}/permissions`, { permissions });
    return r.ok;
  } catch { return false; }
}

export interface GroupDto {
  id: string; name: string; memberIds: string[]; permissions: string[]; channelIds: string[]; createdAt: string;
}

export async function fetchGroups(): Promise<GroupDto[] | null> {
  try {
    const r = await apiFetch('/admin/api/groups');
    if (!r.ok) return null;
    const b = await r.json().catch(() => null) as { groups?: GroupDto[] } | null;
    return b?.groups ?? null;
  } catch { return null; }
}

export async function createGroup(name: string): Promise<GroupDto | null> {
  try {
    const r = await postJson('/admin/api/groups', { name });
    if (!r.ok) return null;
    const b = await r.json().catch(() => null) as { group?: GroupDto } | null;
    return b?.group ?? null;
  } catch { return null; }
}

export interface GroupPatch { name?: string; memberIds?: string[]; permissions?: string[]; channelIds?: string[] }

export async function patchGroup(id: string, patch: GroupPatch): Promise<GroupDto | null> {
  try {
    const r = await postJson(`/admin/api/groups/${encodeURIComponent(id)}`, patch, 'PATCH');
    if (!r.ok) return null;
    const b = await r.json().catch(() => null) as { group?: GroupDto } | null;
    return b?.group ?? null;
  } catch { return null; }
}

export async function deleteGroup(id: string): Promise<boolean> {
  try {
    const r = await apiFetch(`/admin/api/groups/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return r.ok;
  } catch { return false; }
}

export interface ChannelDto {
  id: string; name: string; mode: string; visibility: 'public' | 'private'; memberCount: number; brain?: string;
}

export async function fetchChannels(): Promise<ChannelDto[] | null> {
  try {
    const r = await apiFetch('/admin/api/channels');
    if (!r.ok) return null;
    const b = await r.json().catch(() => null) as { channels?: ChannelDto[] } | null;
    return b?.channels ?? null;
  } catch { return null; }
}

export async function setChannelVisibility(id: string, visibility: 'public' | 'private'): Promise<boolean> {
  try {
    const r = await postJson(`/admin/api/channels/${encodeURIComponent(id)}/visibility`, { visibility });
    return r.ok;
  } catch { return false; }
}

export async function deleteChannel(id: string): Promise<boolean> {
  try {
    const r = await apiFetch(`/admin/api/channels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return r.ok;
  } catch { return false; }
}
