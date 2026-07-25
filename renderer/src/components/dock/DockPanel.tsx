import { useCallback, useEffect, useRef, useState } from 'react';
import { T } from '../../i18n';
import {
  addTab, closePane, closeTab, type DockLayout, type DockNode, type DockTab, type DockTool,
  findPane, findPaneByTool, focusedPane, focusPane, makeTab, type PaneNode, ptySessionKey,
  resizeSplit, setActiveTab, type SplitDir, type SplitNode, splitPane, updateTab,
} from '../../dock/layout';
import { type DevServer, type DockPrefs, loadPrefs, loadServers, savePrefs, serverUrl } from '../../dock/prefs';
import { toNavUrl, urlTitle } from '../../dock/url';
import { getView } from '../../dock/views';
import { BrowserPane } from './BrowserPane';
import { MoreMenu, ServerMenu } from './BrowserMenus';
import { DiffPane } from './DiffPane';
import { TerminalPane } from './TerminalPane';

// 코드 독 패널 — 자유 분할(이진 분할 재귀 트리) + 칸마다 탭.
// 레이아웃 상태는 App이 들고(채널별 퍼시스트), 여기선 트리를 그리고 조작 결과를 위로 올린다.
//
// 세션 불변식(기존 규칙 + 스펙 §함정):
//  · 탭/칸을 **닫으면** 그 터미널 세션을 kill한다(ptyKillKey — sid를 몰라도 키로 죽인다).
//  · 패널만 **접거나** 채널/모드를 옮기면 kill하지 않는다(언마운트는 구독 해제만).
//  · 앱 종료 시엔 메인의 before-quit killAll이 키 개수만큼 전부 정리한다.

const MIN_RATIO = 0.08;

// 패널 전체 폭(채팅 칼럼과의 경계) — 기존 코드 패널과 같은 키를 그대로 쓴다(폭 설정 이관).
const WIDTH_KEY = 'engram.codePanel.width';
const DEFAULT_WIDTH = 520;
const MIN_WIDTH = 320;

function loadWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(n) && n >= MIN_WIDTH ? n : DEFAULT_WIDTH;
  } catch { return DEFAULT_WIDTH; }
}
function clampWidth(n: number): number {
  const max = (typeof window !== 'undefined' ? window.innerWidth : 1200) * 0.8;
  return Math.min(Math.max(max, MIN_WIDTH), Math.max(MIN_WIDTH, n));
}

