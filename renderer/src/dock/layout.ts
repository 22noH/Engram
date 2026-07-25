// 코드 독 패널 — 레이아웃 트리(순수 로직).
// 스펙: docs/superpowers/specs/2026-07-25-dock-panel.md §데이터 모델.
//
// 이 파일에는 Electron·React·DOM 의존이 없다(localStorage만 옵셔널로 만진다 — 실패는 전부 무시).
// 이유는 pty-manager.ts와 같은 관례다: 트리 조작·직렬화 같은 "틀리면 화면이 깨지는" 로직은
// 실기 없이 단위 테스트로 못 박아 둔다.
//
// 자유 분할은 **이진 분할의 재귀 트리**로 표현한다. 3칸 이상은 중첩으로 만들어진다
// (예: 좌우 분할한 오른쪽을 다시 상하로 분할 → 3칸). 이게 자유 분할을 표현하는 가장 단순한 모델이고,
// 분할/닫기가 "부모 교체" 한 가지 연산으로 끝난다.

export type DockTool = 'browser' | 'terminal' | 'diff';
export type SplitDir = 'row' | 'col'; // row = 좌우, col = 상하(CSS flex-direction과 같은 뜻)

export interface DockTab {
  id: string;
  title?: string;
  /** 브라우저 탭이 보고 있는 주소(http(s) / file://). data: URL은 퍼시스트에서 제외된다. */
  url?: string;
  /** Diff 탭이 보고 있는 파일 경로(repo 상대). */
  file?: string;
  /** 터미널 탭이 개발 서버 실행용이면 그 서버 id — 서버 메뉴의 실행중 표시가 이걸 본다. */
  serverId?: string;
  /** 터미널 세션이 "새로" 생겼을 때 한 번 자동 입력할 명령(서버 시작). 재접속(리플레이)엔 안 쓴다. */
  command?: string;
}

export interface PaneNode {
  kind: 'pane';
  id: string;
  tool: DockTool;
  tabs: DockTab[];
  activeTabId: string | null;
}

export interface SplitNode {
  kind: 'split';
  id: string;
  dir: SplitDir;
  children: [DockNode, DockNode];
  /** 두 자식의 비율(합 1). 드래그 종료 시에만 확정된다(리사이즈 폭주 방지 — 호출부 책임). */
  sizes: [number, number];
}

export type DockNode = PaneNode | SplitNode;

export interface DockLayout {
  root: DockNode;
  focusedPaneId: string;
}

