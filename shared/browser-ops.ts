// AI 웹 조작(2단계) 와이어 계약 — 두뇌(백엔드)와 렌더러(독 브라우저 칸)의 단일 진실원.
// 타입만 두는 protocol.ts와 달리 여기엔 도구 이름 상수가 있다(백엔드 도구 정의와 렌더러 라벨이
// 같은 문자열을 봐야 하므로). 실행 자체는 렌더러의 <webview>가 한다.

export type BrowserOp =
  /** 주소 이동. 브라우저 칸이 없으면 렌더러가 만들고 연다. */
  | { kind: 'navigate'; url: string }
  /** 요소 클릭. target = CSS 선택자 또는 `text=보이는 글자`. */
  | { kind: 'click'; target: string }
  /** 입력칸에 글자 넣기. submit=true면 엔터(폼 전송)까지. */
  | { kind: 'type'; target: string; text: string; submit?: boolean }
  /** 화면 내용 읽기(선택자 생략 시 페이지 전체 텍스트 + 조작 가능한 요소 목록). */
  | { kind: 'read'; selector?: string }
  /** 콘솔 메시지(오류 우선). */
  | { kind: 'console' }
  /** 네트워크 요청 목록. */
  | { kind: 'network' }
  /** 스크린샷 저장(경로를 돌려준다 — 두뇌가 그 파일을 읽어 볼 수 있다). */
  | { kind: 'screenshot' };

export interface BrowserOpResult {
  ok: boolean;
  /** 두뇌에게 그대로 돌려줄 텍스트(성공 결과 또는 실패 사유). never-throw 계약. */
  text: string;
}

/** MCP·자체 하네스가 노출하는 도구 이름 ↔ 조작 종류. */
export const BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_read',
  'browser_console',
  'browser_network',
  'browser_screenshot',
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

export function isBrowserToolName(name: string): name is BrowserToolName {
  return (BROWSER_TOOL_NAMES as readonly string[]).includes(name);
}

// ---- 도구 정의(단일 진실원) ----
// 자체 하네스(CompleteOpts.browser)와 MCP(engram-mcp)가 **같은 이름·같은 설명**을 노출해야 한다 —
// 두뇌가 어느 경로로 들어오든 같은 도구를 보게. 스키마 모양은 provider 중립(JSON Schema).

/**
 * MCP 경로에서 채널 정체성을 싣는 인자 이름. 모델이 채워 넣는 값이 아니라 **브리지가 스폰 env
 * (ENGRAM_CHANNEL_ID)에서 읽어 덧붙이는** 값이다 — 그래서 도구 스키마에는 노출하지 않는다
 * (모델이 임의 채널을 지목해 남의 화면을 조작하는 길을 만들지 않는다).
 */
export const CHANNEL_ARG = '_channel';

export interface BrowserToolDef {
  name: BrowserToolName;
  description: string;
  parameters: Record<string, unknown>;
}

/** 조작 대상 지정 방식 설명(click·type이 공유). */
const TARGET_DESC =
  'CSS selector (e.g. "#email", "button.primary") or "text=<visible text>" to match by the text a person sees.';

export const BROWSER_TOOL_DEFS: BrowserToolDef[] = [
  {
    name: 'browser_navigate',
    description:
      'Open a URL in the Engram code panel browser (a real browser pane the user can watch). ' +
      'Use this to look at the page you just built, e.g. http://localhost:5173. Opens the pane if it is closed.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) URL or local file path' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element on the page currently shown in the browser pane.',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string', description: TARGET_DESC } },
      required: ['target'],
    },
  },
  {
    name: 'browser_type',
    description:
      'Type text into an input on the page. Sign-in and payment fields are always refused — never try to ' +
      'enter passwords, one-time codes or card numbers; ask the user to do that themselves.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: TARGET_DESC },
        text: { type: 'string', description: 'Text to type (replaces the current value)' },
        submit: { type: 'boolean', description: 'Press Enter afterwards to submit the form' },
      },
      required: ['target', 'text'],
    },
  },
  {
    name: 'browser_read',
    description:
      'Read what is on the page: visible text plus the clickable/typeable elements with selectors you can use. ' +
      'Call this before clicking so you target real elements instead of guessing.',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'Optional CSS selector to read only that part' } },
    },
  },
  {
    name: 'browser_console',
    description: 'Read console messages (errors first) from the page — this is how you find the bug you just wrote.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'browser_network',
    description: 'List the network requests the page made (URL, type, size, duration) to spot failed or slow calls.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture the page as a PNG file and return its path. Read that file if you need to look at the pixels.',
    parameters: { type: 'object', properties: {} },
  },
];

/** 도구 호출 인자 → 조작 op. 인자가 틀리면 사유 문자열(에러 텍스트)로 돌려준다. never-throw. */
export function toBrowserOp(name: string, input: unknown): BrowserOp | string {
  const arg = (input ?? {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof arg[k] === 'string' ? (arg[k] as string).trim() : '');
  switch (name) {
    case 'browser_navigate': {
      const url = str('url');
      return url ? { kind: 'navigate', url } : 'browser_navigate error: url(string) required';
    }
    case 'browser_click': {
      const target = str('target');
      return target ? { kind: 'click', target } : 'browser_click error: target(string) required';
    }
    case 'browser_type': {
      const target = str('target');
      if (!target) return 'browser_type error: target(string) required';
      if (typeof arg.text !== 'string') return 'browser_type error: text(string) required';
      return { kind: 'type', target, text: arg.text, ...(arg.submit === true ? { submit: true } : {}) };
    }
    case 'browser_read': {
      const selector = str('selector');
      return selector ? { kind: 'read', selector } : { kind: 'read' };
    }
    case 'browser_console':
      return { kind: 'console' };
    case 'browser_network':
      return { kind: 'network' };
    case 'browser_screenshot':
      return { kind: 'screenshot' };
    default:
      return `tool error: unknown tool ${name}`;
  }
}

/** 행동 로그 한 줄(렌더러가 보여주고, 사후 추적에 쓴다). */
export interface BrowserLogEntry {
  id: string;
  ts: number;
  /** 사람이 읽는 한 줄 요약(예: "클릭 · 로그인"). */
  label: string;
  status: 'ok' | 'fail' | 'blocked' | 'skipped';
  /** 실패·차단 사유(있을 때만). */
  detail?: string;
}
