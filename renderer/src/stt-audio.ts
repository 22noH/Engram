// 음성 입력(STT) 오디오 변환 — 렌더러가 녹음한 것을 메인(로컬 Whisper)이 먹을 수 있는 형태로 푼다.
//
// 백엔드 계약(src/desktop/chat-preload.ts 주석 verbatim): "오디오는 16kHz 모노 Float32 PCM의
// ArrayBuffer로 보내는 것을 권장한다(Web Audio로 디코드+리샘플: decodeAudioData →
// OfflineAudioContext(1, len, 16000) → getChannelData(0).buffer). MediaRecorder의 webm/opus 원본을
// 그대로 보내면 안 된다(메인엔 그걸 풀 디코더가 없다)."
// → 이 파일이 그 변환 하나만 담당한다(순수 함수에 가깝게 뽑아 테스트로 못박기 위함).

export const STT_SAMPLE_RATE = 16000;

// 녹음 Blob(webm/opus 등 브라우저가 준 컨테이너) → 모노 16kHz Float32 PCM ArrayBuffer.
// 실패(디코드 불가·Web Audio 미지원)는 던진다 — 호출부(MicButton)가 안내로 잡는다.
export async function toMono16k(blob: Blob): Promise<ArrayBuffer> {
  const Ctx: typeof AudioContext | undefined =
    (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext
    ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const Offline: typeof OfflineAudioContext | undefined =
    (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Ctx || !Offline) throw new Error('web-audio-unavailable');

  const bytes = await blob.arrayBuffer();
  const ctx = new Ctx();
  try {
    // decodeAudioData는 넘긴 ArrayBuffer를 detach할 수 있어(구현 의존) 사본을 준다.
    const decoded = await ctx.decodeAudioData(bytes.slice(0));
    const frames = Math.max(1, Math.ceil(decoded.duration * STT_SAMPLE_RATE));
    const off = new Offline(1, frames, STT_SAMPLE_RATE);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    const pcm = rendered.getChannelData(0);
    // 뷰가 아니라 정확히 그 구간만 담은 새 ArrayBuffer로 넘긴다(구조화 복제로 IPC를 건널 것).
    return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
  } finally {
    // close()가 없는(또는 실패하는) 구현도 있으니 조용히 무시 — 변환 결과에 영향 없음.
    try { await ctx.close?.(); } catch { /* 무시 */ }
  }
}
