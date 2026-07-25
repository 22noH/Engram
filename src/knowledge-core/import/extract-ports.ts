// 실제 I/O를 하는 추출 포트 구현(무거운 의존성은 전부 여기 한 곳에만). 유닛테스트는
// 이 파일을 import하지 않는다 — extract-file.ts가 포트를 주입받게 설계한 이유가 그것이다.
//
// unpdf: pdfjs를 서버리스용으로 번들한 순수 JS/wasm 패키지(의존성 0, CJS 빌드 있음, 2.4MB).
//   pdfjs-dist·pdf-parse는 @napi-rs/canvas(37MB 네이티브 프리빌드)를 끌고 와 배제했다.
// mpg123-decoder: mp3 → PCM(wasm). 기존 stt.ts(Whisper)가 PCM/WAV만 받으므로 압축 해제만 보탠다.

/** unpdf 로드는 첫 PDF에서만(부팅 비용 0). 실패해도 캐시하지 않아 다음에 재시도된다. */
let pdfMod: { extractText: Function; getDocumentProxy: Function } | null = null;

/** PDF 바이트 → 전체 페이지 텍스트(페이지 사이 빈 줄). */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  if (!pdfMod) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    pdfMod = require('unpdf') as { extractText: Function; getDocumentProxy: Function };
  }
  // unpdf가 입력 버퍼를 detach(transfer)할 수 있어 사본을 넘긴다 — 원본 바이트를 쓰는 호출부 보호.
  const doc = await pdfMod.getDocumentProxy(Uint8Array.from(bytes));
  const out = (await pdfMod.extractText(doc, { mergePages: false })) as { text: string | string[] };
  return Array.isArray(out.text) ? out.text.join('\n\n') : String(out.text ?? '');
}

/** mp3 바이트 → 모노 Float32 PCM + 샘플레이트. 다채널은 평균해 모노로(Whisper는 모노만 받는다). */
export async function decodeMp3(bytes: Uint8Array): Promise<{ samples: Float32Array; sampleRate: number }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { MPEGDecoder } = require('mpg123-decoder') as { MPEGDecoder: new () => MpegDecoder };
  const dec = new MPEGDecoder();
  await dec.ready;
  try {
    const out = dec.decode(bytes);
    const chans = out.channelData ?? [];
    if (chans.length === 0 || chans[0].length === 0) throw new Error('mp3 decode produced no audio');
    if (chans.length === 1) return { samples: chans[0], sampleRate: out.sampleRate };
    const n = chans[0].length;
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (const c of chans) sum += c[i] ?? 0;
      mono[i] = sum / chans.length;
    }
    return { samples: mono, sampleRate: out.sampleRate };
  } finally {
    try { dec.free(); } catch { /* 해제 실패는 무시 — 프로세스 종료로 회수된다 */ }
  }
}

interface MpegDecoder {
  ready: Promise<void>;
  decode(b: Uint8Array): { channelData: Float32Array[]; sampleRate: number };
  free(): void;
}

/** 오디오 전사 함수를 만들 때 쓰는 최소 계약(desktop/stt.ts의 SttEngine이 이 모양을 만족한다). */
export interface AudioTranscriber {
  transcribe(
    audio: ArrayBuffer | Uint8Array | Float32Array,
    opts?: { sampleRate?: number; language?: string },
  ): Promise<{ ok: true; text: string; ms: number } | { error: string }>;
}

/**
 * 오디오 바이트 → 전사 텍스트. wav는 SttEngine이 직접 풀고(toPcm16k의 RIFF 경로),
 * mp3는 여기서 PCM으로 푼 뒤 넘긴다. m4a/aac는 상위 디스패치가 이미 걸러낸다.
 * SttEngine은 never-throw 규약({ok}|{error})이라 error면 예외로 올려 호출부가 건너뜀 처리하게 한다.
 */
export function makeAudioText(stt: AudioTranscriber, language?: string) {
  return async (bytes: Uint8Array, ext: string): Promise<string> => {
    if (ext === '.mp3') {
      const pcm = await decodeMp3(bytes);
      const r = await stt.transcribe(pcm.samples, { sampleRate: pcm.sampleRate, language });
      if ('error' in r) throw new Error(r.error);
      return r.text;
    }
    const r = await stt.transcribe(bytes, { language });
    if ('error' in r) throw new Error(r.error);
    return r.text;
  };
}