export function DockPanel({ channelId, repoPath, layout, onLayout }: {
  channelId: string;
  repoPath: string;
  layout: DockLayout;
  /** null이면 독을 닫는다(마지막 칸이 닫힌 경우). */
  onLayout: (next: DockLayout | null) => void;
}) {
  const [prefs, setPrefs] = useState<DockPrefs>(() => loadPrefs());
  const [menu, setMenu] = useState<{ paneId: string; kind: 'server' | 'more' } | null>(null);
  const [maximized, setMaximized] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [servers, setServers] = useState<DevServer[]>(() => loadServers(channelId));
  const [runningIds, setRunningIds] = useState<string[]>([]);
  const [shellNames, setShellNames] = useState<Record<string, string>>({});
  const [diffCounts, setDiffCounts] = useState<Record<string, number>>({});
  const [width, setWidth] = useState<number>(() => clampWidth(loadWidth()));
  const widthDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { widthDragRef.current?.(); widthDragRef.current = null; }, []);

  // 채팅 칼럼과의 경계 드래그(기존 코드 패널과 동일한 동작·저장 키).
  const onWidthDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const move = (ev: MouseEvent) => setWidth(clampWidth(startWidth + (startX - ev.clientX)));
    const detach = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      widthDragRef.current = null;
    };
    const up = () => {
      detach();
      setWidth((w) => { try { localStorage.setItem(WIDTH_KEY, String(Math.round(w))); } catch { /* 무시 */ } return w; });
    };
    widthDragRef.current = detach;
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  useEffect(() => { setServers(loadServers(channelId)); setMenu(null); setMaximized(null); }, [channelId]);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  const applyPrefs = (next: DockPrefs) => { setPrefs(next); savePrefs(next); };

  // ---- 세션 정리 ----
  // 닫히는 터미널 탭의 세션만 죽인다. 브라우저/Diff 탭은 죽일 게 없다.
  const killTabs = useCallback((tool: DockTool, tabIds: string[]) => {
    if (tool !== 'terminal') return;
    for (const id of tabIds) void window.engramDesktop?.ptyKillKey?.(ptySessionKey(channelId, id));
  }, [channelId]);

  // ---- 레이아웃 조작 ----
  const doCloseTab = (pane: PaneNode, tabId: string) => {
    const res = closeTab(layout, pane.id, tabId);
    killTabs(pane.tool, res.removedTabIds);
    onLayout(res.layout);
  };
  const doClosePane = (pane: PaneNode) => {
    const res = closePane(layout, pane.id);
    if (res.removed) killTabs(res.removed.tool, res.removed.tabs.map((t) => t.id));
    if (maximized === pane.id) setMaximized(null);
    onLayout(res.layout);
  };
  const doSplit = (pane: PaneNode, dir: SplitDir) => {
    setMaximized(null);
    onLayout(splitPane(layout, pane.id, dir, pane.tool));
  };
  const doNewTab = (pane: PaneNode, patch?: Partial<DockTab>) => onLayout(addTab(layout, pane.id, makeTab(patch)));

  // ---- 서버(기존 pty-manager 재사용 — 별도 프로세스 감독을 만들지 않는다) ----
  // 시작 = 터미널 탭을 하나 만들어 그 세션에 명령을 친다(세션이 새로 생겼을 때만 — TerminalPane).
  // 중지 = 그 탭을 닫는다(= 세션 kill). 실행 중 표시는 저장된 탭이 아니라 살아있는 세션을 본다.
  const serverTabs = () => {
    const out: Array<{ pane: PaneNode; tab: DockTab }> = [];
    const walk = (n: DockNode) => {
      if (n.kind === 'pane') { if (n.tool === 'terminal') for (const t of n.tabs) if (t.serverId) out.push({ pane: n, tab: t }); return; }
      walk(n.children[0]); walk(n.children[1]);
    };
    walk(layout.root);
    return out;
  };

  const refreshRunning = useCallback(async () => {
    const pairs = serverTabs();
    const keys = pairs.map(({ tab }) => ptySessionKey(channelId, tab.id));
    const alive = (await window.engramDesktop?.ptyAlive?.(keys)) ?? keys;
    const set = new Set(alive);
    setRunningIds(pairs.filter(({ tab }) => set.has(ptySessionKey(channelId, tab.id)))
      .map(({ tab }) => tab.serverId as string));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, layout]);

  const toggleServer = (srv: DevServer, running: boolean) => {
    const found = serverTabs().find(({ tab }) => tab.serverId === srv.id);
    if (running || found) {
      // 중지 — 탭을 닫으면 세션이 죽는다(닫기=kill 불변식과 같은 길을 쓴다).
      if (found) doCloseTab(found.pane, found.tab.id);
      return;
    }
    let next = layout;
    const tab = makeTab({ title: srv.name, serverId: srv.id, command: srv.command });
    const termPane = findPaneByTool(next, 'terminal');
    if (termPane) next = addTab(next, termPane.id, tab);
    else next = splitPane(next, focusedPane(next).id, 'col', 'terminal', [tab]);
    // 시작하면 그 주소로 자동 이동(목업 확정). 빈 탭이면 거기에, 아니면 새 탭으로.
    const url = serverUrl(srv);
    const browser = findPaneByTool(next, 'browser');
    if (url && browser) {
      const existing = browser.tabs.find((t) => t.url === url);
      const activeTab = browser.tabs.find((t) => t.id === browser.activeTabId);
      if (existing) next = setActiveTab(next, browser.id, existing.id);
      else if (activeTab && !activeTab.url) next = updateTab(next, browser.id, activeTab.id, { url, title: urlTitle(url) });
      else next = addTab(next, browser.id, makeTab({ url, title: urlTitle(url) }));
    }
    onLayout(next);
  };

  const openFileInBrowser = async (pane: PaneNode) => {
    const p = await window.engramDesktop?.pickFile?.();
    if (!p) return;
    const url = toNavUrl(p);
    if (url) doNewTab(pane, { url, title: urlTitle(url) });
  };

  // ★캡처는 메인이 한다(실기 검증 2026-07-25): 여기서 el.capturePage()를 부르면 프로미스가 영원히
  // 안 풀리고 채팅 창이 통째로 멎는다(재현됨). 게스트 webContents id만 넘기고 메인이 찍어 저장한다.
  const screenshot = async (pane: PaneNode) => {
    const el = getView(pane.activeTabId);
    const id = el?.getWebContentsId?.();
    if (typeof id !== 'number') { setNotice(T.dockScreenshotFailed); return; }
    try {
      const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
      const saved = await window.engramDesktop?.captureWebview?.(id, 'dialog', `${urlTitle(activeTab?.url ?? '') || 'engram'}.png`);
      if (saved) setNotice(T.dockScreenshotSaved(saved));
    } catch { setNotice(T.dockScreenshotFailed); }
  };

  // ---- 탭 제목 ----
  const tabTitle = (pane: PaneNode, tab: DockTab): string => {
    if (tab.title) return tab.title;
    if (pane.tool === 'browser') return tab.url ? urlTitle(tab.url) : T.dockNewTab;
    if (pane.tool === 'terminal') return shellNames[tab.id] ?? T.codeTerminalTab;
    return tab.file ? (tab.file.split('/').pop() as string) : `${T.codeDiffTab} · ${diffCounts[tab.id] ?? 0}`;
  };

  // ---- 렌더 ----
  const renderPane = (pane: PaneNode) => {
    const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];
    const isBrowser = pane.tool === 'browser';
    return (
      <div className={'dockPane' + (layout.focusedPaneId === pane.id ? ' focused' : '')}
        data-pane={pane.id} onMouseDown={() => { if (layout.focusedPaneId !== pane.id) onLayout(focusPane(layout, pane.id)); }}>
        <div className="dockTabs">
          {pane.tabs.map((t) => (
            <span key={t.id} className={'dockTab' + (t.id === activeTab?.id ? ' on' : '')}
              onClick={() => onLayout(setActiveTab(layout, pane.id, t.id))}>
              <span className="t">{tabTitle(pane, t)}</span>
              <span className="x" title={T.dockCloseTab}
                onClick={(e) => { e.stopPropagation(); doCloseTab(pane, t.id); }}>✕</span>
            </span>
          ))}
          <button type="button" className="dockTabBtn" title={T.dockNewTab} onClick={() => doNewTab(pane)}>＋</button>
          <span className="dockSp" />
          {isBrowser && (
            <>
              <button type="button" className={'dockTabBtn' + (menu?.paneId === pane.id && menu.kind === 'server' ? ' on' : '')}
                title={T.dockServers}
                onClick={() => {
                  const open = menu?.paneId === pane.id && menu.kind === 'server';
                  setMenu(open ? null : { paneId: pane.id, kind: 'server' });
                  if (!open) { setServers(loadServers(channelId)); void refreshRunning(); }
                }}>▤</button>
              <button type="button" className={'dockTabBtn' + (menu?.paneId === pane.id && menu.kind === 'more' ? ' on' : '')}
                title={T.dockMore}
                onClick={() => setMenu(menu?.paneId === pane.id && menu.kind === 'more' ? null : { paneId: pane.id, kind: 'more' })}>⋮</button>
            </>
          )}
          <button type="button" className="dockTabBtn" title={T.dockSplitDown} onClick={() => doSplit(pane, 'col')}>⊟</button>
          <button type="button" className="dockTabBtn" title={T.dockSplitRight} onClick={() => doSplit(pane, 'row')}>⊞</button>
          <button type="button" className="dockTabBtn" title={T.htmlExpand}
            onClick={() => setMaximized(maximized === pane.id ? null : pane.id)}>⤢</button>
          <button type="button" className="dockTabBtn" title={T.dockClosePane} onClick={() => doClosePane(pane)}>✕</button>
          {menu?.paneId === pane.id && (
            <div className="dockMenuWrap">
              {menu.kind === 'server' ? (
                <ServerMenu channelId={channelId} servers={servers} runningIds={runningIds}
                  onChanged={() => setServers(loadServers(channelId))}
                  onToggle={toggleServer} onClose={() => setMenu(null)} />
              ) : (
                <MoreMenu prefs={prefs} onPrefs={applyPrefs}
                  onOpenFile={() => void openFileInBrowser(pane)}
                  onScreenshot={() => void screenshot(pane)}
                  onClose={() => setMenu(null)} />
              )}
            </div>
          )}
        </div>
        <div className="dockPaneBody">
          {pane.tool === 'browser' && (
            <BrowserPane channelId={channelId} tabs={pane.tabs} activeTabId={activeTab?.id ?? null} prefs={prefs}
              onTabPatch={(tabId, patch) => onLayout(updateTab(layout, pane.id, tabId, patch))}
              onNewTab={(url) => doNewTab(pane, url ? { url, title: urlTitle(url) } : undefined)} />
          )}
          {pane.tool === 'terminal' && activeTab && (
            <TerminalPane key={activeTab.id} sessionKey={ptySessionKey(channelId, activeTab.id)} cwd={repoPath}
              command={activeTab.command}
              onShellName={(n) => setShellNames((p) => (p[activeTab.id] === n ? p : { ...p, [activeTab.id]: n }))} />
          )}
          {pane.tool === 'diff' && activeTab && (
            <DiffPane key={activeTab.id} repoPath={repoPath} file={activeTab.file}
              onPickFile={(f) => onLayout(updateTab(layout, pane.id, activeTab.id, { file: f, title: f.split('/').pop() }))}
              onCount={(n) => setDiffCounts((p) => (p[activeTab.id] === n ? p : { ...p, [activeTab.id]: n }))} />
          )}
        </div>
      </div>
    );
  };

  const renderNode = (node: DockNode): React.ReactNode => {
    if (node.kind === 'pane') return renderPane(node);
    return <SplitBox key={node.id} node={node} render={renderNode}
      onCommit={(ratio) => onLayout(resizeSplit(layout, node.id, ratio))} />;
  };

  const maxPane = maximized ? findPane(layout, maximized) : null;

  return (
    <div className="dockPanel" style={{ width }}>
      <div className="codeSplitter" onMouseDown={onWidthDown} />
      <DockRail layout={layout} onLayout={onLayout} onCollapse={() => onLayout(null)} />
      <div className="dockBody" onMouseDown={() => { if (menu) setMenu(null); }}>
        {maxPane ? renderPane(maxPane) : renderNode(layout.root)}
      </div>
      {notice && <div className="dockNotice">{notice}</div>}
    </div>
  );
}

