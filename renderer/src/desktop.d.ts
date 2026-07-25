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

declare global {
  interface Window {
    engramDesktop?: {
      pickFolder: () => Promise<string | null>;
      setupCode?: () => Promise<string | null>; // Task 15
      addLocalBrain?: (name: string) => Promise<{ endpoint: string; name: string } | null>; // Task 15
      // 코드 패널 터미널(코드 패널 Task 1 — pty 인프라). 채널당 1세션, cwd=채널 repoPath.
      ptyStart?: (channelId: string, cwd: string) => Promise<{ sid: string; shell: string } | { error: string }>;
      ptyWrite?: (sid: string, data: string) => Promise<void>;
      ptyResize?: (sid: string, cols: number, rows: number) => Promise<void>;
      ptyKill?: (sid: string) => Promise<void>;
      ptyReplay?: (sid: string) => Promise<string>;
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
      // 자동 업데이트 상태(사용자 요청 2026-07-24) — 현재 버전 표시 + 다운로드된 새 버전 배너/설치 버튼.
      updateState?: () => Promise<{ current: string; pending: string | null }>;
      installUpdate?: () => Promise<void>;
      onUpdateReady?: (cb: (version: string) => void) => () => void;
    };
  }
}
