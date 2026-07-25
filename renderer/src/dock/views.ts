import type { WebviewElement } from '../desktop.d';

// 살아있는 <webview> 엘리먼트 장부(탭 id → 엘리먼트).
//
// 왜 모듈 전역인가: 뒤로/앞으로는 브라우저 칸이 부르고, 스크린샷은 탭 줄의 더보기 메뉴(DockPanel)가
// 부른다 — 서로 다른 컴포넌트가 같은 엘리먼트를 가리켜야 한다. ref를 위아래로 전달하는 것보다
// 장부 하나가 단순하고, 등록/해제가 BrowserView 한 곳에만 있어 새는 지점이 없다.

const views = new Map<string, WebviewElement>();

export function registerView(tabId: string, el: WebviewElement | null): void {
  if (el) views.set(tabId, el); else views.delete(tabId);
}

export function getView(tabId: string | null | undefined): WebviewElement | null {
  return tabId ? views.get(tabId) ?? null : null;
}

/** webview 메서드는 attach 전에 부르면 throw한다 — 호출부를 매번 try로 감싸지 않도록 여기서 삼킨다. */
export function callView(tabId: string | null | undefined, fn: (el: WebviewElement) => void): void {
  const el = getView(tabId);
  if (!el) return;
  try { fn(el); } catch { /* 아직 attach 전 — 무시 */ }
}