// ---- id ----
// 세션 내 유일 + 저장된 예전 id와 절대 겹치지 않아야 한다(겹치면 복원 직후 엉뚱한 칸을 조작한다).
// pty-manager.nextSid와 같은 관례(시간 기수36 + 증가 카운터).
let seq = 0;
function nid(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

export function newTabId(): string { return nid('t'); }
export function newPaneId(): string { return nid('p'); }

// ---- 생성 ----

export function makeTab(patch: Partial<DockTab> = {}): DockTab {
  return { id: newTabId(), ...patch };
}

export function makePane(tool: DockTool, tabs: DockTab[] = []): PaneNode {
  const list = tabs.length ? tabs : [makeTab()];
  return { kind: 'pane', id: newPaneId(), tool, tabs: list, activeTabId: list[0].id };
}

/** 도구 하나짜리 기본 레이아웃(칸 1개·탭 1개). 깨진 퍼시스트 값의 폴백이기도 하다. */
export function defaultLayout(tool: DockTool): DockLayout {
  const pane = makePane(tool);
  return { root: pane, focusedPaneId: pane.id };
}

// ---- 탐색 ----

export function listPanes(node: DockNode): PaneNode[] {
  if (node.kind === 'pane') return [node];
  return [...listPanes(node.children[0]), ...listPanes(node.children[1])];
}

export function findPane(layout: DockLayout, paneId: string): PaneNode | null {
  return listPanes(layout.root).find((p) => p.id === paneId) ?? null;
}

/** 지금 포커스된 칸(없으면 첫 칸). 포커스 id가 낡아도 절대 null을 돌려주지 않는다. */
export function focusedPane(layout: DockLayout): PaneNode {
  return findPane(layout, layout.focusedPaneId) ?? listPanes(layout.root)[0];
}

/** 그 도구를 쓰는 첫 칸(레일 하이라이트·"이 도구 열기"가 쓴다). */
export function findPaneByTool(layout: DockLayout, tool: DockTool): PaneNode | null {
  return listPanes(layout.root).find((p) => p.tool === tool) ?? null;
}

/**
 * pty 세션 키 — 예전엔 채널 id 하나였지만 독 패널에선 터미널 탭이 여럿이라 탭 단위로 쪼갠다.
 * 탭 id가 localStorage에 남으므로, 패널을 접었다 펴도 **같은 키 = 같은 세션**이라 리플레이로
 * 그대로 이어진다(패널만 접을 땐 세션을 죽이지 않는다는 기존 불변식이 이걸로 성립한다).
 */
export function ptySessionKey(channelId: string, tabId: string): string {
  return `${channelId}#${tabId}`;
}

/** 이 레이아웃이 들고 있는 모든 터미널 탭의 세션 키(칸/탭 닫기 시 kill 대상 계산용). */
export function terminalTabIds(node: DockNode): string[] {
  return listPanes(node).filter((p) => p.tool === 'terminal').flatMap((p) => p.tabs.map((t) => t.id));
}

// ---- 트리 재작성(공통) ----
// 노드 하나를 다른 노드로 갈아끼운다(없으면 원본 그대로). 분할·닫기·탭 조작이 전부 이걸 쓴다.
function replaceNode(node: DockNode, targetId: string, next: DockNode | null): DockNode | null {
  if (node.id === targetId) return next;
  if (node.kind === 'pane') return node;
  const a = replaceNode(node.children[0], targetId, next);
  const b = replaceNode(node.children[1], targetId, next);
  if (a === node.children[0] && b === node.children[1]) return node;
  // 한쪽이 사라지면 분할 자체가 없어지고 남은 쪽이 그 자리를 차지한다(빈 칸이 남지 않는다).
  if (!a) return b;
  if (!b) return a;
  return { ...node, children: [a, b] };
}

function mapPane(node: DockNode, paneId: string, fn: (p: PaneNode) => PaneNode): DockNode {
  if (node.kind === 'pane') return node.id === paneId ? fn(node) : node;
  const a = mapPane(node.children[0], paneId, fn);
  const b = mapPane(node.children[1], paneId, fn);
  if (a === node.children[0] && b === node.children[1]) return node;
  return { ...node, children: [a, b] };
}

// ---- 분할 / 닫기 ----

/**
 * paneId 칸을 dir 방향으로 쪼개고 새 칸(tool)을 뒤쪽에 만든다. 포커스는 새 칸으로 옮긴다.
 * 반쪽씩(0.5/0.5) 시작 — 사용자는 경계 드래그로 조절한다.
 */
export function splitPane(layout: DockLayout, paneId: string, dir: SplitDir, tool: DockTool, tabs?: DockTab[]): DockLayout {
  const target = findPane(layout, paneId);
  if (!target) return layout;
  const created = makePane(tool, tabs);
  const split: SplitNode = {
    kind: 'split', id: nid('s'), dir, children: [target, created], sizes: [0.5, 0.5],
  };
  const root = replaceNode(layout.root, paneId, split);
  if (!root) return layout;
  return { root, focusedPaneId: created.id };
}

/**
 * 칸을 닫는다. 마지막 칸을 닫으면 null(=독 자체를 닫는다)을 돌려준다.
 * removed는 호출부가 터미널 세션 kill 대상을 계산하는 데 쓴다.
 */
export function closePane(layout: DockLayout, paneId: string): { layout: DockLayout | null; removed: PaneNode | null } {
  const removed = findPane(layout, paneId);
  if (!removed) return { layout, removed: null };
  const root = replaceNode(layout.root, paneId, null);
  if (!root) return { layout: null, removed };
  const panes = listPanes(root);
  const focusedPaneId = panes.some((p) => p.id === layout.focusedPaneId) ? layout.focusedPaneId : panes[0].id;
  return { layout: { root, focusedPaneId }, removed };
}

/** 경계 드래그 결과 확정. 0.08~0.92로 제한해 한쪽이 완전히 사라지는 것을 막는다. */
export function resizeSplit(layout: DockLayout, splitId: string, first: number): DockLayout {
  const clamped = Math.min(0.92, Math.max(0.08, Number.isFinite(first) ? first : 0.5));
  const walk = (node: DockNode): DockNode => {
    if (node.kind === 'pane') return node;
    if (node.id === splitId) return { ...node, sizes: [clamped, 1 - clamped] };
    const a = walk(node.children[0]);
    const b = walk(node.children[1]);
    if (a === node.children[0] && b === node.children[1]) return node;
    return { ...node, children: [a, b] };
  };
  return { ...layout, root: walk(layout.root) };
}

// ---- 탭 ----

export function addTab(layout: DockLayout, paneId: string, tab: DockTab): DockLayout {
  const root = mapPane(layout.root, paneId, (p) => ({ ...p, tabs: [...p.tabs, tab], activeTabId: tab.id }));
  return { ...layout, root, focusedPaneId: paneId };
}

export function setActiveTab(layout: DockLayout, paneId: string, tabId: string): DockLayout {
  const root = mapPane(layout.root, paneId, (p) =>
    (p.tabs.some((t) => t.id === tabId) ? { ...p, activeTabId: tabId } : p));
  return { ...layout, root, focusedPaneId: paneId };
}

export function updateTab(layout: DockLayout, paneId: string, tabId: string, patch: Partial<DockTab>): DockLayout {
  const root = mapPane(layout.root, paneId, (p) => {
    const i = p.tabs.findIndex((t) => t.id === tabId);
    if (i < 0) return p;
    const tabs = p.tabs.slice();
    tabs[i] = { ...tabs[i], ...patch };
    return { ...p, tabs };
  });
  return { ...layout, root };
}

/**
 * 탭을 닫는다. 마지막 탭을 닫으면 그 칸도 닫힌다(칸이 마지막이면 독 전체가 닫힌다 → layout null).
 * removedTabIds = 이 조작으로 사라진 탭 전부(터미널이면 그대로 kill 대상).
 */
export function closeTab(layout: DockLayout, paneId: string, tabId: string): { layout: DockLayout | null; removedTabIds: string[] } {
  const pane = findPane(layout, paneId);
  if (!pane || !pane.tabs.some((t) => t.id === tabId)) return { layout, removedTabIds: [] };
  if (pane.tabs.length === 1) {
    const res = closePane(layout, paneId);
    return { layout: res.layout, removedTabIds: res.removed ? res.removed.tabs.map((t) => t.id) : [] };
  }
  const idx = pane.tabs.findIndex((t) => t.id === tabId);
  const tabs = pane.tabs.filter((t) => t.id !== tabId);
  // 활성 탭을 닫으면 왼쪽 이웃(없으면 첫 탭)으로 — 브라우저 관례.
  const activeTabId = pane.activeTabId === tabId ? tabs[Math.max(0, idx - 1)].id : pane.activeTabId;
  const root = mapPane(layout.root, paneId, (p) => ({ ...p, tabs, activeTabId }));
  return { layout: { ...layout, root }, removedTabIds: [tabId] };
}

export function focusPane(layout: DockLayout, paneId: string): DockLayout {
  return findPane(layout, paneId) ? { ...layout, focusedPaneId: paneId } : layout;
}

// ---- 직렬화 ----
// 저장은 부가 기능이지 신뢰 소스가 아니다(기존 CodePanel 퍼시스트 관례) — 어떤 쓰레기 값이 들어와도
// parse는 null을 주고 호출부가 기본 레이아웃으로 간다. 절대 throw하지 않는다.

const TOOLS: DockTool[] = ['browser', 'terminal', 'diff'];

function serializeTab(t: DockTab): DockTab | null {
  // data: URL(= HTML "크게 보기"로 띄운 임시 문서)은 저장하지 않는다 — 수 MB짜리가 localStorage를
  // 통째로 날려먹을 수 있고, 다음 실행에 되살릴 의미도 없다. 그런 탭은 통째로 뺀다.
  if (t.url && t.url.startsWith('data:')) return null;
  const out: DockTab = { id: t.id };
  if (t.title) out.title = t.title;
  if (t.url) out.url = t.url;
  if (t.file) out.file = t.file;
  if (t.serverId) out.serverId = t.serverId;
  // command도 저장한다: 앱을 껐다 켜면 그 탭의 세션은 사라지므로, 탭을 다시 열 때 명령이 남아 있어야
  // 개발 서버가 실제로 다시 뜬다(이름만 서버인 빈 셸이 남지 않게).
  if (t.command) out.command = t.command;
  return out;
}

function serializeNode(node: DockNode): unknown | null {
  if (node.kind === 'pane') {
    const tabs = node.tabs.map(serializeTab).filter((t): t is DockTab => t !== null);
    if (!tabs.length) return null; // 남는 탭이 없으면 칸 자체를 버린다
    const activeTabId = tabs.some((t) => t.id === node.activeTabId) ? node.activeTabId : tabs[0].id;
    return { kind: 'pane', id: node.id, tool: node.tool, tabs, activeTabId };
  }
  const a = serializeNode(node.children[0]);
  const b = serializeNode(node.children[1]);
  if (!a) return b;
  if (!b) return a;
  return { kind: 'split', id: node.id, dir: node.dir, children: [a, b], sizes: node.sizes };
}

export function serializeLayout(layout: DockLayout): string | null {
  try {
    const root = serializeNode(layout.root);
    if (!root) return null;
    return JSON.stringify({ v: 1, root, focusedPaneId: layout.focusedPaneId });
  } catch { return null; }
}

function parseNode(raw: unknown): DockNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === 'pane') {
    const tool = TOOLS.includes(o.tool as DockTool) ? (o.tool as DockTool) : null;
    if (!tool || typeof o.id !== 'string') return null;
    const rawTabs = Array.isArray(o.tabs) ? o.tabs : [];
    const tabs: DockTab[] = [];
    for (const rt of rawTabs) {
      if (!rt || typeof rt !== 'object') continue;
      const t = rt as Record<string, unknown>;
      if (typeof t.id !== 'string') continue;
      const tab: DockTab = { id: t.id };
      if (typeof t.title === 'string') tab.title = t.title;
      if (typeof t.url === 'string' && !t.url.startsWith('data:')) tab.url = t.url;
      if (typeof t.file === 'string') tab.file = t.file;
      if (typeof t.serverId === 'string') tab.serverId = t.serverId;
      if (typeof t.command === 'string') tab.command = t.command;
      tabs.push(tab);
    }
    if (!tabs.length) return null;
    const activeTabId = typeof o.activeTabId === 'string' && tabs.some((t) => t.id === o.activeTabId)
      ? o.activeTabId : tabs[0].id;
    return { kind: 'pane', id: o.id, tool, tabs, activeTabId };
  }
  if (o.kind === 'split') {
    const kids = Array.isArray(o.children) ? o.children : [];
    const a = parseNode(kids[0]);
    const b = parseNode(kids[1]);
    if (!a && !b) return null;
    if (!a) return b;
    if (!b) return a;
    const dir: SplitDir = o.dir === 'row' ? 'row' : 'col';
    const rawSizes = Array.isArray(o.sizes) ? o.sizes : [];
    const first = typeof rawSizes[0] === 'number' && Number.isFinite(rawSizes[0])
      ? Math.min(0.92, Math.max(0.08, rawSizes[0] as number)) : 0.5;
    return {
      kind: 'split', id: typeof o.id === 'string' ? o.id : nid('s'),
      dir, children: [a, b], sizes: [first, 1 - first],
    };
  }
  return null;
}

