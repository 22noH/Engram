import {
  DownloadProgress,
  FsLike,
  SttEngine,
  Transcriber,
  isModelCached,
  normalizeLanguage,
  parseWav,
  resampleTo,
  toPcm16k,
} from './stt';

// ---- 테스트용 WAV 생성기 ----
function wav16(samples: number[], sampleRate = 16000, channels = 1): Uint8Array {
  const dataLen = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const put = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  put(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  put(36, 'data');
  v.setUint32(40, dataLen, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.round(s * 32767), true));
  return new Uint8Array(buf);
}

describe('parseWav', () => {
  it('16-bit PCM WAV을 Float32 샘플로 푼다', () => {
    const r = parseWav(wav16([0, 0.5, -0.5, 1], 16000));
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.sampleRate).toBe(16000);
    expect(r.samples.length).toBe(4);
    expect(r.samples[1]).toBeCloseTo(0.5, 3);
    expect(r.samples[2]).toBeCloseTo(-0.5, 3);
  });

  it('스테레오는 평균을 내 모노로 만든다', () => {
    // L=1.0, R=0.0 두 프레임 → 각각 0.5
    const r = parseWav(wav16([1, 0, 1, 0], 16000, 2));
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.samples.length).toBe(2);
    expect(r.samples[0]).toBeCloseTo(0.5, 2);
  });

  it('fmt와 data 사이에 다른 청크(LIST)가 껴 있어도 찾아낸다', () => {
    const base = wav16([0.25, 0.25], 16000);
    // LIST 청크(본문 4바이트)를 fmt 뒤(오프셋 36)에 삽입
    const extra = new Uint8Array(12);
    const ev = new DataView(extra.buffer);
    'LIST'.split('').forEach((c, i) => ev.setUint8(i, c.charCodeAt(0)));
    ev.setUint32(4, 4, true);
    const merged = new Uint8Array(base.length + extra.length);
    merged.set(base.subarray(0, 36), 0);
    merged.set(extra, 36);
    merged.set(base.subarray(36), 36 + extra.length);
    const r = parseWav(merged);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.samples.length).toBe(2);
    expect(r.samples[0]).toBeCloseTo(0.25, 2);
  });

  it('RIFF가 아니거나 너무 짧으면 null', () => {
    expect(parseWav(new Uint8Array(10))).toBeNull();
    expect(parseWav(new Uint8Array(100))).toBeNull();
  });
});

describe('resampleTo', () => {
  it('48kHz → 16kHz면 샘플 수가 1/3이 된다', () => {
    const src = new Float32Array(48000).fill(0.5);
    expect(resampleTo(src, 48000, 16000).length).toBe(16000);
  });

  it('같은 레이트면 원본을 그대로 돌려준다', () => {
    const src = new Float32Array([1, 2, 3]);
    expect(resampleTo(src, 16000, 16000)).toBe(src);
  });

  it('선형보간으로 중간값을 채운다(업샘플)', () => {
    const out = resampleTo(new Float32Array([0, 1]), 8000, 16000);
    expect(out.length).toBe(4);
    expect(out[1]).toBeCloseTo(0.5, 3);
  });
});

describe('toPcm16k', () => {
  it('WAV 바이트를 받아 16kHz로 맞춘다', () => {
    const r = toPcm16k(wav16(new Array(48000).fill(0.1), 48000));
    expect('ok' in r).toBe(true);
    if (!('ok' in r)) return;
    expect(r.samples.length).toBe(16000);
  });

  it('가공 없는 Float32 PCM(ArrayBuffer)도 받는다', () => {
    const f = new Float32Array([0.1, 0.2, 0.3]);
    const r = toPcm16k(f.buffer, 16000);
    expect('ok' in r).toBe(true);
    if (!('ok' in r)) return;
    expect(Array.from(r.samples)).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
    ]);
  });

  it('빈 오디오는 명확한 에러', () => {
    expect(toPcm16k(new ArrayBuffer(0))).toEqual({ error: 'empty audio' });
  });

  it('Float32로 볼 수 없는 길이(4의 배수 아님)는 에러', () => {
    const r = toPcm16k(new Uint8Array([1, 2, 3]));
    expect('error' in r).toBe(true);
  });

  it('지원하지 않는 WAV(8-bit)는 형식을 알려주는 에러', () => {
    const bad = wav16([0.1, 0.2]);
    new DataView(bad.buffer).setUint16(34, 8, true); // bitsPerSample = 8
    const r = toPcm16k(bad);
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toContain('unsupported WAV');
  });
});

