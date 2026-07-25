import { isNavAllowed } from '../../shared/site-gate';

// 게스트 webview의 **이동 문지기**(메인 프로세스). 1단계에서 남은 구멍을 막는다:
// 허용된 사이트 확인은 "앱이 여는 주소"(주소창·새 탭·드롭)에만 걸렸고, 사용자가 **페이지 안에서
// 링크를 눌러** 외부로 나가는 이동은 그냥 통과했다 — webview의 will-navigate는 렌더러 쪽에서
// 취소가 안 되기 때문이다. 그래서 메인이 잡는다.
//
// 판정은 shared/site-gate.ts 하나뿐이다(렌더러와 같은 함수). 메인은 값(허용 목록)만 넘겨받는다 —
// 목록의 소유자는 여전히 렌더러(localStorage)이고 여기선 최신 스냅샷을 들고 있을 뿐이다.
//
// 리다이렉트(will-redirect)도 같은 판정을 받는다 — 링크만 막고 302를 통과시키면 우회로가 남는다.
// 조용한 차단 금지: 막았으면 반드시 알린다(왜 안 넘어갔는지 모르면 버그로 오인한다).

/** electron의 WebContents 중 이 게이트가 쓰는 부분만(테스트가 가짜를 넣을 수 있게 좁힌 타입). */
export interface NavGateTarget {
  on(event: 'will-navigate' | 'will-redirect', listener: (e: { preventDefault(): void }, url: string) => void): unknown;
}

export function attachNavGate(
  contents: NavGateTarget,
  allowedSites: () => readonly string[],
  onBlocked: (url: string) => void,
): void {
  const gate = (e: { preventDefault(): void }, url: string): void => {
    let allowed = false;
    try {
      allowed = isNavAllowed(url, allowedSites());
    } catch {
      allowed = false; // 목록 조회가 깨지면 막는 쪽으로(안전 우선)
    }
    if (allowed) return;
    e.preventDefault();
    try { onBlocked(url); } catch { /* 알림 실패가 차단을 무르게 하면 안 된다 */ }
  };
  contents.on('will-navigate', gate);
  contents.on('will-redirect', gate);
}
