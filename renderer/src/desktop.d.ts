// Electron preload가 주입하는 최소 API(chat-preload.ts). 브라우저엔 없음(옵셔널).

// 코드 채널 상단 줄(⑂ 브랜치 +추가 −삭제)이 읽는 읽기 전용 상태(never-throw 결과형).
export type GitBranchStatus =
  | { ok: true; branch: string; detached: boolean; added: number; removed: number; files: number }
  | { ok: false; reason: 'not-repo' | 'git-missing' | 'error' };

// ⚠️ PR 생성 결과. 이 호출 자체가 push+PR(되돌리기 어려운 외부 동작)을 즉시 실행하므로 확인
// 다이얼로그는 렌더러 책임이다(chat-preload.ts 주석 — 메인엔 확인 절차가 없다).
export type CreatePrResult =
  | { ok: true; url: string; alreadyExisted: boolean }
  | {
      ok: false;
      reason: 'not-repo' | 'detached' | 'on-default-branch' | 'no-remote' | 'gh-missing'
        | 'gh-unauthenticated' | 'push-failed' | 'pr-failed' | 'error';
      message?: string;
    };

export interface SttProgress { percent: number; loadedBytes: number; totalBytes: number; file: string }

// CLI 두뇌 로그인 상태(chat-preload.ts의 cliAuth* 계약). null = 기본 두뇌가 CLI가 아님 = 배너 없음.
// state='unknown'은 "판단 불가"라 경고하지 않는다(오경보 금지 — 배너는 'logged-out'에서만).
export interface CliAuthState {
  provider: string;   // 'claude-cli' | 'codex-cli'
  state: string;      // 'logged-in' | 'logged-out' | 'unknown'
  detail?: string;    // 예: 'a@b.com (max)'
  fixCommand: string; // 복사용 명령(claude / codex login)
}

