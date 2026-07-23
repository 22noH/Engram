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
});
