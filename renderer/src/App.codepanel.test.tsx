import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import App from './App';

// CodePanel.test.tsx와 동일한 이유로 xterm은 모킹(jsdom엔 canvas가 없다) — App 레벨 테스트는 게이트·
// localStorage 퍼시스트·ptyStart 배선 자체만 확인하면 되고 xterm 렌더 디테일은 CodePanel.test.tsx가 커버.
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

function fakePtyApi() {
  return {
    ptyStart: vi.fn(async (_channelId: string, _cwd: string) => ({ sid: 'sid-1', shell: 'PowerShell' })),
    ptyWrite: vi.fn(async () => {}),
    ptyResize: vi.fn(async () => {}),
    ptyKill: vi.fn(async () => {}),
    ptyReplay: vi.fn(async () => ''),
    onPtyData: vi.fn(() => vi.fn()),
    onPtyExit: vi.fn(() => vi.fn()),
    gitDiffStatus: vi.fn(async () => ({ ok: true as const, files: [] })),
    gitDiffFile: vi.fn(async () => ({ ok: true as const, diff: '' })),
  };
}

// 코드 채널(repoPath 바인딩됨) 하나를 만들고 Code 탭으로 전환한 뒤 #chhdr가 뜰 때까지 기다린다.
async function openCodeChannel() {
  render(<App />);
  act(() => { FakeWS.last.onopen!(); });
  act(() => {
    FakeWS.last.onmessage!({ data: JSON.stringify({
      t: 'channels', list: [{ id: 'w-code', name: 'proj', respondMode: 'all', mode: 'code', repoPath: 'C:/repo/proj' }],
    }) });
  });
  fireEvent.click(screen.getByText('Code'));
  await waitFor(() => expect(screen.getByTitle('C:/repo/proj')).toBeInTheDocument());
  return FakeWS.last;
}

describe('코드 패널 아이콘 게이트', () => {
  it('비데스크톱(window.engramDesktop 없음)에서는 아이콘이 안 뜬다', async () => {
    await openCodeChannel();
    expect(document.querySelector('.chhdrIcons')).toBeNull();
  });

  it('chat 모드에서는 아이콘이 안 뜬다(코드 채널이 아니어도 chhdr 자체가 없음)', async () => {
    (window as any).engramDesktop = fakePtyApi();
    render(<App />);
    act(() => { FakeWS.last.onopen!(); });
    act(() => {
      FakeWS.last.onmessage!({ data: JSON.stringify({ t: 'channels', list: [{ id: 'g1', name: 'general', respondMode: 'all', mode: 'chat' }] }) });
    });
    await waitFor(() => expect(screen.getByText('# general')).toBeInTheDocument());
    expect(document.querySelector('.chhdrIcons')).toBeNull();
    expect(document.getElementById('chhdr')).toBeNull();
  });

  it('repoPath 미바인딩 코드 채널(FolderEmpty)에서는 아이콘이 안 뜬다', async () => {
    (window as any).engramDesktop = fakePtyApi();
    render(<App />);
    act(() => { FakeWS.last.onopen!(); });
    act(() => {
      FakeWS.last.onmessage!({ data: JSON.stringify({ t: 'channels', list: [{ id: 'w-code', name: 'proj', respondMode: 'all', mode: 'code' }] }) });
    });
    fireEvent.click(screen.getByText('Code'));
    await waitFor(() => expect(screen.getByText(/폴더 선택|Choose folder/)).toBeInTheDocument());
    expect(document.querySelector('.chhdrIcons')).toBeNull();
  });

  it('데스크톱+repoPath 바인딩된 코드 채널에서는 아이콘 3개가 뜬다', async () => {
    (window as any).engramDesktop = fakePtyApi();
    await openCodeChannel();
    expect(document.querySelectorAll('.chhdrIcons .codeIconBtn')).toHaveLength(3);
  });
});

