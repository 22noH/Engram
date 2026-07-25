import { STT_SAMPLE_RATE, toMono16k } from './stt-audio';

// 음성 입력(STT) 오디오 변환 — 백엔드(chat-preload.ts)가 명시한 계약:
// "MediaRecorder의 webm/opus 원본을 그대로 보내면 안 된다. Web Audio로 디코드+리샘플해서
//  모노 16kHz Float32 PCM의 ArrayBuffer로 보내라"(decodeAudioData → OfflineAudioContext(1,len,16000)).
// 이 경로가 조용히 깨지면(원본 webm을 그대로 보내면) 전사가 항상 실패하므로 테스트로 못박는다.

class FakeAudioBuffer {
  constructor(public duration: number, public data: Float32Array) {}
  getChannelData(): Float32Array { return this.data; }
}

function installFakes(opts: { duration: number }) {
  const decodeAudioData = vi.fn(async (_bytes: ArrayBuffer) => new FakeAudioBuffer(opts.duration, new Float32Array(4)));
  const close = vi.fn(async () => {});
  const AudioCtx = vi.fn(function (this: any) {
    this.decodeAudioData = decodeAudioData;
    this.close = close;
  });
  const startRendering = vi.fn(async () => {
    const frames = Math.ceil(opts.duration * STT_SAMPLE_RATE);
    return new FakeAudioBuffer(opts.duration, new Float32Array(frames));
  });
  const connect = vi.fn();
  const start = vi.fn();
  const createBufferSource = vi.fn(() => ({ buffer: null as unknown, connect, start }));
  const offlineArgs: unknown[][] = [];
  const OfflineCtx = vi.fn(function (this: any, ...args: unknown[]) {
    offlineArgs.push(args);
    this.destination = {};
    this.createBufferSource = createBufferSource;
    this.startRendering = startRendering;
  });
  (globalThis as any).AudioContext = AudioCtx;
  (globalThis as any).OfflineAudioContext = OfflineCtx;
  return { decodeAudioData, offlineArgs, connect, start, close };
}

function fakeBlob(bytes: number): Blob {
  return { arrayBuffer: async () => new ArrayBuffer(bytes) } as unknown as Blob;
}

afterEach(() => {
  delete (globalThis as any).AudioContext;
  delete (globalThis as any).OfflineAudioContext;
  vi.restoreAllMocks();
});

describe('toMono16k — 모노 16kHz Float32 PCM 변환', () => {
  it('decodeAudioData에 blob 바이트를 넘긴다(webm 원본을 그대로 보내지 않는다)', async () => {
    const f = installFakes({ duration: 1 });
    await toMono16k(fakeBlob(64));
    expect(f.decodeAudioData).toHaveBeenCalledTimes(1);
    expect((f.decodeAudioData.mock.calls[0][0] as ArrayBuffer).byteLength).toBe(64);
  });

  it('OfflineAudioContext(1, ceil(duration*16000), 16000)로 리샘플한다', async () => {
    const f = installFakes({ duration: 2.5 });
    await toMono16k(fakeBlob(8));
    expect(f.offlineArgs[0]).toEqual([1, Math.ceil(2.5 * 16000), 16000]);
  });

  it('렌더된 채널0 데이터를 ArrayBuffer(Float32 4바이트/프레임)로 반환한다', async () => {
    installFakes({ duration: 1 });
    const buf = await toMono16k(fakeBlob(8));
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(buf.byteLength).toBe(16000 * 4);
  });

  it('소스를 destination에 연결하고 start()로 재생해야 렌더 결과가 무음이 아니다', async () => {
    const f = installFakes({ duration: 1 });
    await toMono16k(fakeBlob(8));
    expect(f.connect).toHaveBeenCalled();
    expect(f.start).toHaveBeenCalled();
  });

  it('AudioContext가 없는 환경이면 던진다(호출부가 안내로 잡는다)', async () => {
    installFakes({ duration: 1 });
    delete (globalThis as any).AudioContext;
    await expect(toMono16k(fakeBlob(8))).rejects.toThrow();
  });

  it('STT_SAMPLE_RATE는 백엔드 계약값 16000이다', () => {
    expect(STT_SAMPLE_RATE).toBe(16000);
  });
});
