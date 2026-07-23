import { useCallback, useEffect, useRef, useState } from 'react';
import type { Terminal as XTerminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { T } from '../i18n';

// xterm은 모듈 로드 시점에 canvas 기반 색상 유틸을 돌린다(jsdom엔 canvas 컨텍스트가 없어 노이즈
// 콘솔 에러가 남는다) — 실제 터미널 탭을 열 때만 동적 import해 다른 모드/테스트에 영향 없게 한다.
async function loadXterm() {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
  ]);
  return { Terminal, FitAddon };
}

// 코드 패널(Task 3) — 코드 채널 우측 터미널·프리뷰·Diff. 데스크톱(window.engramDesktop)에서만
// 열린다(App.tsx 게이트). 이 파일은 아이콘 바(CodePanelIcons)+패널 본체(CodePanel)를 함께 내보낸다
// — 아이콘은 #chhdr, 패널은 #main row 안에 각각 다른 위치에 마운트되지만 같은 탭 상태를 공유해야
// 하므로 상태 자체는 App.tsx가 들고(localStorage 퍼시스트 헬퍼는 여기서 export), 두 컴포넌트는 순수
// 프레젠테이션+각 탭 내부 로직(xterm/iframe/git diff)만 담당한다.

export type CodeTab = 'terminal' | 'preview' | 'diff';

const OPEN_KEY = 'engram.codePanel.open';
const WIDTH_KEY = 'engram.codePanel.width';
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 280;

// 채널별 열림 탭 맵(없으면 패널 닫힘). 파싱 실패는 무시(닫힘 취급) — 퍼시스트는 부가 기능이지 신뢰
// 소스가 아니다.
export function loadCodeTab(channelId: string): CodeTab | null {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, CodeTab>;
    return map[channelId] ?? null;
  } catch { return null; }
}

export function saveCodeTab(channelId: string, tab: CodeTab | null): void {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, CodeTab>) : {};
    if (tab) map[channelId] = tab; else delete map[channelId];
    localStorage.setItem(OPEN_KEY, JSON.stringify(map));
  } catch { /* 퍼시스트 실패는 무시 — 이번 세션만 상태로 동작 */ }
}

function loadWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= MIN_WIDTH ? n : DEFAULT_WIDTH;
  } catch { return DEFAULT_WIDTH; }
}

function saveWidth(n: number): void {
  try { localStorage.setItem(WIDTH_KEY, String(Math.round(n))); } catch { /* 무시 */ }
}

function clampWidth(n: number): number {
  const max = (typeof window !== 'undefined' ? window.innerWidth : 1200) * 0.7;
  return Math.min(max, Math.max(MIN_WIDTH, n));
}

// 상단바 우측 아이콘 3개(목업 B — 26x24 라운드 버튼, active=accent-soft bg+accent border).
// 게이트(mode==='code' && repoPath && ptyStart 존재)는 App.tsx 책임 — 이 컴포넌트는 항상 렌더한다.
export function CodePanelIcons({ activeTab, onSelect }: { activeTab: CodeTab | null; onSelect: (tab: CodeTab) => void }) {
  return (
    <div className="chhdrIcons">
      <button type="button" className={'codeIconBtn' + (activeTab === 'terminal' ? ' active' : '')}
        title={T.codeTerminalTab} onClick={() => onSelect('terminal')}>⌨</button>
      <button type="button" className={'codeIconBtn' + (activeTab === 'preview' ? ' active' : '')}
        title={T.codePreviewTab} onClick={() => onSelect('preview')}>🌐</button>
      <button type="button" className={'codeIconBtn' + (activeTab === 'diff' ? ' active' : '')}
        title={T.codeDiffTab} onClick={() => onSelect('diff')}>±</button>
    </div>
  );
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

// 터미널 탭 — xterm 인스턴스 마운트마다 새로(ptyStart는 채널당 세션 재사용 → 같은 sid 반환).
// 리플레이 먼저 쓰고 그 다음 onPtyData 구독(순서 보장 — 브리프 요구사항).
function TerminalTab({ channelId, repoPath, onShellName }: {
  channelId: string; repoPath: string; onShellName: (name: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sidRef = useRef<string | null>(null);
  const termRef = useRef<XTerminal | null>(null);
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
      const res = await api.ptyStart(channelId, repoPath);
      if (disposed) return;
      if ('error' in res) { setStartError(res.error); term.writeln(`[error] ${res.error}`); return; }
      sidRef.current = res.sid;
      onShellName(res.shell);
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
    })();

    return () => {
      // 언마운트: 구독만 해제하고 세션은 죽이지 않는다(브리프 — 패널 재열기 시 리플레이로 이어붙임).
      disposed = true;
      unsubData?.();
      unsubExit?.();
      dataDisp?.dispose();
      ro?.disconnect();
      if (mq && onThemeChange) mq.removeEventListener?.('change', onThemeChange);
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, [channelId, repoPath, restartKey, onShellName]);

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

function isHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u.trim());
}