// 왼쪽 세로 막대(목업 ①②) — 도구 열기 + 분할 + 패널 접기.
// "도구 열기"는 그 도구 칸이 있으면 포커스를, 없으면 지금 칸을 쪼개 새로 만든다.
function DockRail({ layout, onLayout, onCollapse }: {
  layout: DockLayout; onLayout: (l: DockLayout) => void; onCollapse: () => void;
}) {
  const open = (tool: DockTool) => {
    const existing = findPaneByTool(layout, tool);
    onLayout(existing ? focusPane(layout, existing.id) : splitPane(layout, focusedPane(layout).id, 'col', tool));
  };
  const btn = (tool: DockTool, glyph: string, title: string) => (
    <button type="button" className={'dockRailBtn' + (findPaneByTool(layout, tool) ? ' on' : '')}
      title={title} onClick={() => open(tool)}>{glyph}</button>
  );
  return (
    <div className="dockRail">
      {btn('terminal', '⌨', T.codeTerminalTab)}
      {btn('browser', '🌐', T.dockBrowserTool)}
      {btn('diff', '±', T.codeDiffTab)}
      <div className="dockRailGap" />
      <button type="button" className="dockRailBtn" title={T.dockSplitDown}
        onClick={() => onLayout(splitPane(layout, focusedPane(layout).id, 'col', focusedPane(layout).tool))}>⊟</button>
      <button type="button" className="dockRailBtn" title={T.dockSplitRight}
        onClick={() => onLayout(splitPane(layout, focusedPane(layout).id, 'row', focusedPane(layout).tool))}>⊞</button>
      {/* 접기는 세션을 죽이지 않는다(기존 불변식) — 죽이는 건 탭/칸 닫기뿐이다. */}
      <button type="button" className="dockRailBtn" title={T.dockCollapse} onClick={onCollapse}>⇥</button>
    </div>
  );
}