declare global {
  interface Window {
    engramDesktop?: {
      pickFolder: () => Promise<string | null>;
      setupCode?: () => Promise<string | null>; // Task 15
      addLocalBrain?: (name: string) => Promise<{ endpoint: string; name: string } | null>; // Task 15
      // 코드 패널 터미널(코드 패널 Task 1 — pty 인프라). cwd=채널 repoPath.
      // 첫 인자는 "세션 키"다 — 독 패널(2026-07-25)에서 터미널 탭이 여럿이 되며 `채널id#탭id`가 됐다.
      // created=false = 기존 세션 재사용(리플레이) → 1회성 입력(서버 시작 명령)을 보내면 안 된다.
      ptyStart?: (key: string, cwd: string) => Promise<{ sid: string; shell: string; created: boolean } | { error: string }>;
      ptyWrite?: (sid: string, data: string) => Promise<void>;
      ptyResize?: (sid: string, cols: number, rows: number) => Promise<void>;
      ptyKill?: (sid: string) => Promise<void>;
      /** 탭/칸을 닫을 때 — sid를 모르는 탭도 키로 정리할 수 있다(고아 방지). */
      ptyKillKey?: (key: string) => Promise<void>;
      /** 지금 살아있는 세션 키만 돌려준다(서버 "실행 중" 표시가 저장값이 아니라 실제를 보게). */
      ptyAlive?: (keys: string[]) => Promise<string[]>;
      ptyReplay?: (sid: string) => Promise<string>;
      // 코드 독 패널 브라우저 칸 — 파일 열기 / 스크린샷 저장 / 끌어다 놓은 파일의 실제 경로.
      pickFile?: () => Promise<string | null>;
      saveScreenshot?: (png: ArrayBuffer, suggested?: string) => Promise<string | null>;
      filePath?: (file: File) => string;
      // 허용된 사이트 동기화 + 메인의 이동 차단 알림(2026-07-25 §이동 게이트).
      // 목록의 주인은 렌더러(localStorage)이고, 메인은 게스트 webview의 will-navigate/will-redirect를
      // 판정하기 위해 스냅샷만 받는다 — 판정 함수는 shared/site-gate.ts 하나를 공유한다.
      setAllowedSites?: (sites: string[]) => Promise<void>;
      onNavBlocked?: (cb: (url: string) => void) => () => void;
      /** AI 웹 조작 스크린샷 — 대화상자 없이 임시 폴더에 저장하고 경로를 돌려준다. */
      saveShotTemp?: (png: ArrayBuffer) => Promise<string | null>;
      onPtyData?: (cb: (sid: string, data: string) => void) => () => void;
      onPtyExit?: (cb: (sid: string, code: number) => void) => () => void;
      // 코드 패널 diff 뷰(코드 패널 Task 2 — git-diff.ts). 읽기 전용, 결과형(never-throw).
      gitDiffStatus?: (repoPath: string) => Promise<
        | { ok: true; files: Array<{ path: string; status: 'A' | 'M' | 'D' | 'R' | '?' }> }
        | { ok: false; reason: 'not-repo' | 'git-missing' | 'error' }
      >;
      gitDiffFile?: (repoPath: string, file: string) => Promise<
        { ok: true; diff: string } | { ok: false; reason: string }
      >;
      // 코드 채널 상단 줄(git-diff.ts branchStatus / git-pr.ts createPullRequest).
      gitBranchStatus?: (repoPath: string) => Promise<GitBranchStatus>;
      gitCreatePr?: (repoPath: string) => Promise<CreatePrResult>;
      // 음성 입력(로컬 Whisper — stt.ts). 녹음·마이크 권한은 렌더러, 전사는 메인.
      // 오디오는 16kHz 모노 Float32 PCM ArrayBuffer(stt-audio.ts toMono16k) — webm 원본 금지.
      sttAvailable?: () => Promise<{ model: string; ready: boolean; loading: boolean }>;
      sttEnsureModel?: () => Promise<{ ok: true; model: string } | { error: string }>;
      sttTranscribe?: (audio: ArrayBuffer, opts?: { sampleRate?: number; language?: string })
        => Promise<{ ok: true; text: string; ms: number } | { error: string }>;
      onSttProgress?: (cb: (s: SttProgress) => void) => () => void;
      // CLI 두뇌 로그인 상태(desktop Task — cli-auth.ts). 배너 UI는 렌더러(CliAuthBanner) 담당.
      cliAuthState?: () => Promise<CliAuthState | null>;
      cliAuthRefresh?: () => Promise<CliAuthState | null>;
      onCliAuthChanged?: (cb: (s: CliAuthState | null) => void) => () => void;
      // 자동 업데이트 상태(사용자 요청 2026-07-24) — 현재 버전 표시 + 다운로드된 새 버전 배너/설치 버튼.
      updateState?: () => Promise<{ current: string; pending: string | null }>;
      installUpdate?: () => Promise<void>;
      onUpdateReady?: (cb: (version: string) => void) => () => void;
    };
  }
}

// ---- <webview>(Electron) ----
// 독 패널 브라우저 칸의 실체. React가 모르는 태그라 JSX에 직접 선언한다. 속성은 전부 문자열이다
// (webview는 커스텀 엘리먼트라 boolean 속성이 없다). 안전 설정의 최종 강제는 메인 프로세스의
// will-attach-webview에서 한다 — 여기 값은 "요청"일 뿐이다(src/desktop/main.ts).
export interface WebviewElement extends HTMLElement {
  src: string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  getURL(): string;
  getTitle(): string;
  loadURL(url: string): Promise<void>;
  capturePage(): Promise<{ toPNG(): Uint8Array }>;
  executeJavaScript(code: string): Promise<unknown>;
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        partition?: string;
        /** 예: "contextIsolation=yes,nodeIntegration=no,sandbox=yes" */
        webpreferences?: string;
        useragent?: string;
        /** allowpopups는 절대 붙이지 않는다(팝업 차단 — 새 창 요청은 OS 브라우저로). */
      };
    }
  }
}
