import * as fs from 'fs';
import * as path from 'path';
import { readHeartbeat, isStale } from '../pal/watchdog-core';

// 설정창 상태 표시용 판정(스펙 §4). 신규 IPC 없이 기존 heartbeat 파일(내용=epoch ms)을 재사용한다.
export interface DesktopStatus {
  alive: boolean;
  lastBeat: number | null;
  modelCacheReady: boolean;
}

// heartbeat 주기(60초)의 3배를 생존 한계로 본다.
const STALE_MS = 3 * 60_000;

export function readStatus(dataDir: string, now: number): DesktopStatus {
  const lastBeat = readHeartbeat(path.join(dataDir, 'state', 'heartbeat'));
  // watchdog의 isStale은 부팅 유예로 null→false지만, 표시용은 박동 없음=죽음으로 본다.
  const alive = lastBeat !== null && !isStale(now, lastBeat, STALE_MS);
  let modelCacheReady = false;
  try {
    modelCacheReady = fs.readdirSync(path.join(dataDir, 'models')).length > 0;
  } catch {
    // 폴더 없음 = 미준비
  }
  return { alive, lastBeat, modelCacheReady };
}