// 프리뷰 탭 — URL 바+iframe(sandbox)+새로고침(키 리마운트)+외부 열기.
// 외부 열기는 <a target="_blank">만으로 충분하다 — 데스크톱 메인 프로세스(main.ts)의
// setWindowOpenHandler가 이미 모든 target=_blank 네비게이션을 shell.openExternal로 돌려보낸다
// (기존 관례, 레포 조사 결과 — 신규 preload API 불필요, 구현자 판단).
function PreviewTab() {
  const [url, setUrl] = useState('');
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const go = () => {
    const u = url.trim();
    if (!isHttpUrl(u)) { setError(T.codePreviewInvalidUrl); return; }
    setError(null);
    setLoadedUrl(u);
    setIframeKey((k) => k + 1);
  };

  return (
    <div className="codePreview">
      <div className="codePreviewBar">
        <input type="text" value={url} placeholder="http://localhost:5173"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />
        <button type="button" onClick={go}>{T.codePreviewGo}</button>
        <button type="button" disabled={!loadedUrl} title={T.codeRefresh}
          onClick={() => setIframeKey((k) => k + 1)}>⟳</button>
        {loadedUrl && (
          <a href={loadedUrl} target="_blank" rel="noopener noreferrer" title={T.codePreviewOpenExternal}>↗</a>
        )}
      </div>
      {error && <div className="codePreviewError">{error}</div>}
      {loadedUrl ? (
        <iframe key={iframeKey} src={loadedUrl} title="preview"
          sandbox="allow-scripts allow-same-origin allow-forms" />
      ) : (
        <div className="codeEmptyNotice">{T.codePreviewEmpty}</div>
      )}
    </div>
  );
}

type DiffFile = { path: string; status: 'A' | 'M' | 'D' | 'R' | '?' };

function diffReasonText(reason: string): string {
  if (reason === 'not-repo') return T.codeDiffNotRepo;
  if (reason === 'git-missing') return T.codeDiffGitMissing;
  return T.codeDiffLoadError;
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) return 'dHunk';
  if (line.startsWith('+')) return 'dAdd';
  if (line.startsWith('-')) return 'dDel';
  return '';
}

// Diff 탭 — 활성화(마운트) 시 gitDiffStatus 갱신, 파일 클릭 시 gitDiffFile. 배지 수는 상위(CodePanel)로
// onCount 콜백 전달(탭이 바뀌어도 마지막 값을 유지하도록 상위 state에 둔다).
function DiffTab({ repoPath, onCount }: { repoPath: string; onCount: (n: number) => void }) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api = window.engramDesktop;
    if (!api?.gitDiffStatus) return;
    const res = await api.gitDiffStatus(repoPath);
    if (res.ok) {
      setFiles(res.files);
      onCount(res.files.length);
      setNotice(null);
    } else {
      setFiles([]);
      onCount(0);
      setNotice(diffReasonText(res.reason));
    }
  }, [repoPath, onCount]);

  useEffect(() => { void refresh(); }, [refresh]);

  const openFile = async (path: string) => {
    setSelected(path);
    setDiffText(null);
    const api = window.engramDesktop;
    if (!api?.gitDiffFile) return;
    const res = await api.gitDiffFile(repoPath, path);
    setDiffText(res.ok ? res.diff : T.codeDiffError);
  };

  return (
    <div className="codeDiff">
      <div className="codeDiffList">
        <button type="button" className="codeDiffRefresh" title={T.codeRefresh} onClick={() => void refresh()}>⟳</button>
        {notice && <div className="codeEmptyNotice">{notice}</div>}
        {files?.map((f) => (
          <div key={f.path} className={'codeDiffFile' + (selected === f.path ? ' sel' : '')}
            onClick={() => void openFile(f.path)}>
            <span className={'codeDiffStatus s' + f.status}>{f.status}</span>
            <span className="codeDiffPath">{f.path}</span>
          </div>
        ))}
        {files && files.length === 0 && !notice && <div className="codeEmptyNotice">{T.codeDiffNone}</div>}
      </div>
      <div className="codeDiffView">
        {diffText != null ? (
          <pre className="codeDiffPre">
            {diffText.split('\n').map((line, i) => (
              <div key={i} className={diffLineClass(line)}>{line || ' '}</div>
            ))}
          </pre>
        ) : (
          <div className="codeEmptyNotice">{T.codeDiffSelectFile}</div>
        )}
      </div>
    </div>
  );
}

// 패널 본체 — 탭 행+스플리터+탭별 본문. 폭은 자체 로컬 state(localStorage 퍼시스트) — 다른 상태에
// 영향 없는 순수 표현 값이라 상위로 끌어올릴 이유가 없다(레포 첫 스플리터).
export function CodePanel({ channelId, repoPath, tab, onChangeTab, onClose }: {
  channelId: string; repoPath: string; tab: CodeTab;
  onChangeTab: (tab: CodeTab) => void; onClose: () => void;
}) {
  const [width, setWidth] = useState<number>(() => clampWidth(loadWidth()));
  const [shellName, setShellName] = useState<string>(T.codeTerminalTab);
  const [diffCount, setDiffCount] = useState(0);

  const onSplitterDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const move = (ev: MouseEvent) => setWidth(clampWidth(startWidth + (startX - ev.clientX)));
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      setWidth((w) => { saveWidth(w); return w; });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  return (
    <div className="codePanel" style={{ width }}>
      <div className="codeSplitter" onMouseDown={onSplitterDown} />
      <div className="codeTabRow">
        <div className={'codeTabBtn' + (tab === 'terminal' ? ' active' : '')} onClick={() => onChangeTab('terminal')}>
          {shellName}
        </div>
        <div className={'codeTabBtn' + (tab === 'preview' ? ' active' : '')} onClick={() => onChangeTab('preview')}>
          {T.codePreviewTab}
        </div>
        <div className={'codeTabBtn' + (tab === 'diff' ? ' active' : '')} onClick={() => onChangeTab('diff')}>
          {T.codeDiffTab} · {diffCount}
        </div>
        <button type="button" className="codeTabClose" title={T.codePanelClose} onClick={onClose}>×</button>
      </div>
      <div className="codeTabBody">
        {tab === 'terminal' && <TerminalTab channelId={channelId} repoPath={repoPath} onShellName={setShellName} />}
        {tab === 'preview' && <PreviewTab />}
        {tab === 'diff' && <DiffTab repoPath={repoPath} onCount={setDiffCount} />}
      </div>
    </div>
  );
}
