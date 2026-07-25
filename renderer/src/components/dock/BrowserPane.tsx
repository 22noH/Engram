import { useCallback, useEffect, useMemo, useState } from 'react';
import { T } from '../../i18n';
import type { DockTab } from '../../dock/layout';
import { allowSite, type DockPrefs, isSiteAllowed, previewPartition, pushAllowedSites } from '../../dock/prefs';
import { agentLog, agentPending, answerConfirm, cancelPendingFor, clearAgentLog, subscribeAgent } from '../../dock/agent-store';
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

export function BrowserPane({ channelId, tabs, activeTabId, prefs, onTabPatch, onNewTab }: {
  channelId: string;
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
  // 메인 프로세스가 막은 이동(페이지 안 링크·리다이렉트) — 조용한 차단 금지(2026-07-25 이동 게이트).
  const [navBlocked, setNavBlocked] = useState<string | null>(null);
  // AI 웹 조작(2단계): 확인 줄 + 행동 로그는 모듈 장부(agent-store)를 구독해 그린다 —
  // 실행하는 쪽(App의 ws 처리)과 보여주는 쪽(여기)이 다른 컴포넌트라 props로는 못 잇는다.
  const [agentTick, setAgentTick] = useState(0);
  useEffect(() => subscribeAgent(() => setAgentTick((n) => n + 1)), []);
  const pendingAsk = agentPending();
  const log = agentLog(channelId);
  void agentTick; // 구독 갱신용 상태(값 자체는 안 쓴다)

  // 허용 목록의 주인은 여기(localStorage)지만 판정은 메인도 해야 한다 — 최신 스냅샷을 밀어 넣는다.
  useEffect(() => {
    pushAllowedSites();
    return window.engramDesktop?.onNavBlocked?.((url) => setNavBlocked(url));
  }, []);
  useEffect(() => {
    if (!navBlocked) return;
    const id = setTimeout(() => setNavBlocked(null), 6000);
    return () => clearTimeout(id);
  }, [navBlocked]);
  // 채널을 떠나면 답 없는 확인은 거절로 정리(두뇌가 타임아웃까지 매달리지 않게).
  useEffect(() => () => cancelPendingFor(channelId), [channelId]);

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
      {navBlocked && <div className="dockBar warn">{T.dockNavBlocked(hostOf(navBlocked) ?? navBlocked)}</div>}
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

      {/* AI 웹 조작 — 확인 줄(목업 ①의 🤖 바). 이 채널의 요청만 보여준다. */}
      {pendingAsk && pendingAsk.channelId === channelId && (
        <div className="dockAgentBar">
          <span className="ic">🤖</span>
          <span className="dockBarText">{T.dockAgentAsk(pendingAsk.label, displayUrl(pendingAsk.url) || pendingAsk.url)}</span>
          <button type="button" onClick={() => answerConfirm(pendingAsk.id, false)}>{T.dockAgentSkip}</button>
          <button type="button" className="primary" onClick={() => answerConfirm(pendingAsk.id, true)}>{T.dockAgentAllow}</button>
        </div>
      )}

      {/* 행동 로그 — 무엇을 했는지 사후 추적(차단·건너뛰기도 남는다). */}
      {log.length > 0 && (
        <div className="dockAgentLog">
          <div className="dockAgentLogHead">
            <span>{T.dockAgentLog}</span>
            <button type="button" onClick={() => clearAgentLog(channelId)}>{T.dockAgentLogClear}</button>
          </div>
          {log.slice(-8).map((e) => (
            <div key={e.id} className={'dockAgentLogRow ' + e.status}>
              <span className="mark">{e.status === 'ok' ? '✓' : e.status === 'skipped' ? '·' : '✗'}</span>
              <span className="txt">{e.label}{e.detail ? ` — ${e.detail}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
