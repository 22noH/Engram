import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { MicButton } from './MicButton';
import { T } from '../i18n';

// 음성 입력 버튼 — 데스크톱 전용. 실패 경로(권한 거부·모델 실패·전사 실패·미지원 환경)는
// 무반응이 아니라 반드시 안내로 끝나야 한다(브리프).

vi.mock('../stt-audio', () => ({
  STT_SAMPLE_RATE: 16000,
  toMono16k: vi.fn(async () => new ArrayBuffer(320)),
}));
import { toMono16k } from '../stt-audio';

class FakeRecorder {
  static last: FakeRecorder;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  constructor(public stream: unknown) { FakeRecorder.last = this; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: { size: 10, type: this.mimeType } as unknown as Blob });
    this.onstop?.();
  }
}

function sttApi(over: Record<string, unknown> = {}) {
  const a = {
    sttAvailable: vi.fn(async () => ({ model: 'base', ready: true, loading: false })),
    sttEnsureModel: vi.fn(async () => ({ ok: true as const, model: 'base' })),
    sttTranscribe: vi.fn(async () => ({ ok: true as const, text: '받아쓴 문장', ms: 12 })),
    onSttProgress: vi.fn(() => vi.fn()),
    ...over,
  };
  (window as any).engramDesktop = a;
  return a;
}

function grantMic() {
  const track = { stop: vi.fn() };
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
  (navigator as any).mediaDevices = { getUserMedia };
  (globalThis as any).MediaRecorder = FakeRecorder;
  return { getUserMedia, track };
}

afterEach(() => {
  delete (window as any).engramDesktop;
  delete (navigator as any).mediaDevices;
  delete (globalThis as any).MediaRecorder;
  vi.clearAllMocks();
});

function micBtn(): HTMLElement { return screen.getByRole('button', { name: /🎤|●/ }); }

describe('MicButton — 게이트', () => {
  it('데스크톱이 아니면(engramDesktop 없음) 버튼 자체를 숨긴다', () => {
    const { container } = render(<MicButton onText={vi.fn()} />);
    expect(container.querySelector('.micBtn')).toBeNull();
  });

  it('데스크톱이면 버튼이 보인다', () => {
    sttApi();
    const { container } = render(<MicButton onText={vi.fn()} />);
    expect(container.querySelector('.micBtn')).toBeInTheDocument();
  });
});

describe('MicButton — 실패 경로 안내(무반응 금지)', () => {
  it('마이크 권한 거부 → 안내를 보여준다', async () => {
    sttApi();
    (navigator as any).mediaDevices = { getUserMedia: vi.fn(async () => { throw new Error('NotAllowedError'); }) };
    (globalThis as any).MediaRecorder = FakeRecorder;
    render(<MicButton onText={vi.fn()} />);
    act(() => { fireEvent.click(micBtn()); });
    expect(await screen.findByText(T.micDenied)).toBeInTheDocument();
  });

  it('getUserMedia 자체가 없는 환경(Electron file:// 등) → 안내를 보여준다', async () => {
    sttApi();
    render(<MicButton onText={vi.fn()} />);
    act(() => { fireEvent.click(micBtn()); });
    expect(await screen.findByText(T.micUnavailable)).toBeInTheDocument();
  });

  it('모델 준비 실패 → 안내를 보여주고 녹음을 시작하지 않는다', async () => {
    const a = sttApi({
      sttAvailable: vi.fn(async () => ({ model: 'base', ready: false, loading: false })),
      sttEnsureModel: vi.fn(async () => ({ error: 'download failed' })),
    });
    const g = grantMic();
    render(<MicButton onText={vi.fn()} />);
    act(() => { fireEvent.click(micBtn()); });
    expect(await screen.findByText(T.micModelFailed)).toBeInTheDocument();
    expect(g.getUserMedia).not.toHaveBeenCalled();
    expect(a.sttEnsureModel).toHaveBeenCalled();
  });

  it('전사 실패 → 안내를 보여주고 onText를 부르지 않는다', async () => {
    sttApi({ sttTranscribe: vi.fn(async () => ({ error: 'boom' })) });
    grantMic();
    const onText = vi.fn();
    render(<MicButton onText={onText} />);
    act(() => { fireEvent.click(micBtn()); });
    await waitFor(() => expect(FakeRecorder.last?.state).toBe('recording'));
    await act(async () => { fireEvent.click(micBtn()); });
    expect(await screen.findByText(T.micFailed)).toBeInTheDocument();
    expect(onText).not.toHaveBeenCalled();
  });
});

describe('MicButton — 정상 흐름', () => {
  it('모델 미준비면 진행률(NN%)을 보여준다', async () => {
    let cb: ((s: { percent: number; loadedBytes: number; totalBytes: number; file: string }) => void) | null = null;
    let release!: () => void;
    sttApi({
      sttAvailable: vi.fn(async () => ({ model: 'base', ready: false, loading: false })),
      onSttProgress: vi.fn((f: any) => { cb = f; return vi.fn(); }),
      sttEnsureModel: vi.fn(() => new Promise((r) => { release = () => r({ ok: true, model: 'base' }); })),
    });
    grantMic();
    render(<MicButton onText={vi.fn()} />);
    act(() => { fireEvent.click(micBtn()); });
    await waitFor(() => expect(cb).toBeTruthy());
    act(() => { cb!({ percent: 42, loadedBytes: 1, totalBytes: 2, file: 'ggml' }); });
    expect(await screen.findByText(T.micDownloading(42))).toBeInTheDocument();
    await act(async () => { release(); });
  });

  it('녹음→중지→전사 결과를 onText로 넘긴다(자동 전송 없음)', async () => {
    const a = sttApi();
    grantMic();
    const onText = vi.fn();
    render(<MicButton onText={onText} />);
    act(() => { fireEvent.click(micBtn()); });
    await waitFor(() => expect(FakeRecorder.last?.state).toBe('recording'));
    await act(async () => { fireEvent.click(micBtn()); });
    await waitFor(() => expect(onText).toHaveBeenCalledWith('받아쓴 문장'));
    expect(a.sttTranscribe).toHaveBeenCalled();
  });

  it('전사에 보내는 건 webm 원본이 아니라 toMono16k가 만든 16kHz PCM이다(백엔드 계약)', async () => {
    const a = sttApi();
    grantMic();
    render(<MicButton onText={vi.fn()} />);
    act(() => { fireEvent.click(micBtn()); });
    await waitFor(() => expect(FakeRecorder.last?.state).toBe('recording'));
    await act(async () => { fireEvent.click(micBtn()); });
    await waitFor(() => expect(a.sttTranscribe).toHaveBeenCalled());
    expect(toMono16k).toHaveBeenCalled();
    const [audio, opts] = (a.sttTranscribe as any).mock.calls[0];
    expect(audio).toBeInstanceOf(ArrayBuffer);
    expect(audio.byteLength).toBe(320);
    expect(opts).toMatchObject({ sampleRate: 16000 });
  });

  it('녹음이 끝나면 마이크 트랙을 놓아준다(녹음 표시가 계속 켜져 있지 않게)', async () => {
    sttApi();
    const g = grantMic();
    render(<MicButton onText={vi.fn()} />);
    act(() => { fireEvent.click(micBtn()); });
    await waitFor(() => expect(FakeRecorder.last?.state).toBe('recording'));
    await act(async () => { fireEvent.click(micBtn()); });
    await waitFor(() => expect(g.track.stop).toHaveBeenCalled());
  });
});
