import { contextBridge, ipcRenderer } from 'electron';

// 설정창(renderer)이 쓰는 최소 API. 파일 쓰기·감지는 전부 메인 프로세스가 수행(스펙 §4).
contextBridge.exposeInMainWorld('engram', {
  status: () => ipcRenderer.invoke('engram:status'),
  detectClaude: () => ipcRenderer.invoke('engram:detect-claude'),
  detectOllama: () => ipcRenderer.invoke('engram:detect-ollama'),
  addOllama: (model: string, name: string, setDefault: boolean) =>
    ipcRenderer.invoke('engram:add-ollama', model, name, setDefault),
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
});