describe('normalizeLanguage', () => {
  it('로케일을 두 글자 코드로 줄인다', () => {
    expect(normalizeLanguage('ko-KR')).toBe('ko');
    expect(normalizeLanguage('en_US')).toBe('en');
  });

  it('auto/빈 값/비문자열은 undefined(자동감지)', () => {
    expect(normalizeLanguage('auto')).toBeUndefined();
    expect(normalizeLanguage('')).toBeUndefined();
    expect(normalizeLanguage(undefined)).toBeUndefined();
    expect(normalizeLanguage(null)).toBeUndefined();
  });
});

describe('DownloadProgress', () => {
  it('여러 파일의 진행률을 하나의 %로 합친다', () => {
    const p = new DownloadProgress();
    p.update({ status: 'progress', file: 'a.onnx', loaded: 0, total: 100 });
    const s = p.update({ status: 'progress', file: 'b.onnx', loaded: 0, total: 100 });
    expect(s.totalBytes).toBe(200);
    expect(s.percent).toBe(0);
    const s2 = p.update({ status: 'progress', file: 'a.onnx', loaded: 100, total: 100 });
    expect(s2.percent).toBe(50); // a만 끝났으면 전체는 절반
  });

  it('done 이벤트는 loaded가 없어도 그 파일을 완료로 친다', () => {
    const p = new DownloadProgress();
    p.update({ status: 'progress', file: 'a.onnx', loaded: 10, total: 100 });
    expect(p.update({ status: 'done', file: 'a.onnx', total: 100 }).percent).toBe(100);
  });

  it('total을 모르는 이벤트만 오면 0%(거짓 100% 방지)', () => {
    expect(new DownloadProgress().update({ status: 'initiate', file: 'a.onnx' }).percent).toBe(0);
  });
});

describe('isModelCached', () => {
  const fake = (paths: string[], onnx: string[]): FsLike => ({
    existsSync: (p) => paths.some((x) => p.replace(/\\/g, '/').endsWith(x)),
    readdirSync: () => onnx,
  });

  it('config.json + encoder/decoder onnx가 다 있으면 true', () => {
    const fs = fake(['whisper-base/config.json', 'whisper-base/onnx'], [
      'encoder_model_quantized.onnx',
      'decoder_model_merged_quantized.onnx',
    ]);
    expect(isModelCached('/cache', 'onnx-community/whisper-base', fs)).toBe(true);
  });

  it('decoder가 없으면 false(반쯤 받다 만 캐시)', () => {
    const fs = fake(['whisper-base/config.json', 'whisper-base/onnx'], ['encoder_model_quantized.onnx']);
    expect(isModelCached('/cache', 'onnx-community/whisper-base', fs)).toBe(false);
  });

  it('config.json이 없으면 false', () => {
    expect(isModelCached('/cache', 'onnx-community/whisper-base', fake([], []))).toBe(false);
  });

  it('fs가 throw해도 false(never-throw)', () => {
    const boom: FsLike = {
      existsSync: () => {
        throw new Error('EACCES');
      },
      readdirSync: () => [],
    };
    expect(isModelCached('/cache', 'm', boom)).toBe(false);
  });
});

