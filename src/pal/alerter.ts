import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

export interface AlertConfig { webhookUrl?: string; command?: string }

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean }>;
type SpawnFn = (cmd: string, args: string[]) => { on(event: string, cb: (code: number) => void): void };

// config/alert.json 로드. 없거나 깨지면 빈 설정(알림은 로깅 폴백 — 호출자 책임).
export function loadAlertConfig(configDir: string): AlertConfig {
  try { return JSON.parse(fs.readFileSync(path.join(configDir, 'alert.json'), 'utf8')) as AlertConfig; }
  catch { return {}; }
}

// 외부 알림 발사(spec B4). webhook POST + command spawn 중 설정된 것만. 둘 다 없으면 no-op.
// deps: 테스트에서 fetch/spawn 목 주입(기본은 전역 fetch·child_process.spawn).
export async function sendAlert(
  cfg: AlertConfig,
  event: string,
  message: string,
  deps: { fetchFn?: FetchFn; spawnFn?: SpawnFn } = {},
): Promise<void> {
  const ts = new Date().toISOString();
  if (cfg.webhookUrl) {
    const fetchFn = deps.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
    try {
      await fetchFn(cfg.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event, message, ts }),
      });
    } catch { /* 알림 실패가 호출자를 죽이지 않게(고정 장애일 수 있음) */ }
  }
  if (cfg.command) {
    const spawnFn = deps.spawnFn ?? ((c: string, a: string[]) => spawn(c, a, { shell: true }));
    await new Promise<void>((resolve) => {
      try {
        const child = spawnFn(cfg.command!, [event, message]);
        child.on('exit', () => resolve());
        child.on('error', () => resolve());
      } catch { resolve(); }
    });
  }
}
