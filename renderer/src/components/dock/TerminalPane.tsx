import { useEffect, useRef, useState } from 'react';
import type { Terminal as XTerminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { T } from '../../i18n';

// 독 패널 터미널 탭 — 기존 CodePanel의 TerminalTab을 옮겨온 것이다. 달라진 건 딱 둘:
//  ① 세션 키가 채널 id가 아니라 `채널id#탭id`(탭마다 별도 세션)
//  ② 세션이 **새로** 생겼을 때만 command를 한 번 자동 입력한다(개발 서버 시작)
// 나머지(리플레이 먼저 → 그 다음 구독, 언마운트 시 세션 유지, 테마 재적용)는 그대로다.

// xterm은 모듈 로드 시점에 canvas 기반 색상 유틸을 돌린다(jsdom엔 canvas 컨텍스트가 없어 노이즈
// 콘솔 에러가 남는다) — 실제 터미널 탭을 열 때만 동적 import해 다른 모드/테스트에 영향 없게 한다.
async function loadXterm() {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
  ]);
  return { Terminal, FitAddon };
}

// QL 토큰 값을 getComputedStyle로 읽어 xterm 테마를 구성 — 검정 고정 금지(라이트=종이톤·다크=흑연).
function buildXtermTheme(): Record<string, string> {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  const v = (name: string, fallback: string) => {
    const val = cs?.getPropertyValue(name)?.trim();
    return val || fallback;
  };
  return {
    background: v('--panel-2', '#ffffff'),
    foreground: v('--text', '#24292e'),
    cursor: v('--accent', '#2e6e63'),
    cursorAccent: v('--panel-2', '#ffffff'),
    selectionBackground: v('--accent-soft', '#eef2ee'),
    black: v('--text', '#24292e'),
    brightBlack: v('--dim', '#6b7268'),
  };
}

// jsdom엔 ResizeObserver가 없다 — 없으면 그냥 관찰을 생략(fit은 마운트 시 1회는 이미 수행).
const ResizeObserverCtor: typeof ResizeObserver | undefined =
  typeof ResizeObserver !== 'undefined' ? ResizeObserver : undefined;

export function TerminalPane({ sessionKey, cwd, command, onShellName }: {
  /** `채널id#탭id` — 같은 키면 같은 세션(패널을 접었다 펴도 리플레이로 이어진다). */
  sessionKey: string;
  cwd: string;
  /** 세션이 새로 생겼을 때만 1회 입력할 명령(개발 서버 시작). 재사용 세션엔 절대 보내지 않는다. */
  command?: string;
  onShellName?: (name: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sidRef = useRef<string | null>(null);
  const termRef = useRef<XTerminal | null>(null);
  // ★ onShellName을 effect 의존성에 넣으면 안 된다: 부모가 인라인 화살표를 넘기면 매 렌더마다 새
  // 함수라 effect가 재실행되고, 그때마다 이전 실행이 disposed 처리되어 ptyStart가 영영 완료되지
  // 않는다(터미널이 아무것도 안 뜨는 무한 재시작). 콜백은 ref에 담아 최신 것만 부른다.
  const shellNameRef = useRef(onShellName);
  shellNameRef.current = onShellName;
  const [ended, setEnded] = useState(false);
  const [restartKey, setRestartKey] = useState(0);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    setEnded(false);
    setStartError(null);
    let disposed = false;
    let unsubData: (() => void) | undefined;
    let unsubExit: (() => void) | undefined;
    let dataDisp: { dispose: () => void } | undefined;
    let ro: ResizeObserver | undefined;
    let mq: MediaQueryList | null = null;
    let onThemeChange: (() => void) | undefined;

    (async () => {
      try {
        const { Terminal, FitAddon } = await loadXterm();
        if (disposed) return;

        const term = new Terminal({
          fontFamily: 'Consolas, "Cascadia Mono", Menlo, monospace',
          fontSize: 12,
          theme: buildXtermTheme(),
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        termRef.current = term;
        if (containerRef.current) term.open(containerRef.current);
        try { fit.fit(); } catch { /* jsdom 등 레이아웃 없는 환경 */ }

        dataDisp = term.onData((data: string) => {
          if (sidRef.current) void window.engramDesktop?.ptyWrite?.(sidRef.current, data);
        });

        if (ResizeObserverCtor && containerRef.current) {
          ro = new ResizeObserverCtor(() => {
            try { fit.fit(); } catch { /* 무시 */ }
            if (sidRef.current) void window.engramDesktop?.ptyResize?.(sidRef.current, term.cols, term.rows);
          });
          ro.observe(containerRef.current);
        }

        // 앱 테마(라이트/다크) 전환 시 xterm 테마 재적용 — 검정 고정 금지 요건의 핵심 배선.
        mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
        onThemeChange = () => { term.options.theme = buildXtermTheme(); };
        mq?.addEventListener?.('change', onThemeChange);

        const api = window.engramDesktop;
        if (!api?.ptyStart) return;
        const res = await api.ptyStart(sessionKey, cwd);
        if (disposed) return;
        if ('error' in res) { setStartError(res.error); term.writeln(`[error] ${res.error}`); return; }
        sidRef.current = res.sid;
        shellNameRef.current?.(res.shell);
        if (api.ptyReplay) {
          const buf = await api.ptyReplay(res.sid);
          if (!disposed && buf) term.write(buf);
        }
        if (disposed) return;
        if (api.onPtyData) {
          unsubData = api.onPtyData((sid: string, data: string) => { if (sid === sidRef.current) term.write(data); });
        }
        if (api.onPtyExit) {
          unsubExit = api.onPtyExit((sid: string) => {
            if (sid === sidRef.current) { setEnded(true); term.writeln(`\r\n${T.codeSessionEnded}`); }
          });
        }
        // 개발 서버 시작 명령 — created=true(방금 스폰)일 때만. 재사용 세션에 또 치면 서버가 두 번 뜬다.
        if (command && res.created) void api.ptyWrite?.(res.sid, command + '\r');
      } catch {
        // xterm 동적 import 실패(청크 로드 오류 등)를 조용히 삼키지 않는다 — 종료 배너를 재사용해
        // 안내+재시작 버튼(=재시도)을 보여준다.
        if (disposed) return;
        setStartError(T.codeTermLoadFailed);
        setEnded(true);
      }
    })();

    return () => {
      // 언마운트: 구독만 해제하고 세션은 죽이지 않는다(탭 전환·패널 접기에서도 이어붙임).
      // 세션을 죽이는 건 오직 "탭/칸 닫기"뿐이고, 그건 DockPanel이 ptyKillKey로 한다.
      disposed = true;
      unsubData?.();
      unsubExit?.();
      dataDisp?.dispose();
      ro?.disconnect();
      if (mq && onThemeChange) mq.removeEventListener?.('change', onThemeChange);
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, [sessionKey, cwd, command, restartKey]);

  return (
    <div className="codeTerm">
      <div className="codeTermSurface" ref={containerRef} />
      {ended && (
        <div className="codeSessionBar">
          <span>{startError ? `[error] ${startError}` : T.codeSessionEnded}</span>
          <button type="button" onClick={() => setRestartKey((k) => k + 1)}>{T.codeRestart}</button>
        </div>
      )}
    </div>
  );
}
