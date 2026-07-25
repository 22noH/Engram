import { DEFAULT_CONFIRM_MODE, isConfirmMode, type ConfirmMode } from '../../../shared/site-gate';

export type { ConfirmMode };

// 독 패널의 저장 값(순수 로직 + localStorage). Electron 비의존.
//  ① 개발 서버 목록(채널별) — 서버 메뉴
//  ② 허용된 사이트(앱 전역) — 외부 사이트를 열기 전 확인, 한 번 허용하면 기억
//  ③ 토글 두 개(채팅 링크를 이 패널에서 열기 / 세션 유지)
// 전부 "부가 기능이지 신뢰 소스가 아니다" 관례 — 읽기/쓰기 실패는 조용히 기본값으로 간다.

export interface DevServer {
  id: string;
  name: string;
  /** 시작 후 자동으로 이동할 주소의 포트. 0이면 이동하지 않는다. */
  port: number;
  /** 터미널에 그대로 입력할 명령(예: `npm --prefix renderer run dev`). */
  command: string;
}

const SERVERS_KEY = 'engram.dock.servers';
const SITES_KEY = 'engram.dock.allowedSites';
const PREFS_KEY = 'engram.dock.prefs';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw) as unknown;
    return (v && typeof v === 'object') ? (v as T) : fallback;
  } catch { return fallback; }
}

function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 무시 */ }
}

// ---- ① 개발 서버(채널별) ----

let srvSeq = 0;
export function newServerId(): string {
  srvSeq += 1;
  return `srv-${Date.now().toString(36)}-${srvSeq}`;
}

function sanitizeServer(raw: unknown): DevServer | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const command = typeof o.command === 'string' ? o.command.trim() : '';
  if (!name || !command) return null;
  const port = typeof o.port === 'number' && Number.isFinite(o.port) && o.port > 0 && o.port < 65536
    ? Math.floor(o.port) : 0;
  return { id: typeof o.id === 'string' && o.id ? o.id : newServerId(), name, port, command };
}

export function loadServers(channelId: string): DevServer[] {
  const map = readJson<Record<string, unknown>>(SERVERS_KEY, {});
  const list = Array.isArray(map[channelId]) ? (map[channelId] as unknown[]) : [];
  return list.map(sanitizeServer).filter((s): s is DevServer => s !== null);
}

export function saveServers(channelId: string, servers: DevServer[]): void {
  const map = readJson<Record<string, unknown>>(SERVERS_KEY, {});
  const clean = servers.map(sanitizeServer).filter((s): s is DevServer => s !== null);
  if (clean.length) map[channelId] = clean; else delete map[channelId];
  writeJson(SERVERS_KEY, map);
}

/** 이름·명령이 비면 추가하지 않는다(빈 줄이 목록에 쌓이는 것 방지). 추가된 서버를 돌려준다. */
export function addServer(channelId: string, patch: { name: string; port: number | string; command: string }): DevServer | null {
  const port = typeof patch.port === 'string' ? Number(patch.port.trim() || 0) : patch.port;
  const srv = sanitizeServer({ id: newServerId(), name: patch.name, port, command: patch.command });
  if (!srv) return null;
  saveServers(channelId, [...loadServers(channelId), srv]);
  return srv;
}

export function removeServer(channelId: string, id: string): void {
  saveServers(channelId, loadServers(channelId).filter((s) => s.id !== id));
}

/** 서버가 시작되면 이동할 주소. 포트가 없으면 null(이동하지 않는다). */
export function serverUrl(srv: DevServer): string | null {
  return srv.port > 0 ? `http://localhost:${srv.port}` : null;
}

// ---- ② 허용된 사이트(앱 전역) ----
// 내 컴퓨터(localhost·사설망)와 로컬 파일은 확인 없이 연다(url.ts isLocalUrl). 그 밖의 호스트는
// 한 번 확인받고, 허용하면 여기에 남는다. 2단계(AI 웹 조작)의 허용 목록이 그대로 이 자리를 쓴다.

export function loadAllowedSites(): string[] {
  const v = readJson<unknown>(SITES_KEY, []);
  return Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string' && !!h) : [];
}

