import { useEffect, useRef, useState } from 'react';
import { STT_SAMPLE_RATE, toMono16k } from '../stt-audio';
import { T } from '../i18n';

// 음성 입력 버튼(입력바 2행 왼쪽) — 데스크톱 전용(로컬 Whisper). 브라우저엔 preload가 없어 숨는다.
//
// 흐름: 클릭 → (모델 미준비면) 진행률 표시하며 내려받기(76MB, 최초 1회) → 녹음 → 다시 클릭하면 중지
//      → 전사 → 결과 텍스트를 입력창에 "삽입"(전송은 하지 않는다 — 사용자가 읽고 고칠 수 있게).
//
// ⚠️ 오디오 형식: MediaRecorder의 webm/opus를 그대로 보내면 메인이 못 푼다(preload 주석). 반드시
//    stt-audio.ts의 toMono16k(16kHz 모노 Float32 PCM)를 거친다.
//
// 실패는 전부 안내로 끝낸다(무반응 금지): 마이크 미지원 환경(Electron file://에서 getUserMedia가
// 아예 없을 수 있다)·권한 거부·모델 준비 실패·전사 실패.

type MicState = 'idle' | 'loading' | 'recording' | 'transcribing';

export function MicButton({ onText }: { onText: (text: string) => void }) {
  const [state, setState] = useState<MicState>('idle');
  const [percent, setPercent] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      // 언마운트 시 마이크를 붙잡고 있지 않게(OS 녹음 표시가 계속 켜져 있으면 안 된다).
      try { recorderRef.current?.stop(); } catch { /* 이미 멈춤 */ }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const api = typeof window !== 'undefined' ? window.engramDesktop : undefined;
  if (!api?.sttAvailable) return null; // 데스크톱 아님 — 눌러도 아무 일 없는 버튼을 두지 않는다

  const releaseMic = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const transcribe = async () => {
    const type = recorderRef.current?.mimeType || 'audio/webm';
    const blob = new Blob(chunksRef.current, { type });
    chunksRef.current = [];
    releaseMic();
    try {
      const pcm = await toMono16k(blob);
      const r = await api.sttTranscribe?.(pcm, { sampleRate: STT_SAMPLE_RATE });
      if (!aliveRef.current) return;
      if (!r || 'error' in r) { setNotice(T.micFailed); return; }
      const text = r.text.trim();
      if (!text) { setNotice(T.micEmpty); return; }
      onText(text);
    } catch {
      if (aliveRef.current) setNotice(T.micFailed);
    } finally {
      if (aliveRef.current) setState('idle');
    }
  };

  const start = async () => {
    setNotice(null);
    // 1) 모델 준비(최초 1회 76MB) — 진행률을 버튼 옆에 퍼센트로.
    const avail = await api.sttAvailable?.();
    if (!aliveRef.current) return;
    if (avail && !avail.ready) {
      setState('loading');
      setPercent(0);
      const un = api.onSttProgress?.((p) => { if (aliveRef.current) setPercent(Math.round(p.percent)); });
      const r = await api.sttEnsureModel?.();
      un?.();
      if (!aliveRef.current) return;
      if (!r || 'error' in r) { setState('idle'); setNotice(T.micModelFailed); return; }
    }
    // 2) 마이크. Electron file://처럼 getUserMedia 자체가 없는 환경이 있다 — 조용히 죽지 않게 안내.
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!media?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setState('idle'); setNotice(T.micUnavailable); return;
    }
    let stream: MediaStream;
    try {
      stream = await media.getUserMedia({ audio: true });
    } catch {
      if (aliveRef.current) { setState('idle'); setNotice(T.micDenied); }
      return;
    }
    if (!aliveRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
    streamRef.current = stream;
    chunksRef.current = [];
    const rec = new MediaRecorder(stream);
    recorderRef.current = rec;
    rec.ondataavailable = (e: BlobEvent) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = () => { void transcribe(); };
    rec.start();
    setState('recording');
  };

  const stop = () => {
    setState('transcribing');
    try { recorderRef.current?.stop(); } catch { setState('idle'); releaseMic(); }
  };

  const busy = state === 'loading' || state === 'transcribing';
  const title = state === 'recording' ? T.micStop
    : state === 'loading' ? T.micDownloading(percent)
      : state === 'transcribing' ? T.micTranscribing
        : T.micTitle;

  return (
    <>
      <button type="button" className={'micBtn' + (state === 'recording' ? ' recording' : '')}
        title={title} disabled={busy}
        onClick={() => { if (state === 'recording') stop(); else if (!busy) void start(); }}>
        {state === 'recording' ? '●' : '🎤'}
      </button>
      {state === 'loading' && <span className="micNotice">{T.micDownloading(percent)}</span>}
      {state === 'transcribing' && <span className="micNotice">{T.micTranscribing}</span>}
      {notice && state === 'idle' && (
        <span className="micNotice error" onClick={() => setNotice(null)}>{notice}</span>
      )}
    </>
  );
}
