import { describe, expect, it } from 'vitest';
import {
  ANSI_KEYS, ansiToken, buildXtermTheme, contextMenuAction, dockButtonHoldsFocus, isPasteShortcut,
  LIGHT_ANSI, shouldFocusTerminal, shouldPreventPaneMouseDown,
} from './terminal';

// 사용자가 실제로 겪은 3번(입력 글자가 노란색이라 흰 배경에서 안 보임)의 회귀 방지.
// 원인은 buildXtermTheme가 background/foreground/cursor만 주고 ANSI 16색을 안 줘서
// xterm 기본 팔레트(어두운 배경 전제)가 그대로 남은 것이었다.
describe('터미널 팔레트 — ANSI 16색', () => {
  const empty = () => ''; // 토큰이 하나도 없는 환경(폴백만 쓰이는 경우)

  it('16색을 하나도 빠뜨리지 않는다', () => {
    const theme = buildXtermTheme(empty);
    for (const key of ANSI_KEYS) {
      expect(theme[key], `${key}가 비어 있으면 xterm 기본값(어두운 배경 전제)이 남는다`).toBeTruthy();
    }
    expect(ANSI_KEYS).toHaveLength(16);
  });

  it('배경·전경·커서도 함께 준다(기존 동작 유지)', () => {
    const theme = buildXtermTheme(empty);
    for (const k of ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground']) {
      expect(theme[k]).toBeTruthy();
    }
  });

  it('토큰 이름은 --term-bright-black 꼴로 만든다', () => {
    expect(ansiToken('black')).toBe('--term-black');
    expect(ansiToken('brightBlack')).toBe('--term-bright-black');
    expect(ansiToken('brightYellow')).toBe('--term-bright-yellow');
  });

  it('theme.css 토큰이 있으면 그 값이 폴백을 이긴다(다크 모드 자동 전환의 배선)', () => {
    const dark = (name: string) => (name === '--term-yellow' ? '#e0c485' : name === '--panel-2' ? '#22251f' : '');
    const theme = buildXtermTheme(dark);
    expect(theme.yellow).toBe('#e0c485');
    expect(theme.background).toBe('#22251f');
    expect(theme.red).toBe(LIGHT_ANSI.red); // 토큰 없는 색만 폴백
  });

  // 흰 배경(--panel-2 = #ffffff)에서 실제로 읽히는 값이어야 한다.
  // 노랑이 노란색으로 남아 있으면 사용자가 겪은 그 버그가 그대로다.
  it('폴백 노랑은 흰 배경에서 읽히는 진한 황토·갈색이다', () => {
    for (const key of ['yellow', 'brightYellow'] as const) {
      expect(relLuminance(LIGHT_ANSI[key])).toBeLessThan(0.25);
      expect(contrastOnWhite(LIGHT_ANSI[key])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('폴백 16색 전부 흰 배경에서 최소 대비를 넘긴다(흰 바탕 흰 글씨 금지)', () => {
    for (const key of ANSI_KEYS) {
      expect(contrastOnWhite(LIGHT_ANSI[key]), `${key}=${LIGHT_ANSI[key]}는 흰 배경에서 안 보인다`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });
});

// 사용자가 실제로 겪은 1·2번(스페이스·한글) — 실기로 확정한 원인은 "터미널이 포커스를 못 받는다"였다.
describe('터미널 포커스 규칙', () => {
  const el = (html: string): Element => {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.firstElementChild as Element;
  };

  it('포커스가 없으면(body 등) 가져간다', () => {
    expect(shouldFocusTerminal(null)).toBe(true);
    expect(shouldFocusTerminal(document.body)).toBe(true);
  });

  // ★실기 확정: ⌨ 아이콘·＋ 새 탭으로 열면 포커스가 버튼에 남고, 그 상태의 스페이스는
  // "버튼 누르기"로 소비된다(탭이 하나 더 생기는 것을 재현으로 확인했다).
  it('버튼에 포커스가 있으면 가져간다 — 스페이스가 버튼을 누르는 사고의 봉합', () => {
    expect(shouldFocusTerminal(el('<button class="dockTabBtn">＋</button>'))).toBe(true);
    expect(shouldFocusTerminal(el('<button class="codeIconBtn">⌨</button>'))).toBe(true);
  });

  it('글자를 넣는 요소에서는 절대 뺏지 않는다 — 채팅 입력 회귀 0', () => {
    expect(shouldFocusTerminal(el('<textarea id="input"></textarea>'))).toBe(false);
    expect(shouldFocusTerminal(el('<input type="text" />'))).toBe(false);
    expect(shouldFocusTerminal(el('<select></select>'))).toBe(false);
  });

  it('contenteditable에서도 뺏지 않는다', () => {
    const d = document.createElement('div');
    d.setAttribute('contenteditable', 'true');
    Object.defineProperty(d, 'isContentEditable', { value: true });
    expect(shouldFocusTerminal(d)).toBe(false);
  });

  it('xterm 자신의 보조 textarea는 예외(이미 터미널이다)', () => {
    expect(shouldFocusTerminal(el('<textarea class="xterm-helper-textarea"></textarea>'))).toBe(true);
  });
});

describe('독 버튼이 포커스를 쥔 상태 판정', () => {
  const el = (html: string): Element => {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.firstElementChild as Element;
  };

  it('도구 아이콘·탭 버튼·레일 버튼을 알아본다', () => {
    expect(dockButtonHoldsFocus(el('<button class="codeIconBtn">⌨</button>'))).toBe(true);
    expect(dockButtonHoldsFocus(el('<button class="dockTabBtn">＋</button>'))).toBe(true);
    expect(dockButtonHoldsFocus(el('<button class="dockRailBtn">⊟</button>'))).toBe(true);
  });

  it('그 외(body·입력창·xterm textarea)는 아니다', () => {
    expect(dockButtonHoldsFocus(null)).toBe(false);
    expect(dockButtonHoldsFocus(document.body)).toBe(false);
    expect(dockButtonHoldsFocus(el('<textarea class="xterm-helper-textarea"></textarea>'))).toBe(false);
    expect(dockButtonHoldsFocus(el('<button class="updateBtn">x</button>'))).toBe(false);
  });
});

describe('터미널 칸 mousedown 기본 동작 차단 판정', () => {
  it('xterm 격자 안쪽은 막지 않는다 — 드래그 선택이 깨지면 안 된다', () => {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<div class="xterm"><div class="xterm-screen"><span id="cell">x</span></div></div>';
    expect(shouldPreventPaneMouseDown(wrap.querySelector('#cell'))).toBe(false);
    expect(shouldPreventPaneMouseDown(wrap.querySelector('.xterm-screen'))).toBe(false);
  });

  // 여기서 막지 않으면 우리가 준 포커스를 브라우저 기본 동작이 곧바로 <body>로 날린다(실기 확인).
  it('격자 바깥(표면 여백·죽은 영역)은 막는다', () => {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<div class="codeTerm"><div class="codeTermSurface"></div></div>';
    expect(shouldPreventPaneMouseDown(wrap.querySelector('.codeTermSurface'))).toBe(true);
    expect(shouldPreventPaneMouseDown(null)).toBe(true);
  });
});

// 사용자가 실제로 겪은 4번 — 윈도우 터미널 관례가 아예 없었다.
describe('우클릭 분기 — 윈도우 터미널 관례', () => {
  it('선택 영역이 있으면 복사', () => {
    expect(contextMenuAction(true)).toBe('copy');
  });
  it('선택 영역이 없으면 붙여넣기', () => {
    expect(contextMenuAction(false)).toBe('paste');
  });
});

describe('붙여넣기 단축키', () => {
  const ev = (o: Partial<{ type: string; ctrlKey: boolean; shiftKey: boolean; key: string }>) =>
    ({ type: 'keydown', ctrlKey: false, shiftKey: false, key: 'v', ...o });

  it('Ctrl+Shift+V는 붙여넣기다', () => {
    expect(isPasteShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'v' }))).toBe(true);
    expect(isPasteShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'V' }))).toBe(true);
  });

  it('Ctrl+V는 가로채지 않는다 — 셸로 그대로 가야 한다', () => {
    expect(isPasteShortcut(ev({ ctrlKey: true, shiftKey: false }))).toBe(false);
  });

  it('keyup이나 다른 키는 아니다', () => {
    expect(isPasteShortcut(ev({ type: 'keyup', ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPasteShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'c' }))).toBe(false);
  });
});

// --- 대비 계산(WCAG) — 팔레트가 "흰 배경에서 읽히는지"를 눈이 아니라 수치로 잠근다 ---
function relLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrastOnWhite(hex: string): number {
  return 1.05 / (relLuminance(hex) + 0.05);
}