describe('코드 패널 열기/닫기 배선', () => {
  it('아이콘 클릭 시 패널이 열리고 ptyStart(channelId, repoPath)가 호출된다', async () => {
    const api = fakePtyApi();
    (window as any).engramDesktop = api;
    await openCodeChannel();
    const [termIcon] = document.querySelectorAll('.chhdrIcons .codeIconBtn');
    fireEvent.click(termIcon);
    expect(document.querySelector('.codePanel')).toBeInTheDocument();
    await waitFor(() => expect(api.ptyStart).toHaveBeenCalledWith('w-code', 'C:/repo/proj'));
  });

  it('열림 상태는 채널별로 localStorage에 퍼시스트되고, 재마운트해도 복원된다', async () => {
    (window as any).engramDesktop = fakePtyApi();
    const first = render(<App />);
    act(() => { FakeWS.last.onopen!(); });
    act(() => {
      FakeWS.last.onmessage!({ data: JSON.stringify({
        t: 'channels', list: [{ id: 'w-code', name: 'proj', respondMode: 'all', mode: 'code', repoPath: 'C:/repo/proj' }],
      }) });
    });
    fireEvent.click(screen.getByText('Code'));
    await waitFor(() => expect(screen.getByTitle('C:/repo/proj')).toBeInTheDocument());
    const icons = document.querySelectorAll('.chhdrIcons .codeIconBtn');
    fireEvent.click(icons[2]); // diff 아이콘
    await waitFor(() => expect(document.querySelector('.codePanel')).toBeInTheDocument());
    expect(localStorage.getItem('engram.codePanel.open')).toContain('"w-code":"diff"');
    first.unmount();

    render(<App />);
    act(() => { FakeWS.last.onopen!(); });
    act(() => {
      FakeWS.last.onmessage!({ data: JSON.stringify({
        t: 'channels', list: [{ id: 'w-code', name: 'proj', respondMode: 'all', mode: 'code', repoPath: 'C:/repo/proj' }],
      }) });
    });
    fireEvent.click(screen.getByText('Code'));
    await waitFor(() => expect(document.querySelector('.codePanel')).toBeInTheDocument());
    expect(screen.getByText(/Diff · 0/)).toBeInTheDocument();
  });

  it('탭 행의 닫기(×) 클릭 시 패널이 사라지고 세션은 kill되지 않는다(퍼시스트도 닫힘으로)', async () => {
    const api = fakePtyApi();
    (window as any).engramDesktop = api;
    await openCodeChannel();
    fireEvent.click(document.querySelectorAll('.chhdrIcons .codeIconBtn')[0]);
    await waitFor(() => expect(document.querySelector('.codePanel')).toBeInTheDocument());
    fireEvent.click(document.querySelector('.codeTabClose') as HTMLElement);
    expect(document.querySelector('.codePanel')).toBeNull();
    expect(api.ptyKill).not.toHaveBeenCalled();
    expect(localStorage.getItem('engram.codePanel.open')).not.toContain('w-code');
  });

  it('다른 모드(chat)로 전환하면 패널은 렌더되지 않는다(다른 화면 회귀 없음)', async () => {
    (window as any).engramDesktop = fakePtyApi();
    render(<App />);
    act(() => { FakeWS.last.onopen!(); });
    act(() => {
      FakeWS.last.onmessage!({ data: JSON.stringify({
        t: 'channels', list: [
          { id: 'g1', name: 'general', respondMode: 'all', mode: 'chat' },
          { id: 'w-code', name: 'proj', respondMode: 'all', mode: 'code', repoPath: 'C:/repo/proj' },
        ],
      }) });
    });
    fireEvent.click(screen.getByText('Code'));
    await waitFor(() => expect(screen.getByTitle('C:/repo/proj')).toBeInTheDocument());
    fireEvent.click(document.querySelectorAll('.chhdrIcons .codeIconBtn')[0]);
    await waitFor(() => expect(document.querySelector('.codePanel')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Chat'));
    await waitFor(() => expect(screen.getByText('# general')).toBeInTheDocument());
    expect(document.querySelector('.codePanel')).toBeNull();
    expect(document.querySelector('.codeMainRow')).toBeNull();
  });
});
