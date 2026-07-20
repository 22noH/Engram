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

export async function resetMemberPassword(id: string): Promise<{ tempPassword: string } | { error: string }> {
  try {
    const r = await postJson(`/admin/api/members/${encodeURIComponent(id)}/reset-password`, {});
    const b = await r.json().catch(() => ({})) as { tempPassword?: string; error?: string };
    if (r.ok && typeof b.tempPassword === 'string') return { tempPassword: b.tempPassword };
    return { error: b.error ?? `http ${r.status}` };
  } catch { return { error: 'network' }; }
}

export async function deleteMember(id: string): Promise<boolean> {
  try {
    const r = await apiFetch(`/admin/api/members/${encodeURIComponent(id)}`, { method: 'DELETE' });
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
  groups: string[]; // 이 채널을 접근 목록에 넣은 그룹명 — 콘솔 3단계 배지(공개/그룹 한정/비공개) 판정 재료.
}

export async function fetchChannels(): Promise<ChannelDto[] | null> {
  try {
    const r = await apiFetch('/admin/api/channels');
    if (!r.ok) return null;
    const b = await r.json().catch(() => null) as { channels?: ChannelDto[] } | null;
    return b?.channels ?? null;
  } catch { return null; }
}

export interface ChannelDetailDto {
  id: string; name: string; visibility: 'public' | 'private'; memberIds: string[]; groupIds: string[];
}

export async function fetchChannelDetail(id: string): Promise<ChannelDetailDto | null> {
  try {
    const r = await apiFetch(`/admin/api/channels/${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    return await r.json().catch(() => null) as ChannelDetailDto | null;
  } catch { return null; }
}

export async function setChannelVisibility(id: string, visibility: 'public' | 'private'): Promise<boolean> {
  try {
    const r = await postJson(`/admin/api/channels/${encodeURIComponent(id)}/visibility`, { visibility });
    return r.ok;
  } catch { return false; }
}

export async function setChannelMembers(id: string, memberIds: string[]): Promise<boolean> {
  try {
    const r = await postJson(`/admin/api/channels/${encodeURIComponent(id)}/members`, { memberIds });
    return r.ok;
  } catch { return false; }
}

export async function setChannelGroups(id: string, groupIds: string[]): Promise<boolean> {
  try {
    const r = await postJson(`/admin/api/channels/${encodeURIComponent(id)}/groups`, { groupIds });
    return r.ok;
  } catch { return false; }
}

export async function deleteChannel(id: string): Promise<boolean> {
  try {
    const r = await apiFetch(`/admin/api/channels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return r.ok;
  } catch { return false; }
}

// ── 모델·MCP·위키·서버설정·배포(서버 콘솔 S3 Task 3 — admin-http.ts의 계약 그대로 미러) ──────

export interface ModelDto { key: string; provider: string; model: string; isDefault: boolean; hasApiKey: boolean }
export interface ModelsData { default: string; harness: 'cli' | 'engram'; models: ModelDto[] }

export async function fetchModels(): Promise<ModelsData | null> {
  try {
    const r = await apiFetch('/admin/api/models');
    if (!r.ok) return null;
    return await r.json().catch(() => null) as ModelsData | null;
  } catch { return null; }
}

export async function addOllamaModel(model: string, name: string): Promise<boolean> {
  try {
    const r = await postJson('/admin/api/models/ollama', { model, name });
    return r.ok;
  } catch { return false; }
}

// apiKey는 저장 헬퍼로 그대로 넘어갈 뿐 이 함수가 반환하는 값에는 절대 담기지 않는다
// (호출부가 성공 여부만 boolean으로 받아 입력칸을 비우는 데 쓴다 — 원문을 되돌려줄 경로 자체가 없음).
export async function saveModelApiKey(apiKey: string): Promise<boolean> {
  try {
    const r = await postJson('/admin/api/models/api-key', { apiKey });
    return r.ok;
  } catch { return false; }
}

export async function setDefaultModel(key: string): Promise<boolean> {
  try {
    const r = await postJson('/admin/api/models/default', { key });
    return r.ok;
  } catch { return false; }
}

export async function deleteModel(key: string): Promise<boolean> {
  try {
    const r = await apiFetch(`/admin/api/models/${encodeURIComponent(key)}`, { method: 'DELETE' });
    return r.ok;
  } catch { return false; }
}

export interface McpServerDto { name: string; command?: string; args?: string[]; url?: string; source?: 'claude' }

export async function fetchMcp(): Promise<McpServerDto[] | null> {
  try {
    const r = await apiFetch('/admin/api/mcp');
    if (!r.ok) return null;
    const b = await r.json().catch(() => null) as { servers?: McpServerDto[] } | null;
    return b?.servers ?? null;
  } catch { return null; }
}

export async function addMcp(name: string, commandOrUrl: string): Promise<boolean> {
  try {
    const r = await postJson('/admin/api/mcp', { name, commandOrUrl });
    return r.ok;
  } catch { return false; }
}

export async function deleteMcp(name: string): Promise<boolean> {
  try {
    const r = await apiFetch(`/admin/api/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' });
    return r.ok;
  } catch { return false; }
}

export interface WikiData { remote: { url?: string; branch?: string }; pages: number; pendingProposals: number }

export async function fetchWiki(): Promise<WikiData | null> {
  try {
    const r = await apiFetch('/admin/api/wiki');
    if (!r.ok) return null;
    return await r.json().catch(() => null) as WikiData | null;
  } catch { return null; }
}

export async function saveWikiRemote(url: string, branch: string): Promise<boolean> {
  try {
    const r = await postJson('/admin/api/wiki/remote', { url, branch });
    return r.ok;
  } catch { return false; }
}

export type Exposure = 'local' | 'lan' | 'internet';
export type CodingMode = 'auto' | 'allowlist' | 'off';

export interface ServerSettingsData {
  serverName?: string; port: number; bind: string; exposure: Exposure;
  oidcIssuer?: string; oidcClientId?: string; hasOidcSecret: boolean; codingMode: CodingMode;
}

export async function fetchServerSettings(): Promise<ServerSettingsData | null> {
  try {
    const r = await apiFetch('/admin/api/server-settings');
    if (!r.ok) return null;
    return await r.json().catch(() => null) as ServerSettingsData | null;
  } catch { return null; }
}

export interface ServerSettingsPatch {
  serverName?: string; port?: string | number; exposure?: Exposure;
  oidc?: { issuer: string; clientId: string; clientSecret?: string };
  codingMode?: CodingMode;
}

// clientSecret은 빈 값이면 서버가 기존 값을 보존한다(admin-http.ts saveServerSettings 계약) —
// 여기서도 원문을 응답으로 되받지 않는다(boolean만).
export async function saveServerSettings(patch: ServerSettingsPatch): Promise<boolean> {
  try {
    const r = await postJson('/admin/api/server-settings', patch);
    return r.ok;
  } catch { return false; }
}

// preset.json은 다운로드 유도용(admin-http.ts가 content-disposition: attachment로 응답) — blob으로
// 받아 호출부(DeployCard)가 objectURL+임시 <a>.click()으로 브라우저 저장 대화상자를 띄운다.
export async function fetchPresetBlob(): Promise<Blob | null> {
  try {
    const r = await apiFetch('/admin/api/preset');
    if (!r.ok) return null;
    return await r.blob();
  } catch { return null; }
}
