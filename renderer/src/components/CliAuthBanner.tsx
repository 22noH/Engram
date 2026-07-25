import { useEffect, useState } from 'react';
import type { CliAuthState } from '../desktop';
import { T } from '../i18n';

// CLI 두뇌 로그인 배너(목업 ①②) — 사용자가 물어보고 나서 실패를 겪기 전에 미리 알린다.
// 판정은 전부 메인 프로세스(src/desktop/cli-auth.ts)가 하고, 여기는 표시만 한다.
//
// 오경보 금지가 이 컴포넌트의 핵심 계약이다:
//   'logged-out'  → 배너
//   'logged-in' · 'unknown' · null(기본 두뇌가 CLI 아님) · 데스크톱 아님 → 아무것도 안 보인다
// 'unknown'은 "확인 실패/판단 불가"라서 경고하면 거짓 경보가 된다.
export function CliAuthBanner() {
  const [auth, setAuth] = useState<CliAuthState | null>(null);
  const [dismissed, setDismissed] = useState(false); // ✕ — 이번 실행에서만(서버 상태는 안 건드린다)
  const [showFix, setShowFix] = useState(false);     // [해결 방법] 인라인 확장(목업 ②)
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  // 마운트 시 1회 조회 + 변경 push 구독. 언마운트 때 반드시 해제한다(preload가 돌려주는 해제 함수).
  // 데스크톱이 아니면 cliAuthState 자체가 없어 조용히 no-op(브라우저에선 전체 비활성).
  useEffect(() => {
    const api = window.engramDesktop;
    if (!api?.cliAuthState) return;
    let alive = true;
    const apply = (s: CliAuthState | null) => {
      setAuth(s);
      // 로그인이 회복되면 ✕로 숨겼던 기록도 지운다 — 같은 실행에서 다시 풀리면 또 알려야 한다.
      if (s?.state !== 'logged-out') setDismissed(false);
    };
    void api.cliAuthState().then((s) => { if (alive) apply(s); });
    const off = api.onCliAuthChanged?.((s) => { if (alive) apply(s); });
    return () => { alive = false; off?.(); };
  }, []);

  if (dismissed || auth?.state !== 'logged-out') return null;

  const isCodex = auth.provider === 'codex-cli';
  const label = isCodex ? 'Codex CLI' : 'Claude CLI'; // 고유명 — 로케일 불문 동일
  const fixText = isCodex ? T.cliAuthFixCodex : T.cliAuthFixClaude;

  const copy = async () => {
    try { await navigator.clipboard?.writeText(auth.fixCommand); setCopied(true); } catch { /* 클립보드 거부 — 명령은 화면에 그대로 보인다 */ }
  };

  const recheck = async () => {
    const api = window.engramDesktop;
    if (!api?.cliAuthRefresh || checking) return;
    setChecking(true);
    try {
      const s = await api.cliAuthRefresh();
      setAuth(s);
      if (s?.state !== 'logged-out') setDismissed(false);
    } finally { setChecking(false); }
  };

  return (
    <div id="cliAuthBanner">
      <div className="cliAuthRow">
        <span aria-hidden="true">⚠️</span>
        <span className="cliAuthText">
          <b>{T.cliAuthTitle(label)}</b> — {T.cliAuthBody}
        </span>
        <button type="button" className="cliAuthBtn" onClick={() => setShowFix((v) => !v)}>{T.cliAuthHowTo}</button>
        <button type="button" className="cliAuthDismiss" title={T.close} onClick={() => setDismissed(true)}>✕</button>
      </div>
      {showFix && (
        <div className="cliAuthFix">
          <span className="cliAuthFixText">{fixText}</span>
          <code className="cliAuthCmd">{auth.fixCommand}</code>
          <button type="button" className="cliAuthBtn" onClick={() => void copy()}>
            {copied ? T.cliAuthCopied : T.cliAuthCopy}
          </button>
          <button type="button" className="cliAuthBtn" disabled={checking} onClick={() => void recheck()}>
            {checking ? T.cliAuthChecking : T.cliAuthRecheck}
          </button>
        </div>
      )}
    </div>
  );
}