/** 깨진 값·구버전·null 전부 null로(호출부가 기본 레이아웃으로 폴백). 절대 throw하지 않는다. */
export function parseLayout(raw: string | null | undefined): DockLayout | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const root = parseNode(o?.root);
    if (!root) return null;
    const panes = listPanes(root);
    // 같은 id가 두 번 나오면(손으로 고친 값 등) 조작이 엉뚱한 칸에 가므로 통째로 버린다.
    const ids = new Set(panes.map((p) => p.id));
    if (ids.size !== panes.length) return null;
    const focusedPaneId = typeof o.focusedPaneId === 'string' && ids.has(o.focusedPaneId)
      ? o.focusedPaneId : panes[0].id;
    return { root, focusedPaneId };
  } catch { return null; }
}

// ---- 퍼시스트(채널별) ----
// 기존 단일 패널 키(engram.codePanel.open: 채널→'terminal'|'preview'|'diff')는 **읽기 전용 이관
// 소스**로만 남긴다: 독 레이아웃이 없고 예전 값이 있으면 그 도구 하나짜리 기본 레이아웃으로 연다
// (기존 사용자가 앱을 켰을 때 패널이 사라진 것처럼 보이지 않게 — 회귀 0 요건).

const DOCK_KEY = 'engram.dock.layout';
const LEGACY_KEY = 'engram.codePanel.open';

