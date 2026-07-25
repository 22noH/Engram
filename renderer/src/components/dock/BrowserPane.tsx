import { useCallback, useEffect, useMemo, useState } from 'react';
import { T } from '../../i18n';
import type { DockTab } from '../../dock/layout';
import { allowSite, type DockPrefs, isSiteAllowed, previewPartition } from '../../dock/prefs';
import { displayUrl, hostOf, isLocalUrl, toNavUrl, urlTitle } from '../../dock/url';
import { callView } from '../../dock/views';
import { BrowserView, EMPTY_VIEW_STATE, type ViewState } from './BrowserView';

// 브라우저 칸 본문 — 주소줄(←/→/⟳/주소창/↗) + 탭마다 <webview>.
// 탭 줄과 서버·더보기 메뉴는 DockPanel(칸 틀)이 그린다.
//
// 탭 전환은 **언마운트가 아니라 숨김**이다: webview를 떼면 그 탭의 뒤로/앞으로 기록이 통째로
// 사라진다(진짜 브라우저라고 부를 수 없게 된다). 비활성 탭은 visibility로만 감춘다.
//
// 외부 사이트 확인: 내 컴퓨터(localhost·사설망)와 로컬 파일은 그냥 열고, 그 밖의 호스트는 한 번
// 물어본다(허용하면 기억 — 더보기 메뉴에서 관리). 2단계(AI 웹 조작)의 허용 목록이 이 자리를 쓴다.
// ※ 페이지 **안에서** 링크를 눌러 넘어가는 이동은 여기서 막지 않는다(webview의 will-navigate는
//   렌더러에서 취소할 수 없다) — 이 확인은 "앱이 여는 주소"에 대한 문지기다.

export function BrowserPane({ tabs, activeTabId, prefs, onTabPatch, onNewTab }: {
  tabs: DockTab[];
  activeTabId: string | null;
  prefs: DockPrefs;
  onTabPatch: (tabId: string, patch: Partial<DockTab>) => void;
  onNewTab: (url?: string) => void;
}) {
  const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null;
  const [states, setStates] = useState<Record<string, ViewState>>({});
  const [addr, setAddr] = useState('');
  const [addrDirty, setAddrDirty] = useState(false);
  const [badAddr, setBadAddr] = useState(false);
  const [pendingSite, setPendingSite] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);

  const partition = previewPartition(prefs.keepSession);
  const st = (active && states[active.id]) || EMPTY_VIEW_STATE;
  const shownUrl = st.url || active?.url || '';

  // 주소창은 사용자가 타이핑 중이 아닐 때만 현재 주소를 따라간다(입력 중 덮어쓰기 금지).
  useEffect(() => { if (!addrDirty) setAddr(displayUrl(shownUrl)); }, [shownUrl, addrDirty]);
  useEffect(() => { setAddrDirty(false); setBadAddr(false); setPendingSite(null); }, [activeTabId]);

  const patchState = useCallback((tabId: string, patch: Partial<ViewState>) => {
    setStates((prev) => ({ ...prev, [tabId]: { ...(prev[tabId] ?? EMPTY_VIEW_STATE), ...patch } }));
  }, []);

  // 실제 이동 — 레이아웃(탭)의 url을 갱신하면 BrowserView가 loadURL로 따라간다.
  const applyUrl = useCallback((url: string) => {
    if (!active) return;
    onTabPatch(active.id, { url, title: urlTitle(url) });
    patchState(active.id, { error: null });
  }, [active, onTabPatch, patchState]);

  const go = () => {
    const url = toNavUrl(addr);
    if (!url) { setBadAddr(true); return; }
    setBadAddr(false);
    setAddrDirty(false);
    // 외부 사이트는 한 번 확인받는다(앱과 분리된 파티션이라도 "내가 안 연 사이트"가 뜨는 건 막는다).
    if (isLocalUrl(url) || isSiteAllowed(hostOf(url))) applyUrl(url); else setPendingSite(url);
  };

  // 파일 끌어다 놓기 — Electron 32+에서 File.path가 사라져 preload(webUtils)가 유일한 경로다.
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    const paths = files.map((f) => window.engramDesktop?.filePath?.(f) ?? '').filter(Boolean);
    if (paths.length) { for (const p of paths) onNewTab(toNavUrl(p) ?? undefined); return; }
    // 파일이 아니면 텍스트(URL) 드롭으로 본다.
    const url = toNavUrl(e.dataTransfer?.getData('text/plain') ?? '');
    if (url) onNewTab(url);
  };

  const pendingHost = useMemo(() => (pendingSite ? hostOf(pendingSite) : null), [pendingSite]);

  return (
    <div className={'dockBrowser' + (dropping ? ' dropping' : '')}
      onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}>
      <div className="dockNav">
        <button type="button" className="dockNavBtn" title={T.dockBack} disabled={!st.canGoBack}
          onClick={() => callView(active?.id, (el) => el.goBack())}>←</button>
        <button type="button" className="dockNavBtn" title={T.dockForward} disabled={!st.canGoForward}
          onClick={() => callView(active?.id, (el) => el.goForward())}>→</button>
        <button type="button" className="dockNavBtn" title={T.codeRefresh} disabled={!shownUrl}
          onClick={() => callView(active?.id, (el) => el.reload())}>⟳</button>
        <input className="dockAddr" value={addr} placeholder={T.dockAddressPh} spellCheck={false}
          onChange={(e) => { setAddr(e.target.value); setAddrDirty(true); setBadAddr(false); }}
          onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />
        {/* 외부 열기 — 메인의 setWindowOpenHandler가 target=_blank를 OS 브라우저로 돌린다(기존 관례). */}
        {/^https?:/i.test(shownUrl) && (
          <a className="dockNavBtn" href={shownUrl} target="_blank" rel="noopener noreferrer"
            title={T.codePreviewOpenExternal}>↗</a>
        )}
      </div>

      {badAddr && <div className="dockBar warn">{T.dockBadAddress}</div>}
      {st.error && <div className="dockBar warn">{T.dockLoadFailed(st.error)}</div>}
      {pendingSite && (
        <div className="dockBar confirm">
          <span className="dockBarText">{T.dockConfirmSite(pendingHost ?? pendingSite)}</span>
          <button type="button" onClick={() => { const u = pendingSite; setPendingSite(null); applyUrl(u); }}>{T.dockAllowOnce}</button>
          <button type="button" onClick={() => {
            const u = pendingSite;
            if (pendingHost) allowSite(pendingHost);
            setPendingSite(null);
            applyUrl(u);
          }}>{T.dockAllowAlways}</button>
          <button type="button" onClick={() => setPendingSite(null)}>{T.dockCancel}</button>
        </div>
      )}

      <div className="dockViews">
        {/* key에 partition을 섞는다: 이미 붙은 webview는 partition 속성을 바꿔도 세션이 안 바뀐다 —
            "세션 유지"를 켜고 끄면 새로 붙어야 실제로 반영된다(주소는 그대로 유지된다). */}
        {tabs.map((t) => (t.url ? (
          <BrowserView key={t.id + '|' + partition} tabId={t.id} url={t.url} partition={partition}
            active={t.id === active?.id} onState={(patch) => patchState(t.id, patch)} />
        ) : null))}
        {!active?.url && (
          <div className="codeEmptyNotice dockEmpty">{dropping ? T.dockDropHint : T.dockNewTabEmpty}</div>
        )}
      </div>
    </div>
  );
}
