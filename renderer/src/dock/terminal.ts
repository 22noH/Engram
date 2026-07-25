// 독 패널 터미널의 "순수 규칙"만 모아 둔 곳 — 팔레트 · 포커스 · 우클릭 분기.
// TerminalPane.tsx는 xterm 인스턴스를 들고 있어 단위 테스트가 어렵다. 실제로 버그가 났던
// 판정 세 가지(ANSI 16색 · 언제 포커스를 뺏어도 되나 · 우클릭이 복사냐 붙여넣기냐)를 여기로
// 빼서 xterm 없이 검증한다.

/** xterm 테마의 ANSI 16색 키(순서 = 표준 0~15). 하나라도 빠지면 xterm 기본값(어두운 배경 전제)이 남는다. */
export const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

export type AnsiKey = (typeof ANSI_KEYS)[number];

/** 'brightBlack' → '--term-bright-black' (theme.css 토큰 이름 규칙). */
export function ansiToken(key: AnsiKey): string {
  return '--term-' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

// ★ 흰 배경용 폴백 팔레트(GitHub Light 계열).
// xterm 기본 팔레트는 **어두운 배경 전제**라 흰 배경에선 노랑·밝은색이 사실상 안 보인다.
// PowerShell(PSReadLine)은 명령어를 brightYellow, 숫자를 white로 칠하므로 그 둘이 특히 중요하다:
//  · yellow/brightYellow → 진한 황토·갈색(연노랑 금지)
//  · white/brightWhite → 흰색이 아니라 읽히는 중간~진한 회색(흰 바탕에 흰 글씨 금지)
// 다크 모드 값은 theme.css의 @media (prefers-color-scheme: dark) 토큰이 덮는다.
export const LIGHT_ANSI: Record<AnsiKey, string> = {
  black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#7d4e00',
  blue: '#0550ae', magenta: '#6639ba', cyan: '#1b7c83', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#9a6700',
  // brightCyan은 GitHub Light 원값(#3192aa)이 흰 배경 대비 3.6:1로 미달이라 한 단계 조인다.
  brightBlue: '#0969da', brightMagenta: '#8250df', brightCyan: '#22808f', brightWhite: '#424a53',
};

/** CSS 변수 읽기(없으면 빈 문자열) — 테스트에선 가짜 리더를 넣는다. */
export type VarReader = (name: string) => string;

/** 문서 루트의 계산된 스타일에서 토큰을 읽는 리더. jsdom 등 getComputedStyle이 없으면 전부 빈 값. */
export function cssVarReader(): VarReader {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  return (name) => cs?.getPropertyValue(name)?.trim() || '';
}

/**
 * QL 토큰에서 xterm 테마를 구성한다. 배경/전경/커서는 기존 그대로(라이트=종이톤·다크=흑연),
 * 거기에 **ANSI 16색 전부**를 얹는다 — 하나라도 비우면 그 색만 xterm 기본값(어두운 배경 전제)이 남는다.
 */
export function buildXtermTheme(read: VarReader): Record<string, string> {
  const v = (name: string, fallback: string) => read(name) || fallback;
  const theme: Record<string, string> = {
    background: v('--panel-2', '#ffffff'),
    foreground: v('--text', '#24292e'),
    cursor: v('--accent', '#2e6e63'),
    cursorAccent: v('--panel-2', '#ffffff'),
    selectionBackground: v('--accent-soft', '#eef2ee'),
  };
  for (const key of ANSI_KEYS) theme[key] = v(ansiToken(key), LIGHT_ANSI[key]);
  return theme;
}

/**
 * 터미널이 지금 포커스를 가져가도 되는가.
 *
 * ★실기로 확정한 버그(2026-07-25): 독 터미널은 **xterm 격자를 직접 클릭했을 때만** 포커스를 받았다.
 * ⌨ 도구 아이콘·＋ 새 탭으로 열면 포커스가 그 <button>에 남고, 탭 헤더(span)를 누르면 <body>로 빠진다.
 * 그 상태에서 스페이스는 "포커스된 버튼 누르기"로 소비되고(탭이 하나 더 생긴다), 한글은 조합
 * 이벤트 자체가 안 뜬다(compositionstart 0건) — 사용자가 겪은 1·2번이 같은 원인이다.
 *
 * 그렇다고 무조건 뺏으면 채팅 입력창에서 글자를 치던 중 독이 뜨는 순간 커서를 빼앗긴다.
 * 규칙: **글자를 넣는 요소(input/textarea/select/contenteditable)에서는 절대 안 뺏고**,
 * 그 외(버튼·body 등 어차피 타이핑이 안 되는 곳)에서는 가져간다. xterm 자신의 보조 textarea는 예외.
 */
export function shouldFocusTerminal(active: Element | null | undefined): boolean {
  if (!active) return true;
  if (active.classList?.contains('xterm-helper-textarea')) return true; // 이미 터미널
  const tag = active.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  if ((active as HTMLElement).isContentEditable) return false;
  return true;
}

/**
 * 독의 버튼류(도구 아이콘 ⌨ · 탭 줄의 ＋⊟⊞✕ · 왼쪽 레일). 이것들 중 하나가 포커스를 쥐고 있으면
 * 스페이스는 터미널이 아니라 **그 버튼**으로 간다 — ＋에 포커스가 남은 채 스페이스를 치면 탭이
 * 하나 더 생기는 것을 실기로 확인했다. 그래서 "독 버튼이 포커스를 쥔 상태"를 따로 판정한다.
 */
export const DOCK_BUTTON_SELECTOR = '.codeIconBtn, .dockTabBtn, .dockRailBtn';

export function dockButtonHoldsFocus(active: Element | null | undefined): boolean {
  return !!active && typeof active.matches === 'function' && active.matches(DOCK_BUTTON_SELECTOR);
}

/**
 * 터미널 칸 안에서 마우스를 눌렀을 때 브라우저 기본 동작을 막아야 하는가.
 *
 * xterm 격자(.xterm) 안쪽은 xterm이 스스로 포커스와 드래그 선택을 처리한다 — 여기서 preventDefault를
 * 하면 선택이 깨진다. 반대로 격자 **바깥**(.codeTermSurface의 padding, 격자 오른쪽 죽은 영역)은
 * 포커스를 받을 수 없는 요소라 기본 동작이 포커스를 <body>로 날려버린다. 그래서 바깥일 때만 막고
 * 우리가 직접 터미널에 포커스를 준다.
 */
export function shouldPreventPaneMouseDown(target: Element | null | undefined): boolean {
  if (!target) return true;
  if (typeof target.closest !== 'function') return true;
  return !target.closest('.xterm');
}

export type ContextMenuAction = 'copy' | 'paste';

/**
 * 윈도우 터미널 관례(PowerShell·cmd 기본): 선택 영역이 있으면 우클릭=복사, 없으면 우클릭=붙여넣기.
 * Ctrl+V는 손대지 않는다 — 셸에 그대로 가야 한다(관례상 터미널 붙여넣기는 Ctrl+Shift+V).
 */
export function contextMenuAction(hasSelection: boolean): ContextMenuAction {
  return hasSelection ? 'copy' : 'paste';
}

/** Ctrl+Shift+V인가(터미널 붙여넣기 관례). Ctrl+V는 false — 셸로 그냥 흘려보낸다. */
export function isPasteShortcut(e: { type: string; ctrlKey: boolean; shiftKey: boolean; key: string }): boolean {
  return e.type === 'keydown' && e.ctrlKey && e.shiftKey && (e.key === 'v' || e.key === 'V');
}