export function isSiteAllowed(host: string | null): boolean {
  return !!host && loadAllowedSites().includes(host.toLowerCase());
}

/**
 * 이 목록의 **주인은 여기(localStorage)** 다. 메인 프로세스는 게스트 webview의 이동
 * (will-navigate/will-redirect — 렌더러가 취소할 수 없는 자리)을 판정하려고 최신 스냅샷만 받아둔다.
 * 판정 함수 자체는 shared/site-gate.ts 하나를 양쪽이 공유한다(두 벌 금지).
 * 목록이 바뀔 때마다·앱이 뜰 때마다 이걸 부른다.
 */
export function pushAllowedSites(): void {
  try { void window.engramDesktop?.setAllowedSites?.(loadAllowedSites()); } catch { /* 무시 */ }
}

export function allowSite(host: string): void {
  const h = host.trim().toLowerCase();
  if (!h) return;
  const list = loadAllowedSites();
  if (!list.includes(h)) writeJson(SITES_KEY, [...list, h]);
  pushAllowedSites();
}

export function forgetSite(host: string): void {
  writeJson(SITES_KEY, loadAllowedSites().filter((h) => h !== host.toLowerCase()));
  pushAllowedSites();
}

// ---- ③ 토글 ----

export interface DockPrefs {
  /** 채팅 메시지의 링크를 외부 브라우저 대신 이 패널에서 연다. */
  openLinksHere: boolean;
  /** 로그인·쿠키를 기억할지. 기본은 "유지 안 함"(앱과 완전 분리된 비영속 파티션). */
  keepSession: boolean;
  /** AI 웹 조작(2단계) 허용 여부. 꺼져 있으면 두뇌의 조작 요청은 전부 거절된다. */
  agentEnabled: boolean;
  /** 자동 확인 3단계 — 매번 묻기 / 내 컴퓨터에서만(기본) / 항상 자동. */
  confirmMode: ConfirmMode;
}

export const DEFAULT_PREFS: DockPrefs = {
  openLinksHere: false, keepSession: false, agentEnabled: true, confirmMode: DEFAULT_CONFIRM_MODE,
};

export function loadPrefs(): DockPrefs {
  const o = readJson<Record<string, unknown>>(PREFS_KEY, {});
  return {
    openLinksHere: o.openLinksHere === true,
    keepSession: o.keepSession === true,
    // 조작 허용은 기본 켬(목업 ✓) — 대신 확인 단계 기본값이 "내 컴퓨터에서만"이라 외부 사이트는
    // 매 조작 물어본다. 저장값이 없으면(구버전 사용자) 기본값 그대로.
    agentEnabled: o.agentEnabled !== false,
    confirmMode: isConfirmMode(o.confirmMode) ? o.confirmMode : DEFAULT_CONFIRM_MODE,
  };
}

export function savePrefs(p: DockPrefs): void {
  writeJson(PREFS_KEY, {
    openLinksHere: !!p.openLinksHere,
    keepSession: !!p.keepSession,
    agentEnabled: !!p.agentEnabled,
    confirmMode: isConfirmMode(p.confirmMode) ? p.confirmMode : DEFAULT_CONFIRM_MODE,
  });
}

/** 자동 확인 3단계 순환(⋮ 메뉴에서 한 줄을 눌러 돌린다). */
export const CONFIRM_MODES: ConfirmMode[] = ['ask', 'local', 'auto'];
export function nextConfirmMode(m: ConfirmMode): ConfirmMode {
  return CONFIRM_MODES[(CONFIRM_MODES.indexOf(m) + 1) % CONFIRM_MODES.length];
}

/**
 * webview partition — 세션 유지 여부로 갈린다. 둘 다 앱 세션과는 **완전히 분리**된 이름이라
 * 외부 사이트가 앱 쿠키/스토리지에 절대 닿지 않는다(스펙 §안전 설정).
 */
export function previewPartition(keepSession: boolean): string {
  return keepSession ? 'persist:engram-preview' : 'engram-preview';
}
