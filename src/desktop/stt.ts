import * as fsSync from 'fs';
import * as path from 'path';

// 음성 입력(로컬 Whisper) — 오프라인·무료·프라이버시. Electron은 브라우저 음성인식(Web Speech API)을
// 못 쓰므로 전사는 메인 프로세스에서 로컬 모델로 한다.
//
// 왜 whisper.cpp 바인딩(nodejs-whisper·smart-whisper·whisper-node)이 아니라 @huggingface/transformers인가:
//   전제 조건이 "Electron 43(Node 22 ABI)에서 리빌드 없이 동작"인데, whisper.cpp 계열은 전부
//   설치 시점에 cmake/make로 C++를 빌드하거나(nodejs-whisper·whisper-node — 사용자 머신에 빌드
//   도구를 요구하고, 만들어진 바이너리를 asar에 담아 배포하는 별도 작업이 필요) 네이티브 애드온을
//   소스 빌드한다(smart-whisper). 반면 @huggingface/transformers는 **이 레포가 이미 임베딩(bge-m3)에
//   쓰고 있는 의존성**이고, 그 백엔드인 onnxruntime-node는 N-API(napi-v6) 프리빌드라 electron-builder
//   설정(package.json build.win.files의 onnxruntime-node/bin/napi-v6/**)에서 보듯 이미 리빌드 없이
//   패키징돼 돌고 있다 — node-pty가 N-API 프리빌드라 그냥 동작한 것(pty-manager.ts 주석)과 같은 이유.
//   즉 새 의존성 0개, 새 네이티브 빌드 0개로 Whisper를 얻는다.
//
// 모델: 다국어(한국어 기본 사용) whisper-base. 앱에 번들하지 않고 첫 사용 시 다운로드해
//   ENGRAM_MODEL_CACHE_DIR(=userData/models — 임베딩 모델과 같은 폴더)에 캐시한다.
//
// never-throw: 모든 공개 메서드는 결과 객체({ok:...} | {error}) 로만 답한다(레포 관례).

export const DEFAULT_STT_MODEL = process.env.ENGRAM_STT_MODEL ?? 'onnx-community/whisper-base';
const TARGET_SAMPLE_RATE = 16000; // whisper 고정 입력 레이트
const MAX_AUDIO_SECONDS = 10 * 60; // 한 번에 전사할 상한(메모리 폭주 방지)

export interface SttProgress {
  status: string; // 'initiate' | 'download' | 'progress' | 'done' | 'ready' ...
  file?: string;
  loaded?: number;
  total?: number;
  progress?: number; // 0~100 (transformers.js가 파일 단위로 준다)
}

/** 렌더러로 보내는 집계된 진행률(파일 여러 개를 하나의 막대로). */
export interface SttDownloadState {
  percent: number; // 0~100
  loadedBytes: number;
  totalBytes: number;
  file: string;
}

export type Transcriber = (
  audio: Float32Array,
  opts: Record<string, unknown>,
) => Promise<{ text?: string } | Array<{ text?: string }>>;

export type TranscriberFactory = (
  modelId: string,
  cacheDir: string,
  onProgress: (p: SttProgress) => void,
) => Promise<Transcriber>;

export type SttStatus = { model: string; ready: boolean; loading: boolean };
export type EnsureResult = { ok: true; model: string } | { error: string };
export type TranscribeResult = { ok: true; text: string; ms: number } | { error: string };

// ---- 순수 로직(유닛테스트 대상) ----

/**
 * 파일 단위로 오는 다운로드 진행 이벤트를 "전체 몇 %"로 합친다.
 * whisper는 encoder/decoder/tokenizer 등 파일이 여러 개라 파일별 %를 그대로 보여주면
 * 막대가 여러 번 0→100을 왕복해 사용자에게 거짓말이 된다.
 */
export class DownloadProgress {
  private readonly files = new Map<string, { loaded: number; total: number }>();
  private lastFile = '';

  update(p: SttProgress): SttDownloadState {
    const name = p.file ?? this.lastFile;
    if (p.file) this.lastFile = p.file;
    if (name && typeof p.total === 'number' && p.total > 0) {
      const loaded = typeof p.loaded === 'number' ? p.loaded : 0;
      // 'done'은 loaded를 안 줄 수 있다 — 그 파일은 다 받은 것으로 확정한다.
      this.files.set(name, { loaded: p.status === 'done' ? p.total : Math.min(loaded, p.total), total: p.total });
    }
    let loadedBytes = 0;
    let totalBytes = 0;
    for (const f of this.files.values()) {
      loadedBytes += f.loaded;
      totalBytes += f.total;
    }
    const percent = totalBytes > 0 ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : 0;
    return { percent, loadedBytes, totalBytes, file: name };
  }
}

