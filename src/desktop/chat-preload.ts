import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// 채팅 창(renderer)이 Code 채널 폴더 바인딩·코드 패널 터미널에 쓰는 최소 API.
// 브라우저(폰)엔 이 객체가 없으므로 chat.html이 텍스트 입력으로 폴백한다.
contextBridge.exposeInMainWorld('engramDesktop', {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('engram:pick-folder'),
  setupCode: (): Promise<string | null> => ipcRenderer.invoke('engram:setup-code'),
  addLocalBrain: (name: string): Promise<{ endpoint: string; name: string } | null> =>
    ipcRenderer.invoke('engram:add-local-brain', name),

  // 코드 패널 터미널(레포 첫 스트리밍 IPC — webContents.send). pty 스폰·입출력은 전부 메인
  // 프로세스 경유, 렌더러엔 노드 API 미노출 유지.
  ptyStart: (channelId: string, cwd: string): Promise<{ sid: string; shell: string } | { error: string }> =>
    ipcRenderer.invoke('engram:pty-start', channelId, cwd),
  ptyWrite: (sid: string, data: string): Promise<void> => ipcRenderer.invoke('engram:pty-write', sid, data),
  ptyResize: (sid: string, cols: number, rows: number): Promise<void> => ipcRenderer.invoke('engram:pty-resize', sid, cols, rows),
  ptyKill: (sid: string): Promise<void> => ipcRenderer.invoke('engram:pty-kill', sid),
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
