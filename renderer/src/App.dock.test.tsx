import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import App from './App';

// 코드 독 패널(2026-07-25) — App 레벨 배선 테스트.
// 지키는 것: 게이트(코드 채널·데스크톱에서만) · 채널별 퍼시스트 · **세션 정리 규칙**(탭/칸을 닫으면
// kill, 패널만 접거나 모드를 옮기면 kill 금지) · 기존 단일 패널 값 이관 · 분할 후 두 칸 동시 렌더.
//
// xterm은 모킹한다(jsdom엔 canvas가 없다) — 렌더 디테일이 아니라 배선만 본다.
vi.mock('@xterm/xterm', () => {
  class Terminal {
    options: any;
    cols = 80; rows = 24;
    constructor(opts: any) { this.options = opts; }
    open() {}
    loadAddon() {}
    write() {}
    writeln() {}
    onData() { return { dispose: vi.fn() }; }
    dispose() {}
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => {
  class FitAddon { fit() {} }
  return { FitAddon };
});

class FakeWS {
  static last: FakeWS;
  static OPEN = 1;
  onopen: (() => void) | null = null; onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null; onerror: (() => void) | null = null;
  readyState = 1; sent: string[] = [];
  constructor() { FakeWS.last = this; }
  send(d: string) { this.sent.push(d); }
  close() {}
}
beforeEach(() => { localStorage.clear(); (globalThis as any).WebSocket = FakeWS as any; });
afterEach(() => { vi.restoreAllMocks(); delete (window as any).engramDesktop; });

function fakeDesktopApi() {
  return {
    ptyStart: vi.fn(async (key: string, _cwd: string) => ({ sid: 'sid-' + key, shell: 'PowerShell', created: true })),
    ptyWrite: vi.fn(async () => {}),
    ptyResize: vi.fn(async () => {}),
    ptyKill: vi.fn(async () => {}),
    ptyKillKey: vi.fn(async () => {}),
    ptyAlive: vi.fn(async (keys: string[]) => keys),
    ptyReplay: vi.fn(async () => ''),
    onPtyData: vi.fn(() => vi.fn()),
    onPtyExit: vi.fn(() => vi.fn()),
    gitDiffStatus: vi.fn(async () => ({ ok: true as const, files: [] })),
    gitDiffFile: vi.fn(async () => ({ ok: true as const, diff: '' })),
    pickFile: vi.fn(async () => null),
    saveScreenshot: vi.fn(async () => null),
  };
}

const CHANNELS = [{ id: 'w-code', name: 'proj', respondMode: 'all', mode: 'code', repoPath: 'C:/repo/proj' }];

async function openCodeChannel(list: unknown[] = CHANNELS) {
  const r = render(<App />);
  act(() => { FakeWS.last.onopen!(); });
  act(() => { FakeWS.last.onmessage!({ data: JSON.stringify({ t: 'channels', list }) }); });
  fireEvent.click(screen.getByText('Code'));
  await waitFor(() => expect(screen.getByTitle('C:/repo/proj')).toBeInTheDocument());
  return r;
}

// 글리프로 버튼을 찾는다(로케일 무관).
function glyph(g: string, root: ParentNode = document): HTMLElement {
  const el = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === g);
  if (!el) throw new Error(`button "${g}" not found`);
  return el as HTMLElement;
}
function toolIcons() { return document.querySelectorAll('.chhdrIcons .codeIconBtn'); }
function tabsOf(): ParentNode { return document.querySelector('.dockTabs') as ParentNode; }
function railBtns() { return Array.from(document.querySelectorAll('.dockRailBtn')) as HTMLElement[]; }
function panes() { return Array.from(document.querySelectorAll('.dockPane')); }

describe('게이트 — 독은 코드 채널 + 데스크톱에서만 뜬다(회귀 0)', () => {
  it('비데스크톱에서는 아이콘도 독도 없다', async () => {
    await openCodeChannel();
    expect(document.querySelector('.chhdrIcons')).toBeNull();
    expect(document.querySelector('.dockPanel')).toBeNull();
  });

  it('게이트가 닫힌 코드 채널의 #chhdr는 기존 마크업(순수 텍스트) 그대로', async () => {
    await openCodeChannel();
    const chhdr = document.getElementById('chhdr') as HTMLElement;
    expect(chhdr.querySelector('span')).toBeNull();
    expect(chhdr.style.display).toBe('block');
    expect(chhdr.textContent).toBe('📁 proj');
  });

  it('chat 모드에서는 아이콘이 안 뜬다', async () => {
    (window as any).engramDesktop = fakeDesktopApi();
    render(<App />);
    act(() => { FakeWS.last.onopen!(); });
    act(() => {
      FakeWS.last.onmessage!({ data: JSON.stringify({ t: 'channels', list: [{ id: 'g1', name: 'general', respondMode: 'all', mode: 'chat' }] }) });
    });
    await waitFor(() => expect(screen.getByText('# general')).toBeInTheDocument());
    expect(document.querySelector('.chhdrIcons')).toBeNull();
  });

  it('repoPath 미바인딩 코드 채널(FolderEmpty)에서는 아이콘이 안 뜬다', async () => {
    (window as any).engramDesktop = fakeDesktopApi();
    render(<App />);
    act(() => { FakeWS.last.onopen!(); });
    act(() => {
      FakeWS.last.onmessage!({ data: JSON.stringify({ t: 'channels', list: [{ id: 'w-code', name: 'proj', respondMode: 'all', mode: 'code' }] }) });
    });
    fireEvent.click(screen.getByText('Code'));
    await waitFor(() => expect(screen.getByText(/폴더 선택|Choose folder/)).toBeInTheDocument());
    expect(document.querySelector('.chhdrIcons')).toBeNull();
  });

  it('데스크톱+repoPath 바인딩이면 도구 아이콘 3개가 뜬다', async () => {
    (window as any).engramDesktop = fakeDesktopApi();
    await openCodeChannel();
    expect(toolIcons()).toHaveLength(3);
  });
});

describe('열기 · 퍼시스트 · 이관', () => {
  it('터미널 아이콘을 누르면 독이 열리고 ptyStart가 `채널#탭` 키로 불린다', async () => {
    const api = fakeDesktopApi();
    (window as any).engramDesktop = api;
    await openCodeChannel();
    fireEvent.click(toolIcons()[0]);
    expect(document.querySelector('.dockPanel')).toBeInTheDocument();
    await waitFor(() => expect(api.ptyStart).toHaveBeenCalled());
    const [key, cwd] = api.ptyStart.mock.calls[0];
    expect(key).toMatch(/^w-code#/);
    expect(cwd).toBe('C:/repo/proj');
  });

  it('레이아웃은 채널별로 저장되고 재마운트해도 복원된다', async () => {
    (window as any).engramDesktop = fakeDesktopApi();
    const first = await openCodeChannel();
    fireEvent.click(toolIcons()[2]); // Diff
    await waitFor(() => expect(document.querySelector('.dockPanel')).toBeInTheDocument());
    expect(localStorage.getItem('engram.dock.layout')).toContain('w-code');
    expect(localStorage.getItem('engram.dock.layout')).toContain('diff');
    first.unmount();

    await openCodeChannel();
    await waitFor(() => expect(document.querySelector('.dockPanel')).toBeInTheDocument());
    expect(document.querySelector('.codeDiff')).toBeInTheDocument();
  });

  it('기존 단일 패널 값(engram.codePanel.open)이 그대로 이관돼 패널이 열린 채로 뜬다', async () => {
    localStorage.setItem('engram.codePanel.open', JSON.stringify({ 'w-code': 'preview' }));
    (window as any).engramDesktop = fakeDesktopApi();
    await openCodeChannel();
    await waitFor(() => expect(document.querySelector('.dockPanel')).toBeInTheDocument());
    expect(document.querySelector('.dockBrowser')).toBeInTheDocument(); // 예전 '미리보기' = 브라우저 칸
  });

  it('저장값이 깨져 있어도 터지지 않고 닫힌 상태로 뜬다', async () => {
    localStorage.setItem('engram.dock.layout', JSON.stringify({ 'w-code': '{{{ not json' }));
    (window as any).engramDesktop = fakeDesktopApi();
    await openCodeChannel();
    expect(document.querySelector('.dockPanel')).toBeNull();
    expect(toolIcons()).toHaveLength(3);
  });
});

describe('자유 분할', () => {
  it('분할하면 두 칸이 동시에 렌더된다', async () => {
    (window as any).engramDesktop = fakeDesktopApi();
    await openCodeChannel();
    fireEvent.click(toolIcons()[0]); // 터미널
    await waitFor(() => expect(panes()).toHaveLength(1));
    fireEvent.click(toolIcons()[1]); // 브라우저 → 분할
    await waitFor(() => expect(panes()).toHaveLength(2));
    expect(document.querySelector('.codeTerm')).toBeInTheDocument();
    expect(document.querySelector('.dockBrowser')).toBeInTheDocument();
    expect(document.querySelector('.dockSplit')).toBeInTheDocument();
  });

  it('세 칸 이상도 만들어진다(중첩 분할)', async () => {
    (window as any).engramDesktop = fakeDesktopApi();
    await openCodeChannel();
    fireEvent.click(toolIcons()[0]);
    await waitFor(() => expect(panes()).toHaveLength(1));
    fireEvent.click(toolIcons()[1]);
    await waitFor(() => expect(panes()).toHaveLength(2));
    fireEvent.click(toolIcons()[2]);
    await waitFor(() => expect(panes()).toHaveLength(3));
  });
});

describe('★ 터미널 세션 정리 규칙(기존 불변식)', () => {
  it('패널을 접어도(⇥) 세션은 죽지 않는다', async () => {
    const api = fakeDesktopApi();
    (window as any).engramDesktop = api;
    await openCodeChannel();
    fireEvent.click(toolIcons()[0]);
    await waitFor(() => expect(api.ptyStart).toHaveBeenCalled());
    const rail = railBtns();
    fireEvent.click(rail[rail.length - 1]); // ⇥ 접기
    expect(document.querySelector('.dockPanel')).toBeNull();
    expect(api.ptyKillKey).not.toHaveBeenCalled();
    expect(api.ptyKill).not.toHaveBeenCalled();
    expect(localStorage.getItem('engram.dock.layout')).not.toContain('w-code');
  });

  it('칸을 닫으면(✕) 그 칸의 터미널 세션을 키로 죽인다', async () => {
    const api = fakeDesktopApi();
    (window as any).engramDesktop = api;
    await openCodeChannel();
    fireEvent.click(toolIcons()[0]);
    await waitFor(() => expect(api.ptyStart).toHaveBeenCalled());
    const key = api.ptyStart.mock.calls[0][0];
    fireEvent.click(glyph('✕', tabsOf()));
    await waitFor(() => expect(api.ptyKillKey).toHaveBeenCalledWith(key));
  });

  it('탭을 닫으면 그 탭의 세션만 죽는다(칸은 살아있다)', async () => {
    const api = fakeDesktopApi();
    (window as any).engramDesktop = api;
    await openCodeChannel();
    fireEvent.click(toolIcons()[0]);
    await waitFor(() => expect(tabsOf()).toBeTruthy());
    fireEvent.click(glyph('＋', tabsOf())); // 터미널 탭 하나 더
    await waitFor(() => expect(document.querySelectorAll('.dockTab')).toHaveLength(2));
    const tabs = document.querySelectorAll('.dockTab');
    fireEvent.click(tabs[1].querySelector('.x') as HTMLElement);
    await waitFor(() => expect(api.ptyKillKey).toHaveBeenCalledTimes(1));
    expect(document.querySelectorAll('.dockTab')).toHaveLength(1);
    expect(document.querySelector('.dockPanel')).toBeInTheDocument();
  });

  it('다른 모드(chat)로 옮기면 독이 사라지되 세션은 죽지 않는다', async () => {
    const api = fakeDesktopApi();
    (window as any).engramDesktop = api;
    await openCodeChannel([{ id: 'g1', name: 'general', respondMode: 'all', mode: 'chat' }, ...CHANNELS]);
    fireEvent.click(toolIcons()[0]);
    await waitFor(() => expect(api.ptyStart).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Chat'));
    await waitFor(() => expect(screen.getByText('# general')).toBeInTheDocument());
    expect(document.querySelector('.dockPanel')).toBeNull();
    expect(document.querySelector('.codeMainRow')).toBeNull();
    expect(api.ptyKillKey).not.toHaveBeenCalled();
  });
});

describe('브라우저 칸', () => {
  async function openBrowser() {
    (window as any).engramDesktop = (window as any).engramDesktop ?? fakeDesktopApi();
    await openCodeChannel();
    fireEvent.click(toolIcons()[1]);
    return waitFor(() => document.querySelector('.dockAddr') as HTMLInputElement);
  }

  it('주소를 입력하면 그 주소의 webview가 뜬다(localhost는 확인 없이)', async () => {
    const addr = await openBrowser();
    fireEvent.change(addr, { target: { value: 'localhost:5173' } });
    fireEvent.keyDown(addr, { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('webview')).toBeInTheDocument());
    expect(document.querySelector('webview')?.getAttribute('src')).toBe('http://localhost:5173');
  });

  it('외부 사이트는 확인을 거치고, "항상 허용"은 기억된다', async () => {
    const addr = await openBrowser();
    fireEvent.change(addr, { target: { value: 'example.com' } });
    fireEvent.keyDown(addr, { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('.dockBar.confirm')).toBeInTheDocument());
    expect(document.querySelector('webview')).toBeNull(); // 확인 전엔 안 연다
    fireEvent.click(document.querySelectorAll('.dockBar.confirm button')[1]); // 항상 허용
    await waitFor(() => expect(document.querySelector('webview')).toBeInTheDocument());
    expect(localStorage.getItem('engram.dock.allowedSites')).toContain('example.com');
  });

  it('알아들을 수 없는 주소는 안내를 띄운다(무반응 금지)', async () => {
    const addr = await openBrowser();
    fireEvent.change(addr, { target: { value: 'javascript:alert(1)' } });
    fireEvent.keyDown(addr, { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('.dockBar.warn')).toBeInTheDocument());
    expect(document.querySelector('webview')).toBeNull();
  });

  it('webview는 앱과 분리된 파티션 + 안전 설정으로 뜨고 allowpopups가 없다', async () => {
    const addr = await openBrowser();
    fireEvent.change(addr, { target: { value: 'localhost:5173' } });
    fireEvent.keyDown(addr, { key: 'Enter' });
    const view = await waitFor(() => document.querySelector('webview') as HTMLElement);
    expect(view.getAttribute('partition')).toBe('engram-preview'); // 기본 = 세션 유지 안 함(비영속)
    expect(view.getAttribute('webpreferences')).toBe('contextIsolation=yes,nodeIntegration=no,sandbox=yes');
    expect(view.hasAttribute('allowpopups')).toBe(false);
  });

  it('탭을 늘려도 먼저 열린 webview는 떼지 않는다(뒤로/앞으로 기록 보존)', async () => {
    const addr = await openBrowser();
    fireEvent.change(addr, { target: { value: 'localhost:5173' } });
    fireEvent.keyDown(addr, { key: 'Enter' });
    await waitFor(() => expect(document.querySelectorAll('webview')).toHaveLength(1));
    fireEvent.click(glyph('＋', tabsOf()));
    await waitFor(() => expect(document.querySelectorAll('.dockTab')).toHaveLength(2));
    expect(document.querySelectorAll('webview')).toHaveLength(1);
    expect(document.querySelector('webview')?.classList.contains('active')).toBe(false);
  });

  it('세션 유지를 켜면 파티션이 persist:로 바뀐다(기본은 비영속)', async () => {
    const addr = await openBrowser();
    fireEvent.change(addr, { target: { value: 'localhost:5173' } });
    fireEvent.keyDown(addr, { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('webview')).toBeInTheDocument());
    fireEvent.click(glyph('⋮', tabsOf()));
    const menu = await waitFor(() => document.querySelector('.dockMenu') as HTMLElement);
    const rows = Array.from(menu.querySelectorAll('.dockMenuItem'));
    fireEvent.click(rows[rows.length - 1]); // 세션 유지 토글
    await waitFor(() => expect(document.querySelector('webview')?.getAttribute('partition')).toBe('persist:engram-preview'));
  });
});

describe('HTML 크게 보기 — 브라우저 칸의 새 탭으로', () => {
  it('메시지 카드의 ⤢를 누르면 브라우저 칸이 열리고 그 HTML 탭이 생긴다', async () => {
    (window as any).engramDesktop = fakeDesktopApi();
    await openCodeChannel();
    act(() => {
      FakeWS.last.onmessage!({ data: JSON.stringify({
        t: 'msg', channelId: 'w-code',
        message: { id: 'm1', authorId: 'engram', text: '```html\n<h1>hi</h1>\n```', ts: '2026-01-01T00:00:00Z' },
      }) });
    });
    const expand = await waitFor(() => document.querySelector('.htmlCardExpand') as HTMLElement);
    fireEvent.click(expand);
    await waitFor(() => expect(document.querySelector('.dockBrowser')).toBeInTheDocument());
    const src = (document.querySelector('webview') as HTMLElement).getAttribute('src') ?? '';
    expect(src).toContain('data:text/html');
    expect(src).toContain(encodeURIComponent('<h1>hi</h1>'));
    // data: 탭은 저장하지 않는다(localStorage를 통째로 날릴 수 있다).
    expect(localStorage.getItem('engram.dock.layout') ?? '').not.toContain('data:text/html');
  });
});

describe('서버 메뉴 — 기존 pty-manager 재사용', () => {
  it('서버를 추가하고 ▶를 누르면 터미널 탭이 생기고 명령이 실행되며 그 주소로 이동한다', async () => {
    const api = fakeDesktopApi();
    (window as any).engramDesktop = api;
    await openCodeChannel();
    fireEvent.click(toolIcons()[1]); // 브라우저 칸
    await waitFor(() => expect(document.querySelector('.dockBrowser')).toBeInTheDocument());
    fireEvent.click(glyph('▤', tabsOf()));
    await waitFor(() => expect(document.querySelector('.dockMenu')).toBeInTheDocument());
    fireEvent.click(document.querySelector('.dockMenu .dockMenuItem.clickable') as HTMLElement); // 서버 추가
    const inputs = await waitFor(() => document.querySelectorAll('.dockMenuForm input'));
    fireEvent.change(inputs[0], { target: { value: 'renderer' } });
    fireEvent.change(inputs[1], { target: { value: '5173' } });
    fireEvent.change(inputs[2], { target: { value: 'npm run dev' } });
    fireEvent.click(document.querySelector('.dockMenuForm button') as HTMLElement);
    fireEvent.click(await waitFor(() => document.querySelector('.dockMenuPlay') as HTMLElement));

    // 터미널 칸이 생기고 그 세션에 명령이 들어간다(created=true일 때만).
    await waitFor(() => expect(api.ptyStart).toHaveBeenCalled());
    const key = api.ptyStart.mock.calls[0][0];
    await waitFor(() => expect(api.ptyWrite).toHaveBeenCalledWith('sid-' + key, 'npm run dev\r'));
    // 브라우저 칸은 그 주소로 이동한다.
    await waitFor(() => expect(document.querySelector('webview')?.getAttribute('src')).toBe('http://localhost:5173'));
  });
});
