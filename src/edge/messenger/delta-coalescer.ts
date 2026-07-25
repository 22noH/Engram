// 답변 실시간 스트리밍 — 델타 코얼레서.
// 두뇌의 onChunk는 토큰 단위(수 바이트씩)로 쏟아진다. 그대로 ws 프레임 1개씩 내보내면 긴 답 하나에
// 수천 프레임이 나가는 폭주다. 짧은 간격(기본 60ms) 동안 모아 한 번에 흘려보내고, 그 사이 버퍼가
// 길어지면(기본 320자) 간격을 안 기다리고 즉시 흘린다(긴 답에서 체감 지연이 생기지 않게).
//
// stop()은 "대기 중인 버퍼를 버린다" — 흘리지 않는다. 턴이 끝나면 곧바로 최종 'msg' 프레임이 확정
// 메시지를 싣고 오고 렌더러는 그 시점에 누적 버퍼를 통째로 버리므로, 꼬리 조각을 마저 보내봐야
// 렌더러가 무시할 뿐이고(activity의 "awaiting 중일 때만" 규칙과 동형) 늦은 프레임만 늘어난다.

export interface DeltaCoalescer {
  push(text: string): void;
  stop(): void;
}

export const DELTA_INTERVAL_MS = 60;
export const DELTA_MAX_CHARS = 320;

export function createDeltaCoalescer(
  sink: (text: string) => void,
  opts: { intervalMs?: number; maxChars?: number } = {},
): DeltaCoalescer {
  const intervalMs = opts.intervalMs ?? DELTA_INTERVAL_MS;
  const maxChars = opts.maxChars ?? DELTA_MAX_CHARS;
  let buf = '';
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
  };
  const flush = (): void => {
    clearTimer();
    if (!buf) return;
    const out = buf;
    buf = '';
    // never-throw: UI 브로드캐스트 실패가 두뇌 스트림(=답변 생성)을 끊으면 안 된다(activity와 동일 원칙).
    try { sink(out); } catch { /* 격리 */ }
  };

  return {
    push(text: string): void {
      if (!text) return;
      buf += text;
      if (buf.length >= maxChars) { flush(); return; }
      if (timer) return;
      timer = setTimeout(flush, intervalMs);
      // 상주 프로세스/테스트 러너 종료를 이 타이머가 붙잡지 않게(Node 전용 API라 옵셔널 호출).
      (timer as unknown as { unref?: () => void }).unref?.();
    },
    stop(): void {
      clearTimer();
      buf = '';
    },
  };
}