/**
 * WAV(RIFF) 바이트를 모노 Float32 샘플로 디코드한다. 지원: 16-bit PCM(fmt 1), 32-bit float(fmt 3).
 * 지원 밖이거나 형식이 깨졌으면 null(호출부가 명확한 에러 문자열로 바꾼다).
 * 청크를 순회하는 이유: WAV엔 fmt/data 사이에 LIST 같은 청크가 끼는 경우가 흔해서 고정 오프셋(44)은 틀린다.
 */
export function parseWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number): string => String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOff = -1;
  let dataLen = 0;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(size, bytes.length - body);
    }
    off = body + size + (size % 2); // 청크는 짝수 바이트 정렬(홀수면 패딩 1바이트)
  }
  if (dataOff < 0 || channels < 1 || sampleRate < 1) return null;

  if (format === 1 && bits === 16) {
    const frames = Math.floor(dataLen / (2 * channels));
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += view.getInt16(dataOff + (i * channels + c) * 2, true) / 32768;
      out[i] = sum / channels; // 다채널은 평균 → 모노(whisper는 모노만 받는다)
    }
    return { samples: out, sampleRate };
  }
  if (format === 3 && bits === 32) {
    const frames = Math.floor(dataLen / (4 * channels));
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += view.getFloat32(dataOff + (i * channels + c) * 4, true);
      out[i] = sum / channels;
    }
    return { samples: out, sampleRate };
  }
  return null; // 압축(mp3/opus 등)이나 8/24-bit는 미지원 — 렌더러가 Web Audio로 풀어 보내면 된다
}

/** 선형보간 리샘플. whisper 입력은 16kHz 고정이라 그 외 레이트는 반드시 여기를 지난다. */
export function resampleTo(samples: Float32Array, from: number, to: number = TARGET_SAMPLE_RATE): Float32Array {
  if (from === to || samples.length === 0 || from <= 0) return samples;
  const ratio = from / to;
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = src - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

/**
 * 렌더러가 보낸 오디오를 16kHz 모노 Float32로 만든다.
 * 받는 형태 두 가지:
 *   1) WAV(RIFF) 바이트 — 헤더의 레이트를 그대로 쓴다.
 *   2) 가공 없는 Float32 PCM 바이트 — 렌더러가 Web Audio(decodeAudioData + OfflineAudioContext)로
 *      풀어 보내는 권장 경로. 레이트는 sampleRate 인자로 받는다(기본 16000).
 * MediaRecorder의 webm/opus 원본을 그대로 보내면 안 된다 — Node엔 그걸 풀 디코더가 없다.
 */
export function toPcm16k(
  input: ArrayBuffer | Uint8Array | Float32Array,
  sampleRate = TARGET_SAMPLE_RATE,
): { ok: true; samples: Float32Array } | { error: string } {
  if (input instanceof Float32Array) {
    if (input.length === 0) return { error: 'empty audio' };
    return { ok: true, samples: resampleTo(input, sampleRate) };
  }
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength === 0) return { error: 'empty audio' };
  if (bytes.byteLength >= 12 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'RIFF') {
    const wav = parseWav(bytes);
    if (!wav) return { error: 'unsupported WAV format (expected 16-bit PCM or 32-bit float)' };
    if (wav.samples.length === 0) return { error: 'empty audio' };
    return { ok: true, samples: resampleTo(wav.samples, wav.sampleRate) };
  }
  if (bytes.byteLength % 4 !== 0) return { error: 'audio is not raw Float32 PCM (length not a multiple of 4)' };
  // byteOffset이 4의 배수가 아니면 Float32Array 뷰를 못 만든다(정렬) — 그럴 땐 복사해서 정렬을 맞춘다.
  const aligned =
    bytes.byteOffset % 4 === 0
      ? new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
      : new Float32Array(bytes.slice().buffer);
  if (aligned.length === 0) return { error: 'empty audio' };
  return { ok: true, samples: resampleTo(aligned, sampleRate) };
}

/** 'ko-KR' → 'ko'. 'auto'/빈 값은 undefined(=whisper 자동 언어감지). */
export function normalizeLanguage(v: string | undefined | null): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (!s || s === 'auto') return undefined;
  return s.split(/[-_]/)[0];
}

export interface FsLike {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
}

/**
 * 모델이 이미 캐시에 있는지(=다운로드 없이 바로 쓸 수 있는지). transformers.js의 캐시 레이아웃은
 * `<cacheDir>/<modelId>/config.json` + `<cacheDir>/<modelId>/onnx/*.onnx`(임베딩 모델도 동일 — 실측).
 */
export function isModelCached(cacheDir: string, modelId: string, fsLike: FsLike = fsSync): boolean {
  try {
    const root = path.join(cacheDir, ...modelId.split('/'));
    if (!fsLike.existsSync(path.join(root, 'config.json'))) return false;
    const onnxDir = path.join(root, 'onnx');
    if (!fsLike.existsSync(onnxDir)) return false;
    const files = fsLike.readdirSync(onnxDir);
    return files.some((f) => /encoder.*\.onnx$/i.test(f)) && files.some((f) => /decoder.*\.onnx$/i.test(f));
  } catch {
    return false;
  }
}

