import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import App from './App';
import { T } from './i18n';

// 입력바 2줄 개편(목업 승인) — 1행 textarea+↵힌트 / 2행 왼쪽[자동▾·＋·🎤] 오른쪽[연결·모델·노력·보내기].
// 배지는 전부 실제 동작해야 한다(setRespondMode / setChannelBrain / setChannelEffort).

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

const CHAT = { id: 'g1', name: 'general', respondMode: 'all', mode: 'chat' };
const CODE = { id: 'w-code', name: 'proj', respondMode: 'all', mode: 'code', repoPath: 'C:/repo/proj' };

function frames(ws: FakeWS): any[] { return ws.sent.map((s) => JSON.parse(s)); }

async function openApp(list: unknown[], opts: { code?: boolean; remote?: boolean; defaultPermMode?: string } = {}) {
  if (opts.remote) {
    localStorage.setItem('engram.connections', JSON.stringify({
      connections: [{ id: 'r1', name: 'Team Server', endpoint: 'ws://10.0.0.5:47800' }], defaultConnId: 'r1',
    }));
  }
  render(<App />);
  act(() => { FakeWS.last.onopen!(); });
  act(() => {
    FakeWS.last.onmessage!({ data: JSON.stringify({
      t: 'channels', list, brainNames: ['claude', 'codex'], defaultBrain: 'claude',
      // 서버가 전역 기본 권한 모드를 알려줄 때만 실린다(미주입=필드 없음 — 구식 서버·brain 모드).
      ...(opts.defaultPermMode ? { defaultPermMode: opts.defaultPermMode } : {}),
    }) });
  });
  if (opts.code) {
    fireEvent.click(screen.getByText('Code'));
    await waitFor(() => expect(screen.getByTitle('C:/repo/proj')).toBeInTheDocument());
  } else {
    await waitFor(() => expect(screen.getByText('# general')).toBeInTheDocument());
  }
  const ws = FakeWS.last;
  ws.sent = [];
  return ws;
}

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;

describe('A. 입력바 2줄 배치', () => {
  it('1행=textarea+↵ 힌트, 2행=도구 줄로 나뉜다', async () => {
    await openApp([CHAT]);
    const bar = document.getElementById('inputbar') as HTMLElement;
    expect(bar.querySelector('.composerRow #input')).toBeInTheDocument();
    expect(bar.querySelector('.composerRow .enterHint')?.textContent).toBe('↵');
    expect(bar.querySelector('.composerTools .composerLeft')).toBeInTheDocument();
    expect(bar.querySelector('.composerTools .composerRight')).toBeInTheDocument();
  });

  it('2행 왼쪽은 응답모드·첨부·마이크, 오른쪽은 연결·모델·보내기 순이다', async () => {
    (window as any).engramDesktop = { sttAvailable: vi.fn(async () => ({ model: 'b', ready: true, loading: false })) };
    await openApp([CHAT]);
    const left = q('.composerLeft')!;
    expect(left.querySelector('.respondBadge')).toBeInTheDocument();
    expect(left.querySelector('.attachBtn')).toBeInTheDocument();
    expect(left.querySelector('.micBtn')).toBeInTheDocument();
    const right = q('.composerRight')!;
    expect(right.querySelector('#engramSelector')).toBeInTheDocument();
    expect(right.querySelector('.modelBadge')).toBeInTheDocument();
    expect(right.lastElementChild?.textContent).toBe(T.send); // 보내기가 줄 맨 오른쪽
  });

  it('기존 입력 동작(Enter 전송·Shift+Enter 줄바꿈·오토사이즈)은 그대로다', async () => {
    const ws = await openApp([CHAT]);
    const i = document.getElementById('input') as HTMLTextAreaElement;
    expect(i.tagName).toBe('TEXTAREA');
    act(() => { fireEvent.change(i, { target: { value: '안녕' } }); });
    act(() => { fireEvent.keyDown(i, { key: 'Enter' }); });
    await waitFor(() => expect(frames(ws).some((f) => f.t === 'send' && f.text === '안녕')).toBe(true));
  });

  it('생성 중엔 보내기가 중지 버튼으로 바뀐다(기존 동작 유지)', async () => {
    await openApp([CHAT]);
    const i = document.getElementById('input') as HTMLTextAreaElement;
    act(() => { fireEvent.change(i, { target: { value: '질문' } }); });
    act(() => { fireEvent.keyDown(i, { key: 'Enter' }); });
    await waitFor(() => expect(screen.getByRole('button', { name: `■ ${T.stopGen}` })).toBeInTheDocument());
    expect(q('.composerRight .stopBtn')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: T.send })).toBeNull();
  });

  it('마이크는 데스크톱이 아니면 안 보인다', async () => {
    await openApp([CHAT]);
    expect(q('.composerLeft .micBtn')).toBeNull();
  });
});