describe('SttEngine', () => {
  const cachedFs: FsLike = {
    existsSync: () => true,
    readdirSync: () => ['encoder_model.onnx', 'decoder_model_merged.onnx'],
  };
  const emptyFs: FsLike = { existsSync: () => false, readdirSync: () => [] };
  const okTranscriber: Transcriber = async () => ({ text: '  안녕하세요  ' });

  it('모델이 캐시에 없으면 ready=false로 상태를 알린다(무반응 금지)', () => {
    const e = new SttEngine('/cache', 'm', async () => okTranscriber, emptyFs);
    expect(e.status()).toEqual({ model: 'm', ready: false, loading: false });
  });

  it('캐시에 있으면 ready=true', () => {
    const e = new SttEngine('/cache', 'm', async () => okTranscriber, cachedFs);
    expect(e.status().ready).toBe(true);
  });

  it('전사 결과의 공백을 다듬어 돌려준다', async () => {
    const e = new SttEngine('/cache', 'm', async () => okTranscriber, cachedFs);
    const r = await e.transcribe(new Float32Array(1600).fill(0.1));
    expect('ok' in r).toBe(true);
    if (!('ok' in r)) return;
    expect(r.text).toBe('안녕하세요');
  });

  it('언어를 주면 파이프라인에 코드로 전달하고, 없으면 자동감지(미전달)', async () => {
    let seen: Record<string, unknown> = {};
    const factory = async (): Promise<Transcriber> => async (_a, o) => {
      seen = o;
      return { text: 'x' };
    };
    const e = new SttEngine('/cache', 'm', factory, cachedFs);
    await e.transcribe(new Float32Array(16).fill(0), { language: 'ko-KR' });
    expect(seen.language).toBe('ko');
    await e.transcribe(new Float32Array(16).fill(0), { language: 'auto' });
    expect(seen.language).toBeUndefined();
  });

  it('30초를 넘는 오디오는 청크 옵션을 켠다', async () => {
    let seen: Record<string, unknown> = {};
    const factory = async (): Promise<Transcriber> => async (_a, o) => {
      seen = o;
      return { text: 'x' };
    };
    const e = new SttEngine('/cache', 'm', factory, cachedFs);
    await e.transcribe(new Float32Array(16000 * 40)); // 40초
    expect(seen.chunk_length_s).toBe(30);
    await e.transcribe(new Float32Array(16000 * 5)); // 5초
    expect(seen.chunk_length_s).toBeUndefined();
  });

  it('모델 로드 실패는 error 문자열로 돌아온다(throw 금지)', async () => {
    const e = new SttEngine('/cache', 'm', async () => {
      throw new Error('network down');
    }, emptyFs);
    expect(await e.ensure()).toEqual({ error: 'network down' });
    const t = await e.transcribe(new Float32Array(16));
    expect(t).toEqual({ error: 'network down' });
  });

  it('로드 실패 뒤에도 재시도할 수 있다(promise 캐시가 실패를 고착시키지 않음)', async () => {
    let attempt = 0;
    const e = new SttEngine('/cache', 'm', async () => {
      attempt++;
      if (attempt === 1) throw new Error('offline');
      return okTranscriber;
    }, emptyFs);
    expect(await e.ensure()).toEqual({ error: 'offline' });
    expect(await e.ensure()).toEqual({ ok: true, model: 'm' });
    expect(attempt).toBe(2);
  });

  it('동시에 여러 번 불러도 모델은 한 번만 받는다(중복 다운로드 방지)', async () => {
    let loads = 0;
    const e = new SttEngine('/cache', 'm', async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 10));
      return okTranscriber;
    }, emptyFs);
    await Promise.all([e.ensure(), e.ensure(), e.ensure()]);
    expect(loads).toBe(1);
  });

  it('다운로드 진행률을 집계해 콜백으로 알린다', async () => {
    const seen: number[] = [];
    const factory = async (_m: string, _c: string, onP: (p: { status: string; file?: string; loaded?: number; total?: number }) => void): Promise<Transcriber> => {
      onP({ status: 'progress', file: 'a', loaded: 50, total: 100 });
      onP({ status: 'progress', file: 'a', loaded: 100, total: 100 });
      return okTranscriber;
    };
    const e = new SttEngine('/cache', 'm', factory, emptyFs);
    await e.ensure((s) => seen.push(s.percent));
    expect(seen).toEqual([50, 100]);
  });

  it('빈 오디오는 모델을 건드리지 않고 바로 에러', async () => {
    let loads = 0;
    const e = new SttEngine('/cache', 'm', async () => {
      loads++;
      return okTranscriber;
    }, emptyFs);
    expect(await e.transcribe(new ArrayBuffer(0))).toEqual({ error: 'empty audio' });
    expect(loads).toBe(0);
  });

  it('너무 긴 오디오는 거부한다', async () => {
    const e = new SttEngine('/cache', 'm', async () => okTranscriber, cachedFs);
    const r = await e.transcribe(new Float32Array(16000 * 601));
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toContain('too long');
  });

  it('전사 중 예외도 결과형으로 흡수한다', async () => {
    const e = new SttEngine('/cache', 'm', async () => async () => {
      throw new Error('ort crashed');
    }, cachedFs);
    expect(await e.transcribe(new Float32Array(16))).toEqual({ error: 'ort crashed' });
  });
});
