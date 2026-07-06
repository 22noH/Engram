// Electron preload가 주입하는 최소 API(chat-preload.ts). 브라우저엔 없음(옵셔널).
declare global {
  interface Window {
    engramDesktop?: { pickFolder: () => Promise<string | null> };
  }
}
export {};