describe('B1. 응답 모드 배지(자동 ▾)', () => {
  it('respondMode=all이면 "자동" 라벨', async () => {
    await openApp([CHAT]);
    expect(q('.respondBadge')?.textContent).toContain(T.respondAuto);
  });

  it('클릭 → 멘션 전용 선택 시 setRespondMode 프레임을 보낸다', async () => {
    const ws = await openApp([CHAT]);
    act(() => { fireEvent.click(q('.respondBadge')!); });
    act(() => { fireEvent.click(screen.getByText(T.modeMention)); });
    await waitFor(() => expect(frames(ws).some((f) => f.t === 'setRespondMode' && f.id === 'g1' && f.mode === 'mention')).toBe(true));
  });

  it('respondMode=mention이면 "@멘션" 라벨', async () => {
    await openApp([{ ...CHAT, respondMode: 'mention' }]);
    expect(q('.respondBadge')?.textContent).toContain(T.respondMention);
  });
});

describe('B2. 모델 배지', () => {
  it('채널 두뇌 미설정이면 기본 두뇌 이름을 보여준다', async () => {
    await openApp([CHAT]);
    expect(q('.modelBadge')?.textContent).toContain('claude');
  });

  it('클릭 → 두뇌 선택 시 setChannelBrain 프레임을 보낸다', async () => {
    const ws = await openApp([CHAT]);
    act(() => { fireEvent.click(q('.modelBadge')!); });
    act(() => { fireEvent.click(screen.getByText('codex')); });
    await waitFor(() => expect(frames(ws).some((f) => f.t === 'setChannelBrain' && f.id === 'g1' && f.brain === 'codex')).toBe(true));
  });

  it('기본으로 되돌리면 brain=null을 보낸다', async () => {
    const ws = await openApp([{ ...CHAT, brain: 'codex' }]);
    expect(q('.modelBadge')?.textContent).toContain('codex');
    act(() => { fireEvent.click(q('.modelBadge')!); });
    act(() => { fireEvent.click(screen.getByText(T.brainDefault('claude'))); });
    await waitFor(() => expect(frames(ws).some((f) => f.t === 'setChannelBrain' && f.brain === null)).toBe(true));
  });
});

describe('B3. 노력 배지(코드 채널 전용)', () => {
  it('chat 채널엔 노력 배지가 없다', async () => {
    await openApp([CHAT]);
    expect(q('.effortBadge')).toBeNull();
  });

  it('code 채널엔 있고, 미설정이면 "높음"으로 보인다(백엔드 기본 high)', async () => {
    await openApp([CODE], { code: true });
    expect(q('.effortBadge')?.textContent).toContain(T.effortLevel('high'));
  });

  it('채널에 실린 effort 값을 라벨로 보여준다', async () => {
    await openApp([{ ...CODE, effort: 'xhigh' }], { code: true });
    expect(q('.effortBadge')?.textContent).toContain(T.effortLevel('xhigh'));
  });

  it('슬라이더 팝오버는 좌 "더 빠르게" ↔ 우 "더 스마트하게" 5단계다', async () => {
    await openApp([CODE], { code: true });
    act(() => { fireEvent.click(q('.effortBadge')!); });
    expect(screen.getByText(T.effortFaster)).toBeInTheDocument();
    expect(screen.getByText(T.effortSmarter)).toBeInTheDocument();
    const slider = q('.effortSlider') as HTMLInputElement;
    expect(slider.min).toBe('0');
    expect(slider.max).toBe('4');
    expect(slider.value).toBe('2'); // high = 가운데
  });

  it.each([
    [0, 'low'], [1, 'medium'], [2, 'high'], [3, 'xhigh'], [4, 'max'],
  ])('슬라이더 %i단계 → setChannelEffort effort=%s', async (idx, effort) => {
    // 시작 위치는 목표와 달라야 onChange가 실제로 발화한다(React는 같은 값이면 change를 안 흘린다).
    const ws = await openApp([{ ...CODE, effort: idx === 0 ? 'high' : 'low' }], { code: true });
    act(() => { fireEvent.click(q('.effortBadge')!); });
    act(() => { fireEvent.change(q('.effortSlider')!, { target: { value: String(idx) } }); });
    await waitFor(() => expect(frames(ws).some(
      (f) => f.t === 'setChannelEffort' && f.id === 'w-code' && f.effort === effort,
    )).toBe(true));
  });
});

