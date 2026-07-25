import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// 설정창(renderer)이 쓰는 최소 API. 파일 쓰기·감지는 전부 메인 프로세스가 수행(스펙 §4).
contextBridge.exposeInMainWorld('engram', {
  status: () => ipcRenderer.invoke('engram:status'),
  detectClaude: () => ipcRenderer.invoke('engram:detect-claude'),
  detectOllama: () => ipcRenderer.invoke('engram:detect-ollama'),
  addOllama: (model: string, name: string, setDefault: boolean) =>
    ipcRenderer.invoke('engram:add-ollama', model, name, setDefault),
  detectCodex: () => ipcRenderer.invoke('engram:detect-codex'),
  addCodex: (name: string, cli: string, setDefault: boolean) =>
    ipcRenderer.invoke('engram:add-codex', name, cli, setDefault),
  // CLI 두뇌 로그인 상태(선제 알림) — 설정창 상태 줄 + "다시 확인" 버튼.
  cliAuthState: () => ipcRenderer.invoke('engram:cli-auth-state'),
  cliAuthRefresh: () => ipcRenderer.invoke('engram:cli-auth-refresh'),
  onCliAuthChanged: (cb: (s: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, s: unknown): void => cb(s);
    ipcRenderer.on('engram:cli-auth-changed', listener);
    return () => ipcRenderer.removeListener('engram:cli-auth-changed', listener);
  },
  removeBrain: (key: string) => ipcRenderer.invoke('engram:remove-brain', key),
  slugModel: (model: string) => ipcRenderer.invoke('engram:slug-model', model),
  saveToken: (token: string) => ipcRenderer.invoke('engram:save-token', token),
  saveApiKey: (apiKey: string, setDefault: boolean) =>
    ipcRenderer.invoke('engram:save-api-key', apiKey, setDefault),
  openPath: (which: string) => ipcRenderer.invoke('engram:open-path', which),
  restart: () => ipcRenderer.invoke('engram:restart'),
  logTail: () => ipcRenderer.invoke('engram:log-tail'),
  pickFolder: () => ipcRenderer.invoke('engram:pick-folder'),
  listBrains: () => ipcRenderer.invoke('engram:list-brains'),
  setDefaultBrain: (key: string) => ipcRenderer.invoke('engram:set-default-brain', key),
  getCommandMode: () => ipcRenderer.invoke('engram:get-command-mode'),
  setCommandMode: (mode: string) => ipcRenderer.invoke('engram:set-command-mode', mode),
  getMcpWriteMode: () => ipcRenderer.invoke('engram:get-mcp-write-mode'),
  setMcpWriteMode: (mode: string) => ipcRenderer.invoke('engram:set-mcp-write-mode', mode),
  listBrainDetails: () => ipcRenderer.invoke('engram:list-brain-details'),
  updateBrainProfile: (key: string, patch: Record<string, unknown>, newKey?: string) =>
    ipcRenderer.invoke('engram:update-brain-profile', key, patch, newKey),
  getPermissionDetails: () => ipcRenderer.invoke('engram:get-permission-details'),
  setPermissionList: (field: string, values: string[] | null) => ipcRenderer.invoke('engram:set-permission-list', field, values),
  getCodeRepos: () => ipcRenderer.invoke('engram:get-coderepos'),
  setCodeAlias: (alias: string, targetPath: string) => ipcRenderer.invoke('engram:set-code-alias', alias, targetPath),
  removeCodeAlias: (alias: string) => ipcRenderer.invoke('engram:remove-code-alias', alias),
  setSearchRoots: (roots: string[]) => ipcRenderer.invoke('engram:set-search-roots', roots),
  listSchedules: () => ipcRenderer.invoke('engram:list-schedules'),
  removeSchedule: (id: string) => ipcRenderer.invoke('engram:remove-schedule', id),
  getWikiRemote: () => ipcRenderer.invoke('engram:get-wiki-remote'),
  setWikiRemote: (cfg: { remote: string; branch: string; syncIntervalSec: number }) => ipcRenderer.invoke('engram:set-wiki-remote', cfg),
  listMcpServers: () => ipcRenderer.invoke('engram:list-mcp-servers'),
  addMcpServer: (name: string, command: string, argsLine: string) => ipcRenderer.invoke('engram:add-mcp-server', name, command, argsLine),
  removeMcpServer: (name: string) => ipcRenderer.invoke('engram:remove-mcp-server', name),
  syncClaudeMcp: () => ipcRenderer.invoke('engram:sync-claude-mcp'),
  // 폴더 자동 변환(감시 폴더 → 위키): 설정 읽기/쓰기 + 진행 상황 + "지금 검사".
  getFolderImport: () => ipcRenderer.invoke('engram:get-folder-import'),
  setFolderImport: (cfg: Record<string, unknown>) => ipcRenderer.invoke('engram:set-folder-import', cfg),
  folderImportStatus: () => ipcRenderer.invoke('engram:folder-import-status'),
  folderImportScan: () => ipcRenderer.invoke('engram:folder-import-scan'),
  getChatRetention: () => ipcRenderer.invoke('engram:get-chat-retention'),
  setChatRetention: (retention: { mode: 'count' | 'days' | 'unlimited'; value?: number }, autoCompact: boolean) =>
    ipcRenderer.invoke('engram:set-chat-retention', retention, autoCompact),
});