// ---- 엔진 ----

// CommonJS에서 ESM 패키지(@huggingface/transformers)를 가져오는 간접 import — transformers-embedder.ts와 동일 관례.
const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;

/**
 * 기본 팩토리: 실제 transformers.js ASR 파이프라인. 모듈 로드를 함수 안에 둬서 유닛테스트가
 * 무거운 ESM/네이티브(onnxruntime-node)를 전혀 건드리지 않게 한다(pty-manager의 defaultSpawnFactory와 같은 결).
 * dtype q8: base 모델 기준 다운로드/메모리를 크게 줄이면서 한국어 품질 손실이 작다.
 */
export const defaultTranscriberFactory: TranscriberFactory = async (modelId, cacheDir, onProgress) => {
  const mod = await dynamicImport('@huggingface/transformers');
  if (cacheDir) mod.env.cacheDir = cacheDir;
  return (await mod.pipeline('automatic-speech-recognition', modelId, {
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    progress_callback: onProgress,
  })) as Transcriber;
};

export class SttEngine {
  private transcriber: Transcriber | null = null;
  private loading: Promise<EnsureResult> | null = null;

  constructor(
    private readonly cacheDir: string,
    private readonly modelId: string = DEFAULT_STT_MODEL,
    private readonly factory: TranscriberFactory = defaultTranscriberFactory,
    private readonly fsLike: FsLike = fsSync,
  ) {}

  /** 렌더러가 마이크 버튼을 그릴 때 쓰는 상태. 절대 throw하지 않고 다운로드도 시작하지 않는다. */
  status(): SttStatus {
    return {
      model: this.modelId,
      ready: this.transcriber !== null || isModelCached(this.cacheDir, this.modelId, this.fsLike),
      loading: this.loading !== null,
    };
  }

  /**
   * 모델을 준비한다(없으면 다운로드). 동시에 여러 번 불려도 실제 로드는 한 번(중복 다운로드 방지).
   * 실패하면 캐시된 promise를 비워 다음 호출이 재시도할 수 있게 한다(오프라인 후 복구).
   */
  ensure(onProgress?: (s: SttDownloadState) => void): Promise<EnsureResult> {
    if (this.transcriber) return Promise.resolve({ ok: true, model: this.modelId });
    if (this.loading) return this.loading;
    const agg = new DownloadProgress();
    this.loading = (async (): Promise<EnsureResult> => {
      try {
        const t = await this.factory(this.modelId, this.cacheDir, (p) => {
          if (!onProgress) return;
          try {
            onProgress(agg.update(p));
          } catch {
            // 구독자 에러가 다운로드를 깨지 않게 격리
          }
        });
        this.transcriber = t;
        return { ok: true, model: this.modelId };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    })().then((r) => {
      this.loading = null;
      return r;
    });
    return this.loading;
  }

  /** 오디오 → 텍스트. 모델이 없으면 여기서 준비까지 한다(진행률은 onProgress로). */
  async transcribe(
    audio: ArrayBuffer | Uint8Array | Float32Array,
    opts: { sampleRate?: number; language?: string } = {},
    onProgress?: (s: SttDownloadState) => void,
  ): Promise<TranscribeResult> {
    const started = Date.now();
    const pcm = toPcm16k(audio, opts.sampleRate ?? TARGET_SAMPLE_RATE);
    if (!('ok' in pcm)) return { error: pcm.error };
    const seconds = pcm.samples.length / TARGET_SAMPLE_RATE;
    if (seconds > MAX_AUDIO_SECONDS) {
      return { error: `audio too long (${Math.round(seconds)}s, max ${MAX_AUDIO_SECONDS}s)` };
    }
    const ready = await this.ensure(onProgress);
    if ('error' in ready) return { error: ready.error };
    if (!this.transcriber) return { error: 'speech model is not loaded' };
    try {
      const runOpts: Record<string, unknown> = { task: 'transcribe', return_timestamps: false };
      const lang = normalizeLanguage(opts.language);
      if (lang) runOpts.language = lang; // 없으면 whisper 자동 언어감지
      // whisper의 입력창은 30초 — 그보다 길면 청크로 나눠 돌린다(짧은 녹음엔 불필요한 오버헤드).
      if (seconds > 30) {
        runOpts.chunk_length_s = 30;
        runOpts.stride_length_s = 5;
      }
      const out = await this.transcriber(pcm.samples, runOpts);
      const text = Array.isArray(out) ? out.map((o) => o?.text ?? '').join(' ') : (out?.text ?? '');
      return { ok: true, text: String(text).trim(), ms: Date.now() - started };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
}