// 코드 채널 권한 모드(목업 승인) — 코드 채널에서만 왼쪽 배지가 "응답 모드" 대신 "권한 모드"가 된다.
// Chat·Team은 기존 응답 모드 그대로(회귀 0).
describe('B3-2. 권한 모드 배지(코드 채널 전용)', () => {
  it('chat 채널은 기존 응답 모드 배지 그대로 — 권한 모드 배지는 없다', async () => {
    await openApp([CHAT]);
    expect(q('.respondBadge')).toBeInTheDocument();
    expect(q('.permBadge')).toBeNull();
  });

  it('코드 채널은 권한 모드 배지로 바뀐다(응답 모드 배지 없음)', async () => {
    await openApp([CODE], { code: true });
    expect(q('.permBadge')).toBeInTheDocument();
    expect(q('.respondBadge')).toBeNull();
  });

  it('전역값 미주입이면 미설정 채널 라벨은 기존대로 "자동"(회귀 0)', async () => {
    await openApp([CODE], { code: true });
    expect(q('.permBadge')?.textContent).toContain(T.permModeName('auto'));
    act(() => { fireEvent.click(q('.permBadge')!); });
    expect(q('.cbadgeMenu .item.sel .permName')?.textContent).toBe(T.permModeName('auto'));
  });

  // ★라벨↔동작 불일치 방지: 서버는 채널에 permMode가 없으면 전역 설정(permissions.json
  // allow.commandMode)으로 폴백한다. 전역이 제한/파일만인데 배지가 "자동"이라고 우기면
  // 사용자가 자동인 줄 알고 명령을 시켰다 거부당한다 — 그래서 전역값을 그대로 라벨에 쓴다.
  // 서버가 실어주는 값(전역 allowlist→restricted / off→files / auto→auto)은 self.adapter가 매핑한다.
  it.each(['restricted', 'files', 'auto'] as const)('미설정 채널은 전역 기본값(%s) 라벨로 뜬다', async (mode) => {
    await openApp([CODE], { code: true, defaultPermMode: mode });
    expect(q('.permBadge')?.textContent).toContain(T.permModeName(mode));
    // 드롭다운 체크(.sel)도 실제 유효값을 가리켜야 한다(라벨만 맞고 체크가 어긋나면 그것도 거짓말).
    act(() => { fireEvent.click(q('.permBadge')!); });
    expect(q('.cbadgeMenu .item.sel .permName')?.textContent).toBe(T.permModeName(mode));
  });

  it('채널에 값이 있으면 전역과 무관하게 채널값이 이긴다', async () => {
    await openApp([{ ...CODE, permMode: 'plan' }], { code: true, defaultPermMode: 'restricted' });
    expect(q('.permBadge')?.textContent).toContain(T.permModeName('plan'));
    act(() => { fireEvent.click(q('.permBadge')!); });
    expect(q('.cbadgeMenu .item.sel .permName')?.textContent).toBe(T.permModeName('plan'));
  });

  it('채널에 실린 permMode 값을 라벨로 보여준다', async () => {
    await openApp([{ ...CODE, permMode: 'plan' }], { code: true });
    expect(q('.permBadge')?.textContent).toContain(T.permModeName('plan'));
  });

  it('클릭하면 5개 모드와 설명이 뜬다', async () => {
    await openApp([CODE], { code: true });
    act(() => { fireEvent.click(q('.permBadge')!); });
    for (const m of ['plan', 'files', 'restricted', 'auto', 'bypass'] as const) {
      expect(screen.getByText(T.permModeName(m))).toBeInTheDocument();
      expect(screen.getByText(T.permModeDesc(m))).toBeInTheDocument();
    }
  });

  it('모드 선택 → setChannelPermMode 프레임을 보낸다', async () => {
    const ws = await openApp([CODE], { code: true });
    act(() => { fireEvent.click(q('.permBadge')!); });
    act(() => { fireEvent.click(screen.getByText(T.permModeName('files'))); });
    await waitFor(() => expect(frames(ws).some(
      (f) => f.t === 'setChannelPermMode' && f.id === 'w-code' && f.permMode === 'files',
    )).toBe(true));
  });

  it('"권한 무시"는 danger 표시 + 확인 대화를 거친다 — 거부하면 프레임을 안 보낸다', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const ws = await openApp([CODE], { code: true });
    act(() => { fireEvent.click(q('.permBadge')!); });
    expect(q('.cbadgeMenu .item.danger')?.textContent).toContain(T.permModeName('bypass'));
    act(() => { fireEvent.click(screen.getByText(T.permModeName('bypass'))); });
    expect(confirmSpy).toHaveBeenCalledWith(T.permBypassConfirm);
    expect(frames(ws).some((f) => f.t === 'setChannelPermMode')).toBe(false);
  });

  it('"권한 무시"를 확인하면 그때 프레임이 나간다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const ws = await openApp([CODE], { code: true });
    act(() => { fireEvent.click(q('.permBadge')!); });
    act(() => { fireEvent.click(screen.getByText(T.permModeName('bypass'))); });
    await waitFor(() => expect(frames(ws).some(
      (f) => f.t === 'setChannelPermMode' && f.permMode === 'bypass',
    )).toBe(true));
  });

  it('권한 무시가 아닌 모드는 확인 대화 없이 바로 적용된다', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const ws = await openApp([{ ...CODE, permMode: 'bypass' }], { code: true });
    act(() => { fireEvent.click(q('.permBadge')!); });
    act(() => { fireEvent.click(screen.getByText(T.permModeName('auto'))); });
    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(frames(ws).some((f) => f.t === 'setChannelPermMode' && f.permMode === 'auto')).toBe(true));
  });

  it('원격 연결에서도 보인다(서버 설정이 아니라 채널 설정)', async () => {
    await openApp([CODE], { code: true, remote: true });
    expect(q('.permBadge')).toBeInTheDocument();
  });
});

