import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron';

// 채팅 창(renderer)이 Code 채널 폴더 바인딩·코드 패널 터미널에 쓰는 최소 API.
// 브라우저(폰)엔 이 객체가 없으므로 chat.html이 텍스트 입력으로 폴백한다.
contextBridge.exposeInMainWorld('engramDesktop', {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('engram:pick-folder'),
  setupCode: (): Promise<string | null> => ipcRenderer.invoke('engram:setup-code'),
  // 부팅 정체 안내 화면(2026-07-26)의 '백엔드 재시작' 버튼. 그 화면은 렌더러가 아니라 메인이
  // 띄우는 대기 페이지지만 preload는 이 창의 모든 페이지에 걸리므로 같은 통로를 쓴다.
  // 트레이의 '재시작'과 완전히 같은 동작(engram:restart → restartChild).
  restartBackend: (): Promise<void> => ipcRenderer.invoke('engram:restart'),
  addLocalBrain: (name: string): Promise<{ endpoint: string; name: string } | null> =>
    ipcRenderer.invoke('engram:add-local-brain', name),

  // 코드 패널 터미널(레포 첫 스트리밍 IPC — webContents.send). pty 스폰·입출력은 전부 메인
  // 프로세스 경유, 렌더러엔 노드 API 미노출 유지.
  // channelId는 "세션 키"다 — 독 패널에서 터미널 탭이 여럿이 되면서 `채널id#탭id` 형태가 됐다.
  // created=false면 기존 세션 재사용(리플레이) — 서버 시작 명령 같은 1회성 입력은 보내면 안 된다.
  ptyStart: (channelId: string, cwd: string): Promise<{ sid: string; shell: string; created: boolean } | { error: string }> =>
    ipcRenderer.invoke('engram:pty-start', channelId, cwd),
  ptyWrite: (sid: string, data: string): Promise<void> => ipcRenderer.invoke('engram:pty-write', sid, data),
  ptyResize: (sid: string, cols: number, rows: number): Promise<void> => ipcRenderer.invoke('engram:pty-resize', sid, cols, rows),
  ptyKill: (sid: string): Promise<void> => ipcRenderer.invoke('engram:pty-kill', sid),
  // 탭/칸을 닫을 때 쓴다 — 그 탭이 한 번도 안 열렸으면 렌더러가 sid를 모른다(키는 항상 안다).
  ptyKillKey: (key: string): Promise<void> => ipcRenderer.invoke('engram:pty-kill-key', key),
  // 서버 메뉴의 "실행 중" 표시 — 저장된 탭이 아니라 실제 살아있는 세션을 본다.
  ptyAlive: (keys: string[]): Promise<string[]> => ipcRenderer.invoke('engram:pty-alive', keys),
  ptyReplay: (sid: string): Promise<string> => ipcRenderer.invoke('engram:pty-replay', sid),
  onPtyData: (cb: (sid: string, data: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { sid: string; data: string }): void => cb(payload.sid, payload.data);
    ipcRenderer.on('engram:pty-data', listener);
    return () => ipcRenderer.removeListener('engram:pty-data', listener);
  },
  onPtyExit: (cb: (sid: string, code: number) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { sid: string; code: number }): void => cb(payload.sid, payload.code);
    ipcRenderer.on('engram:pty-exit', listener);
    return () => ipcRenderer.removeListener('engram:pty-exit', listener);
  },

  // 코드 독 패널(2026-07-25) — 브라우저 칸 부가 기능.
  // pickFile: 더보기(⋮) "파일 열기" — 고른 경로를 렌더러가 file:// URL로 바꿔 새 탭에 연다.
  pickFile: (): Promise<string | null> => ipcRenderer.invoke('engram:pick-file'),
  // saveScreenshot: webview.capturePage()로 만든 PNG 바이트를 저장(대화상자는 메인). 저장 경로 반환.
  saveScreenshot: (png: ArrayBuffer, suggested?: string): Promise<string | null> =>
    ipcRenderer.invoke('engram:save-screenshot', png, suggested),
  // 허용된 사이트(단일 출처=렌더러 localStorage)를 메인에 밀어 넣는다. 메인은 게스트 webview의
  // will-navigate/will-redirect를 이 목록으로 판정한다(페이지 안 링크 클릭은 렌더러가 못 막는다).
  setAllowedSites: (sites: string[]): Promise<void> => ipcRenderer.invoke('engram:set-allowed-sites', sites),
  // 메인이 이동을 막았을 때 알림(조용한 차단 금지 — 왜 안 넘어갔는지 화면에 보여준다).
  onNavBlocked: (cb: (url: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, url: string): void => cb(url);
    ipcRenderer.on('engram:nav-blocked', listener);
    return () => ipcRenderer.removeListener('engram:nav-blocked', listener);
  },
  // 브라우저 칸 스크린샷 — ★캡처는 메인이 한다. 렌더러에서 webview.capturePage()를 부르면
  // 프로미스가 안 풀리고 채팅 창이 멎는다(실기 검증 2026-07-25). 게스트의 webContents id만 넘긴다.
  // where='temp'(AI 조작, 임시 폴더 고정) | 'dialog'(사용자가 직접 저장). 저장 경로를 돌려준다.
  captureWebview: (webContentsId: number, where: 'temp' | 'dialog', suggested?: string): Promise<string | null> =>
    ipcRenderer.invoke('engram:capture-webview', webContentsId, where, suggested),
  // 파일 끌어다 놓기: Electron 32+에서 File.path가 사라졌다 — 실제 경로는 webUtils로만 얻는다.
  // 이 함수는 preload(격리된 컨텍스트)에서만 동작한다(렌더러엔 webUtils가 없다).
  filePath: (file: File): string => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },

  // 코드 패널 diff 뷰(코드 패널 Task 2 — git-diff.ts). 읽기 전용, 결과형(never-throw).
  gitDiffStatus: (repoPath: string): Promise<unknown> => ipcRenderer.invoke('engram:git-diff-status', repoPath),
  gitDiffFile: (repoPath: string, file: string): Promise<unknown> => ipcRenderer.invoke('engram:git-diff-file', repoPath, file),

  // 코드 채널 상단 줄(`⑂ main  +1,741  −16  [PR 생성]`).
  // gitBranchStatus: 읽기 전용 — { ok:true, branch, detached, added, removed, files } | { ok:false, reason }
  gitBranchStatus: (repoPath: string): Promise<unknown> => ipcRenderer.invoke('engram:git-branch-status', repoPath),
  // ⚠️ gitCreatePr는 push + PR 생성(되돌리기 어려운 외부 동작)을 "즉시 실행"한다. 확인 다이얼로그는
  // 이 API를 부르는 렌더러 책임이다 — 메인엔 확인 절차가 없다.
  // → { ok:true, url, alreadyExisted } | { ok:false, reason, message }
  //   reason: 'not-repo'|'detached'|'on-default-branch'|'no-remote'|'gh-missing'|'gh-unauthenticated'|'push-failed'|'pr-failed'|'error'
  gitCreatePr: (repoPath: string): Promise<unknown> => ipcRenderer.invoke('engram:git-create-pr', repoPath),

  // 음성 입력(로컬 Whisper). 녹음·마이크 권한은 렌더러 담당, 전사는 메인.
  // 오디오는 16kHz 모노 Float32 PCM의 ArrayBuffer로 보내는 것을 권장한다(Web Audio로 디코드+리샘플:
  // decodeAudioData → OfflineAudioContext(1, len, 16000) → getChannelData(0).buffer). WAV 바이트도 받는다.
  // MediaRecorder의 webm/opus 원본을 그대로 보내면 안 된다(메인엔 그걸 풀 디코더가 없다).
  // sttAvailable: { model, ready, loading } — ready=false면 sttEnsureModel로 먼저 받아야 한다.
  sttAvailable: (): Promise<{ model: string; ready: boolean; loading: boolean }> =>
    ipcRenderer.invoke('engram:stt-available'),
  // sttEnsureModel: { ok:true, model } | { error } — 진행률은 onSttProgress로 흐른다.
  sttEnsureModel: (): Promise<unknown> => ipcRenderer.invoke('engram:stt-ensure-model'),
  // sttTranscribe: { ok:true, text, ms } | { error }. language 미지정 시 앱 로케일, 'auto'면 자동감지.
  sttTranscribe: (audio: ArrayBuffer, opts?: { sampleRate?: number; language?: string }): Promise<unknown> =>
    ipcRenderer.invoke('engram:stt-transcribe', audio, opts),
  onSttProgress: (cb: (s: { percent: number; loadedBytes: number; totalBytes: number; file: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, s: { percent: number; loadedBytes: number; totalBytes: number; file: string }): void => cb(s);
    ipcRenderer.on('engram:stt-progress', listener);
    return () => ipcRenderer.removeListener('engram:stt-progress', listener);
  },

  // CLI 두뇌 로그인 상태(선제 알림). 렌더러 배너용 계약만 — 배너 UI는 렌더러 담당.
  // cliAuthState: 현재 판정({ provider:'claude-cli'|'codex-cli', state:'logged-in'|'logged-out'|'unknown',
  //   detail?: string, fixCommand: string }) | null. null = 기본 두뇌가 CLI가 아님 = 배너 없음.
  //   state가 'logged-out'일 때만 경고한다('unknown'은 판단 불가 — 절대 경고하지 말 것).
  //   fixCommand는 복사용 명령(claude = 실행 후 /login 입력, codex = codex login).
  cliAuthState: (): Promise<{ provider: string; state: string; detail?: string; fixCommand: string } | null> =>
    ipcRenderer.invoke('engram:cli-auth-state'),
  // "다시 확인" — 즉시 재확인하고 갱신된 판정을 돌려준다.
  cliAuthRefresh: (): Promise<{ provider: string; state: string; detail?: string; fixCommand: string } | null> =>
    ipcRenderer.invoke('engram:cli-auth-refresh'),
  // 상태가 바뀔 때만 push된다(주기 확인 30분). 해제 함수를 돌려준다.
  onCliAuthChanged: (cb: (s: { provider: string; state: string; detail?: string; fixCommand: string } | null) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, s: { provider: string; state: string; detail?: string; fixCommand: string } | null): void => cb(s);
    ipcRenderer.on('engram:cli-auth-changed', listener);
    return () => ipcRenderer.removeListener('engram:cli-auth-changed', listener);
  },

  // 자동 업데이트 상태(사용자 요청 2026-07-24): 현재 버전 표시 + 다운로드된 새 버전 배너/버튼.
  updateState: (): Promise<{ current: string; pending: string | null }> => ipcRenderer.invoke('engram:update-state'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('engram:install-update'),
  onUpdateReady: (cb: (version: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, version: string): void => cb(version);
    ipcRenderer.on('engram:update-ready', listener);
    return () => ipcRenderer.removeListener('engram:update-ready', listener);
  },
});
