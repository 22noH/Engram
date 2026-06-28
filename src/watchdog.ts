import { PathResolver } from './pal/path-resolver';
import { isStale, readHeartbeat } from './pal/watchdog-core';
import { loadAlertConfig, sendAlert } from './pal/alerter';
import * as fs from 'fs';

// 초경량 감시자(설계 §10.2). Nest·두뇌 0. heartbeat 폴링 → 멈춤 시 상주 강제종료(→OS 서비스 재시작) + 외부 알림.
// 빠른 재시도 1~2회 후 즉시 알림(고정 장애는 재시도로 안 고쳐짐).

function envMs(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const POLL_MS = envMs('ENGRAM_WATCHDOG_POLL_MS', 30_000);
const STALE_MS = envMs('ENGRAM_WATCHDOG_STALE_MS', 180_000);

async function tick(paths: PathResolver, configDir: string, strikes: { n: number }): Promise<void> {
  const last = readHeartbeat(paths.getHeartbeatPath());
  if (!isStale(Date.now(), last, STALE_MS)) { strikes.n = 0; return; }
  strikes.n++;
  if (strikes.n < 2) return; // 빠른 재시도 1회 유예(일시적 일시정지 흡수)
  // 멈춘 상주 강제종료 → OS 서비스가 재시작
  // ponytail: PID 재사용 위험 수용 — pid 파일이 죽은 프로세스의 것이고 그 PID가
  // 폴링 주기 내에 재할당되면 무관 프로세스를 kill할 수 있다. 상주 재시작 빈도가
  // 낮아 실용 위험 낮음 + try/catch로 격리. 강화 필요시 OS별 프로세스명 검증.
  try {
    const pid = Number(fs.readFileSync(paths.getPidPath(), 'utf8').trim());
    if (Number.isFinite(pid)) process.kill(pid, 'SIGKILL');
  } catch { /* pid 없음/이미 죽음 */ }
  await sendAlert(loadAlertConfig(configDir), 'engram-down', `심장박동 ${STALE_MS}ms 이상 끊김 — 강제종료·재시작 시도`);
  strikes.n = 0;
}

async function main(): Promise<void> {
  const paths = new PathResolver();
  const configDir = paths.getConfigDir();
  const strikes = { n: 0 };
  process.stderr.write(`watchdog 시작 (poll ${POLL_MS}ms, stale ${STALE_MS}ms)\n`);
  // 단순 무한 루프(setInterval 누적 회피 — 한 틱 끝나고 다음 대기).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await tick(paths, configDir, strikes);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

void main();