describe('B4. 원격 연결이면 모델·노력 배지를 숨긴다', () => {
  it('원격(비루프백 엔드포인트) — 모델 배지 없음, 연결 배지는 그대로', async () => {
    await openApp([CHAT], { remote: true });
    expect(q('.modelBadge')).toBeNull();
    expect(q('.effortBadge')).toBeNull();
    expect(screen.getByText(/Team Server/)).toBeInTheDocument();
  });

  it('원격 코드 채널에서도 노력 배지는 없다(서버 설정을 따른다)', async () => {
    await openApp([CODE], { code: true, remote: true });
    expect(q('.effortBadge')).toBeNull();
    expect(q('.modelBadge')).toBeNull();
  });

  it('로컬(127.0.0.1)이면 둘 다 보인다', async () => {
    await openApp([CODE], { code: true });
    expect(q('.modelBadge')).toBeInTheDocument();
    expect(q('.effortBadge')).toBeInTheDocument();
  });

  it('응답 모드 배지는 원격에서도 보인다(서버 설정과 무관한 채널 설정)', async () => {
    await openApp([CHAT], { remote: true });
    expect(q('.respondBadge')).toBeInTheDocument();
  });
});

describe('C. 코드 채널 상단 줄(입력바 바로 위)', () => {
  const desktop = () => {
    const a = {
      gitBranchStatus: vi.fn(async () => ({ ok: true as const, branch: 'feat/x', detached: false, added: 3, removed: 1, files: 2 })),
      gitCreatePr: vi.fn(async () => ({ ok: true as const, url: 'https://x/pull/1', alreadyExisted: false })),
    };
    (window as any).engramDesktop = a;
    return a;
  };

  it('데스크톱 코드 채널이면 브랜치 줄이 입력바 바로 위에 뜬다', async () => {
    const a = desktop();
    await openApp([CODE], { code: true });
    await waitFor(() => expect(q('.gitBranchBar')).toBeInTheDocument());
    expect(a.gitBranchStatus).toHaveBeenCalledWith('C:/repo/proj');
    const bar = q('.gitBranchBar')!;
    expect(bar.parentElement?.querySelector('#inputbar')).toBeInTheDocument();
  });

  it('chat 채널엔 브랜치 줄이 없다', async () => {
    desktop();
    await openApp([CHAT]);
    expect(q('.gitBranchBar')).toBeNull();
  });

  it('데스크톱이 아니면 코드 채널이어도 브랜치 줄이 없다', async () => {
    await openApp([CODE], { code: true });
    expect(q('.gitBranchBar')).toBeNull();
  });

  it('채널 헤더(#chhdr)는 기존대로 폴더명만 유지한다', async () => {
    desktop();
    await openApp([CODE], { code: true });
    expect(document.getElementById('chhdr')?.textContent).toContain('proj');
    expect(document.getElementById('chhdr')?.querySelector('.gitBranchBar')).toBeNull();
  });
});

