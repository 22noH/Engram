import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { CodePanel, CodePanelIcons, loadCodeTab, saveCodeTab } from './CodePanel';
import { T } from '../i18n';

// jsdom엔 canvas 컨텍스트가 없어 xterm 실인스턴스를 만들 수 없다 — 브리프 지시대로 배선(구독/해제/
// write 호출)만 모킹으로 검증한다. dynamic import(loadXterm)도 vi.mock이 그대로 가로챈다.
let lastTerm: FakeTerminal | undefined;
// I2(리뷰) — "xterm 동적 import 실패" 시나리오용 스위치. import('@xterm/xterm') 결과에서
// Terminal을 구조분해할 때 getter가 던지게 해 실제 청크 로드 실패를 흉내낸다(CodePanel.tsx의
// loadXterm()이 그대로 reject를 전파 → try/catch로 떨어진다).
let failXtermImport = false;
class FakeTerminal {
  options: any;
  cols = 80; rows = 24;
  written: string[] = [];
  private dataCb: ((d: string) => void) | null = null;
  constructor(opts: any) { this.options = opts; lastTerm = this; }
  open() { /* DOM 마운트 — jsdom엔 실렌더 불필요 */ }
  loadAddon() {}
  write(d: string) { this.written.push(d); }
  writeln(d: string) { this.written.push(d + '\n'); }
  onData(cb: (d: string) => void) { this.dataCb = cb; return { dispose: vi.fn() }; }
  emit(d: string) { this.dataCb?.(d); }
  dispose() {}
}
vi.mock('@xterm/xterm', () => ({
  get Terminal() {
    if (failXtermImport) throw new Error('chunk load failed');
    return FakeTerminal;
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    ptyStart: vi.fn(async (_c: string, _cwd: string) => ({ sid: 'sid-1', shell: 'PowerShell' })),
    ptyWrite: vi.fn(async () => {}),
    ptyResize: vi.fn(async () => {}),
    ptyKill: vi.fn(async () => {}),
    ptyReplay: vi.fn(async () => 'replayed-buffer'),
    onPtyData: vi.fn(() => vi.fn()),
    onPtyExit: vi.fn(() => vi.fn()),
    gitDiffStatus: vi.fn(async () => ({ ok: true as const, files: [] as { path: string; status: 'A' | 'M' | 'D' | 'R' | '?' }[] })),
    gitDiffFile: vi.fn(async () => ({ ok: true as const, diff: '' })),
    ...overrides,
  };
}

beforeEach(() => { localStorage.clear(); lastTerm = undefined; failXtermImport = false; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (window as any).engramDesktop; });

describe('CodePanelIcons', () => {
  it('3개 렌더, 활성 탭에만 active 클래스, 클릭 시 onSelect(tab)', () => {
    const onSelect = vi.fn();
    render(<CodePanelIcons activeTab="preview" onSelect={onSelect} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(3);
    expect(buttons[1].className).toContain('active');
    expect(buttons[0].className).not.toContain('active');
    fireEvent.click(buttons[0]);
    expect(onSelect).toHaveBeenCalledWith('terminal');
    fireEvent.click(buttons[2]);
    expect(onSelect).toHaveBeenCalledWith('diff');
  });

  it('activeTab=null이면 아무 아이콘도 active가 아니다', () => {
    render(<CodePanelIcons activeTab={null} onSelect={() => {}} />);
    for (const b of screen.getAllByRole('button')) expect(b.className).not.toContain('active');
  });
});

describe('loadCodeTab/saveCodeTab(채널별 localStorage 퍼시스트)', () => {
  it('저장 전엔 null, 저장 후 그 채널만 읽힌다', () => {
    expect(loadCodeTab('c1')).toBeNull();
    saveCodeTab('c1', 'diff');
    expect(loadCodeTab('c1')).toBe('diff');
    expect(loadCodeTab('c2')).toBeNull();
  });
  it('null로 저장하면 그 채널 항목이 지워진다', () => {
    saveCodeTab('c1', 'terminal');
    saveCodeTab('c1', null);
    expect(loadCodeTab('c1')).toBeNull();
  });
});

describe('CodePanel — 터미널 탭 배선', () => {
  it('ptyStart(channelId, repoPath) 호출 → 리플레이가 먼저 쓰이고 그 다음 onPtyData 구독', async () => {
    const order: string[] = [];
    const api = fakeApi({
      ptyStart: vi.fn(async () => { order.push('start'); return { sid: 'sid-1', shell: 'PowerShell' }; }),
      ptyReplay: vi.fn(async () => { order.push('replay'); return 'replayed-buffer'; }),
      onPtyData: vi.fn((_cb: any) => { order.push('subscribe'); return vi.fn(); }),
    });
    (window as any).engramDesktop = api;
    render(<CodePanel channelId="ch1" repoPath="/repo" tab="terminal" onChangeTab={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(api.ptyStart).toHaveBeenCalledWith('ch1', '/repo'));
    await waitFor(() => expect(order).toEqual(['start', 'replay', 'subscribe']));
    await waitFor(() => expect(lastTerm?.written).toContain('replayed-buffer'));
  });

  it('탭 라벨이 ptyStart가 돌려준 shell 이름으로 바뀐다', async () => {
    const api = fakeApi();
    (window as any).engramDesktop = api;
    render(<CodePanel channelId="ch1" repoPath="/repo" tab="terminal" onChangeTab={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('PowerShell')).toBeInTheDocument());
  });

  it('키 입력(onData) → ptyWrite(sid, data)로 전달된다', async () => {
    const api = fakeApi();
    (window as any).engramDesktop = api;
    render(<CodePanel channelId="ch1" repoPath="/repo" tab="terminal" onChangeTab={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(lastTerm).toBeDefined());
    act(() => { lastTerm!.emit('ls\r'); });
    await waitFor(() => expect(api.ptyWrite).toHaveBeenCalledWith('sid-1', 'ls\r'));
  });

  it('언마운트 시 구독은 해제되지만 ptyKill은 호출되지 않는다(세션 유지)', async () => {
    const unsubData = vi.fn();
    const unsubExit = vi.fn();
    const api = fakeApi({
      onPtyData: vi.fn(() => unsubData),
      onPtyExit: vi.fn(() => unsubExit),
    });
    (window as any).engramDesktop = api;
    const { unmount } = render(<CodePanel channelId="ch1" repoPath="/repo" tab="terminal" onChangeTab={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(api.onPtyData).toHaveBeenCalled());
    unmount();
    expect(unsubData).toHaveBeenCalled();
    expect(unsubExit).toHaveBeenCalled();
    expect(api.ptyKill).not.toHaveBeenCalled();
  });

  it('exit 이벤트 수신 시 세션 종료 안내+재시작 버튼을 보여준다', async () => {
    let exitCb: ((sid: string, code: number) => void) | undefined;
    const api = fakeApi({ onPtyExit: vi.fn((cb: any) => { exitCb = cb; return vi.fn(); }) });
    (window as any).engramDesktop = api;
    render(<CodePanel channelId="ch1" repoPath="/repo" tab="terminal" onChangeTab={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(exitCb).toBeDefined());
    act(() => exitCb!('sid-1', 0));
    expect(await screen.findByText(T.codeSessionEnded)).toBeInTheDocument();
    expect(screen.getByText(T.codeRestart)).toBeInTheDocument();
  });

  it('I2 — xterm 동적 import 실패 시 조용히 삼키지 않고 안내+재시작 버튼을 보여준다', async () => {
    failXtermImport = true;
    const api = fakeApi();
    (window as any).engramDesktop = api;
    render(<CodePanel channelId="ch1" repoPath="/repo" tab="terminal" onChangeTab={() => {}} onClose={() => {}} />);
    expect(await screen.findByText((content) => content.includes(T.codeTermLoadFailed))).toBeInTheDocument();
    expect(screen.getByText(T.codeRestart)).toBeInTheDocument();
    // ptyStart까지 도달하지 않고(로드 단계에서 실패) 조용히 삼켜지지 않았음을 재확인.
    expect(api.ptyStart).not.toHaveBeenCalled();
  });
});

describe('CodePanel — 프리뷰 탭', () => {
  it('http(s) 아닌 URL은 거부하고 iframe을 만들지 않는다', () => {
    render(<CodePanel channelId="ch1" repoPath="/repo" tab="preview" onChangeTab={() => {}} onClose={() => {}} />);
    const input = screen.getByPlaceholderText('http://localhost:5173');
    fireEvent.change(input, { target: { value: 'file:///etc/passwd' } });
    fireEvent.click(screen.getByText(T.codePreviewGo));
    expect(screen.getByText(T.codePreviewInvalidUrl)).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('http(s) URL은 sandbox 속성이 붙은 iframe으로 로드된다', () => {
    render(<CodePanel channelId="ch1" repoPath="/repo" tab="preview" onChangeTab={() => {}} onClose={() => {}} />);
    const input = screen.getByPlaceholderText('http://localhost:5173');
    fireEvent.change(input, { target: { value: 'http://localhost:5173' } });
    fireEvent.click(screen.getByText(T.codePreviewGo));
    const iframe = document.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toBe('http://localhost:5173');
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
  });

  it('새로고침 버튼은 iframe을 리마운트(key 변경)한다', () => {
    render(<CodePanel channelId="ch1" repoPath="/repo" tab="preview" onChangeTab={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('http://localhost:5173'), { target: { value: 'http://localhost:5173' } });
    fireEvent.click(screen.getByText(T.codePreviewGo));
    const before = document.querySelector('iframe');
    fireEvent.click(screen.getByTitle(T.codeRefresh));
    const after = document.querySelector('iframe');
    expect(before).not.toBe(after);
  });
});

describe('CodePanel — Diff 탭', () => {
  it('gitDiffStatus 결과로 파일 목록(상태+경로)과 배지 수를 렌더한다', async () => {
    const api = fakeApi({
      gitDiffStatus: vi.fn(async () => ({ ok: true as const, files: [{ path: 'a.ts', status: 'M' as const }, { path: 'b.ts', status: 'A' as const }] })),
    });
    (window as any).engramDesktop = api;
    render(<CodePanel channelId="ch1" repoPath="/repo" tab="diff" onChangeTab={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());
    expect(screen.getByText('b.ts')).toBeInTheDocument();
    expect(screen.getByText(/Diff · 2/)).toBeInTheDocument();
  });

  it('파일 클릭 → gitDiffFile(repoPath, path) → 결과가 읽기 전용 pre로 렌더된다', async () => {
    const api = fakeApi({
      gitDiffStatus: vi.fn(async () => ({ ok: true as const, files: [{ path: 'a.ts', status: 'M' as const }] })),
      gitDiffFile: vi.fn(async () => ({ ok: true as const, diff: '+added line\n-removed line' })),
    });
    (window as any).engramDesktop = api;
    render(<CodePanel channelId="ch1" repoPath="/repo" tab="diff" onChangeTab={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());
    fireEvent.click(screen.getByText('a.ts'));
    await waitFor(() => expect(api.gitDiffFile).toHaveBeenCalledWith('/repo', 'a.ts'));
    expect(await screen.findByText('+added line')).toBeInTheDocument();
    expect(screen.getByText('-removed line')).toBeInTheDocument();
    expect(document.querySelector('pre.codeDiffPre')).toBeInTheDocument();
  });

  it('not-repo 결과는 안내 문구를 보여준다', async () => {
    const api = fakeApi({ gitDiffStatus: vi.fn(async () => ({ ok: false as const, reason: 'not-repo' as const })) });
    (window as any).engramDesktop = api;
    render(<CodePanel channelId="ch1" repoPath="/repo" tab="diff" onChangeTab={() => {}} onClose={() => {}} />);
    expect(await screen.findByText(T.codeDiffNotRepo)).toBeInTheDocument();
  });

  it('배지 수는 다른 탭으로 전환해도 유지된다', async () => {
    const api = fakeApi({
      gitDiffStatus: vi.fn(async () => ({ ok: true as const, files: [{ path: 'a.ts', status: 'M' as const }] })),
    });
    (window as any).engramDesktop = api;
    const { rerender } = render(<CodePanel channelId="ch1" repoPath="/repo" tab="diff" onChangeTab={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Diff · 1/)).toBeInTheDocument());
    rerender(<CodePanel channelId="ch1" repoPath="/repo" tab="preview" onChangeTab={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/Diff · 1/)).toBeInTheDocument();
  });
});

describe('CodePanel — 스플리터·닫기', () => {
  it('스플리터를 드래그하면 폭이 바뀌고 마우스업 시 localStorage에 퍼시스트된다', () => {
    render(<CodePanel channelId="ch1" repoPath="/repo" tab="preview" onChangeTab={() => {}} onClose={() => {}} />);
    const panel = document.querySelector('.codePanel') as HTMLElement;
    const splitter = document.querySelector('.codeSplitter') as HTMLElement;
    const before = panel.style.width;
    fireEvent.mouseDown(splitter, { clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 400 }); // 왼쪽으로 100 이동 = 폭 +100(패널이 우측에 있으므로)
    fireEvent.mouseUp(document);
    expect(panel.style.width).not.toBe(before);
    expect(localStorage.getItem('engram.codePanel.width')).toBeTruthy();
  });

  it('I1 — 드래그 도중 언마운트되면 document의 mousemove/mouseup 리스너가 정리된다(누수 방지)', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = render(<CodePanel channelId="ch1" repoPath="/repo" tab="preview" onChangeTab={() => {}} onClose={() => {}} />);
    const splitter = document.querySelector('.codeSplitter') as HTMLElement;
    fireEvent.mouseDown(splitter, { clientX: 500 }); // mouseup 전에 언마운트 — up()이 절대 안 불리는 경로
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('mouseup', expect.any(Function));
    // 정리된 뒤엔 낡은 클로저가 더 이상 반응하지 않아야 한다(에러 없이 조용히 무시).
    expect(() => fireEvent.mouseMove(document, { clientX: 100 })).not.toThrow();
  });

  it('닫기(×) 클릭 시 onClose가 호출된다', () => {
    const onClose = vi.fn();
    render(<CodePanel channelId="ch1" repoPath="/repo" tab="preview" onChangeTab={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByTitle(T.codePanelClose));
    expect(onClose).toHaveBeenCalled();
  });

  it('탭 클릭 시 onChangeTab(tab)이 호출된다', () => {
    const onChangeTab = vi.fn();
    render(<CodePanel channelId="ch1" repoPath="/repo" tab="terminal" onChangeTab={onChangeTab} onClose={() => {}} />);
    fireEvent.click(screen.getByText(T.codePreviewTab));
    expect(onChangeTab).toHaveBeenCalledWith('preview');
  });
});
