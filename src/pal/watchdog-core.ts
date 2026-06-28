import * as fs from 'fs';

// heartbeat 파일에서 epoch ms를 읽는다. 없거나 깨지면 null.
export function readHeartbeat(filePath: string): number | null {
  try {
    const n = Number(fs.readFileSync(filePath, 'utf8').trim());
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

// 마지막 박동이 staleMs보다 오래됐으면 멈춤(stale). lastBeat null(부팅 직후)은 유예 → false.
export function isStale(now: number, lastBeat: number | null, staleMs: number): boolean {
  if (lastBeat === null) return false;
  return now - lastBeat > staleMs;
}