describe('D. 마이크 결과는 입력창에 삽입된다(자동 전송 금지)', () => {
  it('전사 텍스트가 기존 입력 뒤에 이어붙고 전송 프레임은 없다', async () => {
    const rec = {
      ondataavailable: null as any, onstop: null as any, state: 'inactive', mimeType: 'audio/webm',
      start() { this.state = 'recording'; },
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: { size: 4 } }); this.onstop?.(); },
    };
    (globalThis as any).MediaRecorder = function () { return rec; } as any;
    // jsdom의 Blob엔 arrayBuffer()가 없다(Chromium엔 있다) — 변환 경로가 실제로 그걸 쓰므로 대역을 둔다.
    const RealBlob = (globalThis as any).Blob;
    (globalThis as any).Blob = class { constructor() {} async arrayBuffer() { return new ArrayBuffer(8); } } as any;
    (navigator as any).mediaDevices = { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) };
    (globalThis as any).AudioContext = function (this: any) {
      this.decodeAudioData = async () => ({ duration: 1, getChannelData: () => new Float32Array(2) });
      this.close = async () => {};
    } as any;
    (globalThis as any).OfflineAudioContext = function (this: any) {
      this.destination = {};
      this.createBufferSource = () => ({ buffer: null, connect() {}, start() {} });
      this.startRendering = async () => ({ getChannelData: () => new Float32Array(16000) });
    } as any;
    (window as any).engramDesktop = {
      sttAvailable: vi.fn(async () => ({ model: 'b', ready: true, loading: false })),
      sttEnsureModel: vi.fn(async () => ({ ok: true, model: 'b' })),
      sttTranscribe: vi.fn(async () => ({ ok: true, text: '녹음한 말', ms: 5 })),
      onSttProgress: vi.fn(() => vi.fn()),
    };
    const ws = await openApp([CHAT]);
    const i = document.getElementById('input') as HTMLTextAreaElement;
    act(() => { fireEvent.change(i, { target: { value: '앞말' } }); });
    act(() => { fireEvent.click(q('.micBtn')!); });
    await waitFor(() => expect(rec.state).toBe('recording'));
    await act(async () => { fireEvent.click(q('.micBtn')!); });
    await waitFor(() => expect(i.value).toBe('앞말 녹음한 말'));
    expect(frames(ws).some((f) => f.t === 'send')).toBe(false);
    (globalThis as any).Blob = RealBlob;
    delete (globalThis as any).AudioContext;
    delete (globalThis as any).OfflineAudioContext;
    delete (globalThis as any).MediaRecorder;
    delete (navigator as any).mediaDevices;
  });
});
