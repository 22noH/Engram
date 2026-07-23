// Electron preload가 주입하는 최소 API(chat-preload.ts). 브라우저엔 없음(옵셔널).
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
    };
  }
}
export {};
