import { contextBridge, ipcRenderer } from 'electron';

// 설정창(renderer)이 쓰는 최소 API. 파일 쓰기·감지는 전부 메인 프로세스가 수행(스펙 §4).
contextBridge.exposeInMainWorld('engram', {
  status: () => ipcRenderer.invoke('engram:status'),
  detectClaude: () => ipcRenderer.invoke('engram:detect-claude'),
  detectOllama: () => ipcRenderer.invoke('engram:detect-ollama'),
  addOllama: (model: string, setDefault: boolean) =>
    ipcRenderer.invoke('engram:add-ollama', model, setDefault),
  saveToken: (token: string) => ipcRenderer.invoke('engram:save-token', token),
  saveApiKey: (apiKey: string, setDefault: boolean) =>
    ipcRenderer.invoke('engram:save-api-key', apiKey, setDefault),
  openPath: (which: string) => ipcRenderer.invoke('engram:open-path', which),
  restart: () => ipcRenderer.invoke('engram:restart'),
  logTail: () => ipcRenderer.invoke('engram:log-tail'),
});
