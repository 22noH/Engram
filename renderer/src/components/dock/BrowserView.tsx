import { useEffect, useRef, useState } from 'react';
import type { WebviewElement } from '../../desktop.d';
import { registerView } from '../../dock/views';
import { clearConsole, pushConsole } from '../../dock/agent-store';

// 브라우저 탭 하나 = <webview> 하나(스펙 §핵심 기술 결정).
//
// 안전 설정(스펙 §안전 설정 — 여기 값은 "요청"이고, 최종 강제는 메인의 will-attach-webview다):
//  · webpreferences: contextIsolation=yes,nodeIntegration=no,sandbox=yes
//  · partition: engram-preview 계열(앱 세션과 완전 분리 — 외부 사이트가 앱 쿠키/스토리지에 못 닿는다)
//  · allowpopups **미지정** — 팝업 차단. 새 창 요청은 메인이 OS 브라우저로 넘긴다.
//
// 주소 갱신 규칙: src는 마운트 시 한 번만 준다(uncontrolled). 이후 이동은 loadURL로 한다 —
// src를 매번 바꾸면 페이지 안에서 링크를 눌러 이동한 뒤 상태가 되돌아오며 무한 왕복이 난다.
// 뒤로/앞으로 히스토리도 이 방식이어야 살아남는다.

export interface ViewState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
}

export const EMPTY_VIEW_STATE: ViewState = {
  url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: null,
};

export function BrowserView({ tabId, url, partition, active, onState }: {
  tabId: string;
  url: string;
  partition: string;
  active: boolean;
  onState: (patch: Partial<ViewState>) => void;
}) {
  const ref = useRef<WebviewElement | null>(null);
  const readyRef = useRef(false);
  // 마운트 시점의 주소만 src로 준다(이후는 loadURL).
  const [initialSrc] = useState(url);
  // 부모가 넘기는 인라인 콜백을 의존성에 넣으면 매 렌더마다 리스너를 떼었다 붙인다 — ref로 고정한다.
  const stateRef = useRef(onState);
  stateRef.current = onState;

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.addEventListener !== 'function') return; // jsdom 등 webview가 없는 환경
    const sync = () => {
      try {
        stateRef.current({
          url: el.getURL?.() || '',
          canGoBack: !!el.canGoBack?.(),
          canGoForward: !!el.canGoForward?.(),
        });
      } catch { /* 아직 attach 전 — 무시 */ }
    };
    const onDomReady = () => { readyRef.current = true; sync(); };
    // 새 로드가 시작되면 콘솔 버퍼를 비운다 — 지난 페이지의 오류가 이번 페이지 것으로 오인되면 안 된다.
    const onStart = () => { clearConsole(tabId); stateRef.current({ loading: true, error: null }); };
    const onStop = () => { stateRef.current({ loading: false }); sync(); };
    const onNavigate = () => sync();
    const onTitle = (e: Event) => stateRef.current({ title: (e as unknown as { title: string }).title || '' });
    // AI 웹 조작(2단계): 페이지 콘솔을 탭별 링버퍼에 모은다 — 두뇌가 browser_console로 읽어
    // 자기가 만든 오류를 스스로 발견하는 순환의 재료다. 표시에는 영향이 없다(수집만).
    const onConsole = (e: Event) => {
      const ev = e as unknown as { level?: number; message?: string; line?: number; sourceId?: string };
      const level = ['debug', 'log', 'warning', 'error'][ev.level ?? 1] ?? 'log';
      const where = ev.sourceId ? ` (${String(ev.sourceId).split('/').pop()}:${ev.line ?? 0})` : '';
      pushConsole(tabId, `[${level}] ${ev.message ?? ''}${where}`);
    };
    const onFail = (e: Event) => {
      const ev = e as unknown as { errorCode: number; errorDescription: string; isMainFrame?: boolean };
      // -3 = ABORTED(사용자가 다른 주소로 넘어간 경우 등) — 오류로 보여주면 오경보가 된다.
      if (ev.errorCode === -3) return;
      if (ev.isMainFrame === false) return;
      stateRef.current({ loading: false, error: ev.errorDescription || String(ev.errorCode) });
    };
    el.addEventListener('dom-ready', onDomReady);
    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('did-navigate', onNavigate);
    el.addEventListener('did-navigate-in-page', onNavigate);
    el.addEventListener('page-title-updated', onTitle);
    el.addEventListener('did-fail-load', onFail);
    el.addEventListener('console-message', onConsole);
    return () => {
      el.removeEventListener('dom-ready', onDomReady);
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('did-navigate', onNavigate);
      el.removeEventListener('did-navigate-in-page', onNavigate);
      el.removeEventListener('page-title-updated', onTitle);
      el.removeEventListener('did-fail-load', onFail);
      el.removeEventListener('console-message', onConsole);
    };
  }, []);

  // 바깥(주소창·서버 시작·채팅 링크)이 정한 주소로 이동. 지금 보고 있는 주소와 같으면 아무것도 안 한다.
  useEffect(() => {
    const el = ref.current;
    if (!el || !url || typeof el.loadURL !== 'function') return;
    let current = '';
    try { current = el.getURL?.() || ''; } catch { current = ''; }
    if (current === url) return;
    if (!readyRef.current && current === '') return; // 아직 attach 전이면 src가 알아서 연다
    void el.loadURL(url).catch(() => { /* did-fail-load가 안내를 맡는다 */ });
  }, [url]);

  return (
    <webview
      className={'dockWebview' + (active ? ' active' : '')}
      // React가 아는 webview 타입은 밋밋한 HTMLElement라 Electron 메서드가 없다 — 좁혀서 쓴다.
      ref={(el) => {
        const view = (el as unknown as WebviewElement | null);
        ref.current = view;
        registerView(tabId, view);
      }}
      src={initialSrc}
      partition={partition}
      webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
    />
  );
}