function readMap(key: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const o = JSON.parse(raw) as unknown;
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
  } catch { return {}; }
}

export function legacyToolFor(channelId: string): DockTool | null {
  const v = readMap(LEGACY_KEY)[channelId];
  if (v === 'terminal' || v === 'diff') return v;
  if (v === 'preview') return 'browser'; // 예전 '미리보기' 탭 = 지금의 브라우저 칸
  return null;
}

/** 그 채널의 저장된 독 레이아웃. 없거나 깨졌으면 예전 단일 패널 값으로 이관, 그것도 없으면 null(=닫힘). */
export function loadDock(channelId: string): DockLayout | null {
  const raw = readMap(DOCK_KEY)[channelId];
  const parsed = parseLayout(typeof raw === 'string' ? raw : null);
  if (parsed) return parsed;
  const legacy = legacyToolFor(channelId);
  return legacy ? defaultLayout(legacy) : null;
}

/** null이면 그 채널을 닫힘으로 기록한다(예전 키 항목도 함께 지워 이관이 되살아나지 않게). */
export function saveDock(channelId: string, layout: DockLayout | null): void {
  try {
    const map = readMap(DOCK_KEY);
    const ser = layout ? serializeLayout(layout) : null;
    if (ser) map[channelId] = ser; else delete map[channelId];
    localStorage.setItem(DOCK_KEY, JSON.stringify(map));
    const legacy = readMap(LEGACY_KEY);
    if (channelId in legacy) {
      delete legacy[channelId];
      localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy));
    }
  } catch { /* 퍼시스트 실패는 무시 — 이번 세션만 상태로 동작(기존 관례) */ }
}
