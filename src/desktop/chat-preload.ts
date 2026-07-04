import { contextBridge, ipcRenderer } from 'electron';

// 채팅 창(renderer)이 Code 채널 폴더 바인딩에 쓰는 최소 API.
// 브라우저(폰)엔 이 객체가 없으므로 chat.html이 텍스트 입력으로 폴백한다.
contextBridge.exposeInMainWorld('engramDesktop', {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('engram:pick-folder'),
});