// 분할 상자 + 경계 드래그.
// 드래그 중에는 React 상태를 건드리지 않고 DOM flexGrow만 rAF로 갱신한다(리사이즈 폭주 금지 —
// 매 픽셀 setState하면 그 안의 webview·xterm이 전부 다시 그려진다). 확정은 마우스업 한 번.
function SplitBox({ node, render, onCommit }: {
  node: SplitNode; render: (n: DockNode) => React.ReactNode; onCommit: (ratio: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const aRef = useRef<HTMLDivElement | null>(null);
  const bRef = useRef<HTMLDivElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  // 드래그 중 언마운트(모드/채널 전환 등)돼도 document 리스너가 남지 않게 강제로 뗀다(기존 선례).
  useEffect(() => () => { cleanupRef.current?.(); cleanupRef.current = null; }, []);

  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const total = node.dir === 'row' ? rect.width : rect.height;
    if (!total) return; // 레이아웃이 아직 없음(jsdom 등) — 드래그 자체가 의미 없다
    let ratio = node.sizes[0];
    let raf = 0;
    const paint = () => {
      raf = 0;
      if (aRef.current) aRef.current.style.flexGrow = String(ratio);
      if (bRef.current) bRef.current.style.flexGrow = String(1 - ratio);
    };
    const move = (ev: MouseEvent) => {
      const pos = node.dir === 'row' ? ev.clientX - rect.left : ev.clientY - rect.top;
      ratio = Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, pos / total));
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const detach = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      if (raf) cancelAnimationFrame(raf);
      document.body.classList.remove('dockDragging');
      cleanupRef.current = null;
    };
    const up = () => { detach(); onCommit(ratio); };
    cleanupRef.current = detach;
    document.body.classList.add('dockDragging');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  return (
    <div className={'dockSplit ' + node.dir} ref={boxRef}>
      <div className="dockSplitChild" ref={aRef} style={{ flexGrow: node.sizes[0] }}>{render(node.children[0])}</div>
      <div className={'dockDivider ' + node.dir} onMouseDown={onDown} />
      <div className="dockSplitChild" ref={bRef} style={{ flexGrow: node.sizes[1] }}>{render(node.children[1])}</div>
    </div>
  );
}

// 채널 헤더의 도구 아이콘 3개(기존 CodePanelIcons 자리) — 독을 여는 입구다.
// active = 그 도구 칸이 지금 독에 있다.
export function DockIcons({ layout, onOpenTool }: {
  layout: DockLayout | null; onOpenTool: (tool: DockTool) => void;
}) {
  const on = (tool: DockTool) => !!layout && !!findPaneByTool(layout, tool);
  return (
    <div className="chhdrIcons">
      <button type="button" className={'codeIconBtn' + (on('terminal') ? ' active' : '')}
        title={T.codeTerminalTab} onClick={() => onOpenTool('terminal')}>⌨</button>
      <button type="button" className={'codeIconBtn' + (on('browser') ? ' active' : '')}
        title={T.dockBrowserTool} onClick={() => onOpenTool('browser')}>🌐</button>
      <button type="button" className={'codeIconBtn' + (on('diff') ? ' active' : '')}
        title={T.codeDiffTab} onClick={() => onOpenTool('diff')}>±</button>
    </div>
  );
}
