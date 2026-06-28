# Phase 5B — 운영(PAL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Engram을 24/7 안 죽게: OS 서비스 등록(Windows·Linux·macOS) + 심장박동 + 멈춤 감지 감시자 + 설정형 외부 알림 + 메모리 위생 감시.

**Architecture:** 상주 Engram이 1분마다 심장박동 파일을 갱신하고, 별도 초경량 watchdog 프로세스가 그 파일을 폴링해 멈추면 강제종료(→OS 서비스가 재시작) + 외부 알림. OS 서비스 등록은 포트+3어댑터(node-windows / systemd / launchd)로 추상화. 메모리 추세는 상주 내부 모니터가 감시.

**Tech Stack:** NestJS · TypeScript · Jest · `node-windows`(신규 의존성, Windows 한정) · Node 22 내장 `fetch`·`child_process`·`v8`.

**상위 기준선:** [spec](../specs/2026-06-28-phase5-insightlayer-pal-design.md) §3 · [DESIGN.md](../../DESIGN.md) §10

## Global Constraints

- **신규 의존성은 `node-windows` 하나만**(Windows 서비스 호스팅 전용, spec B2). 그 외는 stdlib.
- 모든 사용자 대면 문구는 한국어.
- **감시자(watchdog)는 Nest·DI·두뇌·임베더 0** — `fs`·`http`/`fetch`·`child_process`만(spec B3, 설계 §10.2 "거의 안 죽게").
- HeartbeatEmitter·MemoryMonitor는 상주(main.ts)에서만 실질 발화 — `@Interval`이라 cli.ts 원샷은 종료 전 미발화(기존 스케줄러와 동일 성질).
- **검증 한계(spec B1·§3.7)**: 유닛파일·plist 생성과 명령 문자열은 이 머신서 단위테스트. **Linux/macOS의 실제 `systemctl`/`launchctl` 동작은 해당 OS에서 사용자가 수동 검증.** Windows는 이 머신서 수동 검증 가능.
- 알림 채널은 코어 중립: `config/alert.json` `{webhookUrl?, command?}` 설정형(spec B4).

---

### Task 1: Alerter — 설정형 외부 알림(공유)

**Files:**
- Create: `src/pal/alerter.ts`
- Test: `src/pal/alerter.spec.ts`

**Interfaces:**
- Consumes: `config/alert.json` 경로(`PathResolver.getConfigDir`), Node 22 `fetch`, `child_process.spawn`.
- Produces:
  - `interface AlertConfig { webhookUrl?: string; command?: string }`
  - `loadAlertConfig(configDir: string): AlertConfig` (없으면 `{}`)
  - `sendAlert(cfg: AlertConfig, event: string, message: string, deps?: { fetchFn?, spawnFn? }): Promise<void>` — webhook POST + command spawn(있는 것만). 둘 다 없으면 no-op(호출자가 로깅).

> **설계**: watchdog(Nest 없음)과 상주(MemoryMonitor)가 같은 순수 함수를 공유하므로 Alerter는 **DI 클래스가 아니라 순수 함수 모듈**. `deps` 주입으로 fetch/spawn을 테스트에서 목.

- [ ] **Step 1: 실패 테스트**

`src/pal/alerter.spec.ts`:

```ts
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { loadAlertConfig, sendAlert } from './alerter';

describe('alerter', () => {
  it('config 없으면 빈 설정', () => {
    expect(loadAlertConfig(path.join(os.tmpdir(), 'no-such-dir-xyz'))).toEqual({});
  });

  it('alert.json을 읽는다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-'));
    fs.writeFileSync(path.join(dir, 'alert.json'), JSON.stringify({ webhookUrl: 'http://x', command: 'notify' }));
    expect(loadAlertConfig(dir)).toEqual({ webhookUrl: 'http://x', command: 'notify' });
  });

  it('webhookUrl 있으면 POST한다', async () => {
    const calls: any[] = [];
    const fetchFn = async (url: string, init: any) => { calls.push({ url, init }); return { ok: true } as any; };
    await sendAlert({ webhookUrl: 'http://hook' }, 'down', '멈춤', { fetchFn });
    expect(calls[0].url).toBe('http://hook');
    expect(JSON.parse(calls[0].init.body).event).toBe('down');
  });

  it('command 있으면 spawn한다', async () => {
    const spawned: string[] = [];
    const spawnFn = (cmd: string) => { spawned.push(cmd); return { on: (_: string, cb: any) => cb(0) } as any; };
    await sendAlert({ command: 'notify-send' }, 'down', '멈춤', { spawnFn });
    expect(spawned[0]).toContain('notify-send');
  });

  it('둘 다 없으면 조용히 통과(no-op)', async () => {
    await expect(sendAlert({}, 'down', 'x')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest alerter`
Expected: FAIL — `Cannot find module './alerter'`

- [ ] **Step 3: 구현**

`src/pal/alerter.ts`:

```ts
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
```

> 주의: 테스트의 `spawnFn` 목은 `on('exit'|'error', cb)` 중 하나만 부르면 됨 — 위 목은 즉시 `cb(0)`. 구현은 `exit`·`error` 양쪽 리스너를 걸므로 목이 둘 중 무엇을 부르든 resolve.

- [ ] **Step 4: 통과 확인**

Run: `npx jest alerter`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/pal/alerter.ts src/pal/alerter.spec.ts
git commit -m "feat(phase5b): Alerter — 설정형 webhook/명령 외부 알림(공유 순수함수)"
```

---

### Task 2: HeartbeatEmitter — 심장박동 + pid 파일

**Files:**
- Create: `src/pal/heartbeat.ts`
- Test: `src/pal/heartbeat.spec.ts`
- Modify: `src/pal/path-resolver.ts` (경로 헬퍼 2개)

**Interfaces:**
- Consumes: `PathResolver.getStateDir`.
- Produces:
  - `PathResolver.getHeartbeatPath(): string` → `<data>/state/heartbeat`
  - `PathResolver.getPidPath(): string` → `<data>/state/engram.pid`
  - `HeartbeatEmitter.beat(): void` (현재 epoch ms + pid 기록) — `@Interval(60_000)` 등록.

- [ ] **Step 1: 경로 헬퍼 + beat 실패 테스트**

`src/pal/heartbeat.spec.ts`:

```ts
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { HeartbeatEmitter } from './heartbeat';
import { PathResolver } from './path-resolver';

describe('HeartbeatEmitter', () => {
  it('beat은 heartbeat에 최근 시각을, pid 파일에 현재 pid를 쓴다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
    const paths = new PathResolver(dir);
    const before = Date.now();
    new HeartbeatEmitter(paths).beat();
    const beat = Number(fs.readFileSync(paths.getHeartbeatPath(), 'utf8').trim());
    const pid = Number(fs.readFileSync(paths.getPidPath(), 'utf8').trim());
    expect(beat).toBeGreaterThanOrEqual(before);
    expect(pid).toBe(process.pid);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest heartbeat`
Expected: FAIL — `Cannot find module './heartbeat'`

- [ ] **Step 3: 경로 헬퍼 추가**

`src/pal/path-resolver.ts`의 `getInsightsDir()`(Phase 5A) 아래 또는 `getStateDir()` 근처에 추가:

```ts
  // 상주 생존신호(Phase 5 PAL §3.4). watchdog이 이 파일의 갱신 시각을 폴링한다.
  getHeartbeatPath(): string {
    return path.join(this.getStateDir(), 'heartbeat');
  }

  // 상주 프로세스 PID(watchdog이 멈춤 시 강제종료 대상 식별).
  getPidPath(): string {
    return path.join(this.getStateDir(), 'engram.pid');
  }
```

> Phase 5A를 먼저 안 했어도 무방 — `getInsightsDir`가 없으면 `getStateDir()` 아래에 위 두 메서드만 추가.

- [ ] **Step 4: HeartbeatEmitter 구현**

`src/pal/heartbeat.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { PathResolver } from './path-resolver';

// 상주 생존신호(설계 §10.2). 1분마다 heartbeat 파일을 갱신 + pid 기록.
// @Interval이라 cli.ts 원샷(빠른 종료)에선 미발화 — 상주(main.ts)에서만 실질 동작.
@Injectable()
export class HeartbeatEmitter {
  constructor(private readonly paths: PathResolver) {}

  @Interval(60_000)
  beat(): void {
    const dir = this.paths.getStateDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.paths.getHeartbeatPath(), String(Date.now()));
    fs.writeFileSync(this.paths.getPidPath(), String(process.pid));
  }
}
```

- [ ] **Step 5: 통과 확인 + 커밋**

Run: `npx jest heartbeat path-resolver`
Expected: PASS

```bash
git add src/pal/heartbeat.ts src/pal/heartbeat.spec.ts src/pal/path-resolver.ts
git commit -m "feat(phase5b): HeartbeatEmitter — 상주 생존신호 + pid 파일"
```

---

### Task 3: watchdog — 멈춤 감지 + 강제종료 + 알림(독립 프로세스)

**Files:**
- Create: `src/pal/watchdog-core.ts` (순수 판정 로직)
- Create: `src/watchdog.ts` (진입점 — Nest 없음)
- Test: `src/pal/watchdog-core.spec.ts`

**Interfaces:**
- Consumes: heartbeat 파일, `sendAlert`/`loadAlertConfig`(T1).
- Produces:
  - `isStale(now: number, lastBeat: number | null, staleMs: number): boolean`
  - `readHeartbeat(filePath: string): number | null`
  - `src/watchdog.ts` 진입점: 폴링 루프(빠른 재시도 1~2회 후 알림).

> watchdog.ts 자체(무한 루프·process.kill)는 단위테스트 안 함 — **판정 로직(`isStale`·`readHeartbeat`)만 테스트**, 루프는 그 위의 얇은 배선(spec §3.7).

- [ ] **Step 1: 실패 테스트**

`src/pal/watchdog-core.spec.ts`:

```ts
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { isStale, readHeartbeat } from './watchdog-core';

describe('watchdog-core', () => {
  it('heartbeat 없으면 null', () => {
    expect(readHeartbeat(path.join(os.tmpdir(), 'no-hb-xyz'))).toBeNull();
  });

  it('heartbeat 값을 숫자로 읽는다', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wd-')), 'hb');
    fs.writeFileSync(f, '1700000000000');
    expect(readHeartbeat(f)).toBe(1700000000000);
  });

  it('lastBeat이 staleMs보다 오래되면 stale', () => {
    expect(isStale(1000_000, 800_000, 180_000)).toBe(true);   // 200s 경과 > 180s
    expect(isStale(1000_000, 900_000, 180_000)).toBe(false);  // 100s 경과 < 180s
  });

  it('lastBeat null(아직 없음)은 stale 아님(부팅 유예)', () => {
    expect(isStale(1000_000, null, 180_000)).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest watchdog-core`
Expected: FAIL — `Cannot find module './watchdog-core'`

- [ ] **Step 3: 판정 로직 구현**

`src/pal/watchdog-core.ts`:

```ts
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
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest watchdog-core`
Expected: PASS

- [ ] **Step 5: watchdog 진입점 구현(루프 배선 — 단위테스트 없음)**

`src/watchdog.ts`:

```ts
import { PathResolver } from './pal/path-resolver';
import { isStale, readHeartbeat } from './pal/watchdog-core';
import { loadAlertConfig, sendAlert } from './pal/alerter';
import * as fs from 'fs';

// 초경량 감시자(설계 §10.2). Nest·두뇌 0. heartbeat 폴링 → 멈춤 시 상주 강제종료(→OS 서비스 재시작) + 외부 알림.
// 빠른 재시도 1~2회 후 즉시 알림(고정 장애는 재시도로 안 고쳐짐).
const POLL_MS = Number(process.env.ENGRAM_WATCHDOG_POLL_MS ?? 30_000);
const STALE_MS = Number(process.env.ENGRAM_WATCHDOG_STALE_MS ?? 180_000);

async function tick(paths: PathResolver, configDir: string, strikes: { n: number }): Promise<void> {
  const last = readHeartbeat(paths.getHeartbeatPath());
  if (!isStale(Date.now(), last, STALE_MS)) { strikes.n = 0; return; }
  strikes.n++;
  if (strikes.n < 2) return; // 빠른 재시도 1회 유예(일시적 일시정지 흡수)
  // 멈춘 상주 강제종료 → OS 서비스가 재시작
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
```

- [ ] **Step 6: 빌드 확인 + 커밋**

Run: `npx tsc --noEmit`
Expected: 타입 에러 0

```bash
git add src/pal/watchdog-core.ts src/pal/watchdog-core.spec.ts src/watchdog.ts
git commit -m "feat(phase5b): watchdog — 멈춤 감지·강제종료·알림(독립 경량 프로세스)"
```

---

### Task 4: MemoryMonitor — 메모리 추세·임계치·heap 스냅샷

**Files:**
- Create: `src/pal/memory-monitor.ts`
- Test: `src/pal/memory-monitor.spec.ts`

**Interfaces:**
- Consumes: `process.memoryUsage`, `v8.writeHeapSnapshot`, `sendAlert`/`loadAlertConfig`(T1), `PathResolver`·`PinoLogger`.
- Produces:
  - `isOverLimit(rssBytes: number, limitMb: number): boolean`
  - `MemoryMonitor.sample(): void` — `@Interval`, 임계치 초과 시 알림 + heap 스냅샷(쿨다운 1회).

- [ ] **Step 1: 실패 테스트**

`src/pal/memory-monitor.spec.ts`:

```ts
import * as os from 'os';
import { isOverLimit, MemoryMonitor } from './memory-monitor';
import { PathResolver } from './path-resolver';
import { PinoLogger } from './logger';

describe('memory-monitor', () => {
  it('isOverLimit은 MB 임계치를 바이트와 비교', () => {
    expect(isOverLimit(600 * 1024 * 1024, 512)).toBe(true);
    expect(isOverLimit(100 * 1024 * 1024, 512)).toBe(false);
  });

  it('임계치 초과 시 알림을 1회 발사하고 쿨다운한다', async () => {
    const paths = new PathResolver(os.tmpdir());
    const logger = new PinoLogger(paths);
    const alerts: string[] = [];
    // rss를 강제로 큰 값으로, 알림/스냅샷은 목으로 주입
    const m = new MemoryMonitor(paths, logger, {
      limitMb: 1,                                   // 1MB → 항상 초과
      rssFn: () => 999 * 1024 * 1024,
      alertFn: async (_e, msg) => { alerts.push(msg); },
      snapshotFn: () => '/tmp/heap.x',
    });
    m.sample();
    m.sample(); // 쿨다운 — 두 번째는 알림 안 함
    await new Promise((r) => setTimeout(r, 0));
    expect(alerts).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest memory-monitor`
Expected: FAIL — `Cannot find module './memory-monitor'`

- [ ] **Step 3: 구현**

`src/pal/memory-monitor.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import * as path from 'path';
import * as v8 from 'v8';
import { PathResolver } from './path-resolver';
import { PinoLogger } from './logger';
import { loadAlertConfig, sendAlert } from './alerter';

export function isOverLimit(rssBytes: number, limitMb: number): boolean {
  return rssBytes > limitMb * 1024 * 1024;
}

interface MemoryMonitorDeps {
  limitMb?: number;
  rssFn?: () => number;
  alertFn?: (event: string, message: string) => Promise<void>;
  snapshotFn?: () => string;
}

// 메모리 위생 감시(설계 §10.3). rss가 임계치 초과하면 알림 + heap 스냅샷(원인 특정). 쿨다운으로 폭주 방지.
// ponytail: 단순 임계치 — 정교한 누수 분석은 스냅샷을 사람이 본다.
@Injectable()
export class MemoryMonitor {
  private readonly limitMb: number;
  private readonly rssFn: () => number;
  private readonly alertFn: (event: string, message: string) => Promise<void>;
  private readonly snapshotFn: () => string;
  private alerted = false;

  constructor(private readonly paths: PathResolver, private readonly logger: PinoLogger, deps: MemoryMonitorDeps = {}) {
    this.limitMb = deps.limitMb ?? Number(process.env.ENGRAM_RSS_LIMIT_MB ?? 1024);
    this.rssFn = deps.rssFn ?? (() => process.memoryUsage().rss);
    this.alertFn = deps.alertFn ?? ((e, m) => sendAlert(loadAlertConfig(paths.getConfigDir()), e, m));
    this.snapshotFn = deps.snapshotFn ?? (() => v8.writeHeapSnapshot(path.join(paths.getLogsDir(), `heap-${Date.now()}.heapsnapshot`)));
  }

  @Interval(5 * 60_000)
  sample(): void {
    const rss = this.rssFn();
    if (!isOverLimit(rss, this.limitMb)) { this.alerted = false; return; } // 정상 복귀 시 쿨다운 해제
    if (this.alerted) return;                                              // 이미 알림 — 쿨다운
    this.alerted = true;
    const mb = Math.round(rss / 1024 / 1024);
    let snap = '(스냅샷 생략)';
    try { snap = this.snapshotFn(); } catch (e) { this.logger.warn(`heap 스냅샷 실패: ${String(e)}`, 'MemoryMonitor'); }
    this.logger.warn(`메모리 임계치 초과: rss ${mb}MB > ${this.limitMb}MB. 스냅샷: ${snap}`, 'MemoryMonitor');
    void this.alertFn('memory-high', `rss ${mb}MB가 임계치 ${this.limitMb}MB 초과. heap 스냅샷: ${snap}`);
  }
}
```

- [ ] **Step 4: 통과 확인 + 커밋**

Run: `npx jest memory-monitor`
Expected: PASS

```bash
git add src/pal/memory-monitor.ts src/pal/memory-monitor.spec.ts
git commit -m "feat(phase5b): MemoryMonitor — rss 임계치 알림 + heap 스냅샷(쿨다운)"
```

---

### Task 5: SupervisorPort + 팩토리(플랫폼 선택)

**Files:**
- Create: `src/pal/supervisor/supervisor.port.ts`
- Create: `src/pal/supervisor/supervisor.factory.ts`
- Test: `src/pal/supervisor/supervisor.factory.spec.ts`

**Interfaces:**
- Produces:
  - `interface SupervisorPort { install(): Promise<void>; uninstall(): Promise<void>; start(): Promise<void>; stop(): Promise<void>; status(): Promise<'running'|'stopped'|'not-installed'> }`
  - `interface ServiceSpec { name: string; scriptPath: string; dataDir: string }`
  - `createSupervisor(platform: NodeJS.Platform, spec: ServiceSpec): SupervisorPort` — `win32`/`linux`/`darwin` 선택, 그 외 throw.

> T5는 포트·팩토리·throw 분기만. 어댑터 본체는 T6~T8. 팩토리 테스트는 미지원 플랫폼 throw만 검증(어댑터 생성은 T6~T8 완료 후 import).

- [ ] **Step 1: 포트 정의(테스트 불요 — 타입만)**

`src/pal/supervisor/supervisor.port.ts`:

```ts
export type ServiceStatus = 'running' | 'stopped' | 'not-installed';

// OS 서비스 등록 추상(설계 §10.1). OS별 어댑터가 구현.
export interface SupervisorPort {
  install(): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<ServiceStatus>;
}

// 서비스 등록에 필요한 정보. CLI가 채워 팩토리에 넘긴다.
export interface ServiceSpec {
  name: string;        // 서비스 이름(예: 'Engram')
  scriptPath: string;  // 상주 진입점 절대경로(dist/src/main.js)
  dataDir: string;     // ENGRAM_DATA_DIR로 주입할 데이터 루트
}
```

- [ ] **Step 2: 팩토리 실패 테스트**

`src/pal/supervisor/supervisor.factory.spec.ts`:

```ts
import { createSupervisor } from './supervisor.factory';

const spec = { name: 'Engram', scriptPath: '/app/main.js', dataDir: '/data' };

describe('createSupervisor', () => {
  it('지원 플랫폼은 SupervisorPort를 반환', () => {
    for (const p of ['win32', 'linux', 'darwin'] as NodeJS.Platform[]) {
      const s = createSupervisor(p, spec);
      expect(typeof s.install).toBe('function');
      expect(typeof s.status).toBe('function');
    }
  });

  it('미지원 플랫폼은 명확히 throw', () => {
    expect(() => createSupervisor('aix' as NodeJS.Platform, spec)).toThrow(/미지원/);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx jest supervisor.factory`
Expected: FAIL — `Cannot find module './supervisor.factory'` (그리고 어댑터 import 미존재)

- [ ] **Step 4: 팩토리 구현(어댑터는 T6~T8에서 채워짐 — 스텁 먼저)**

먼저 T6~T8 어댑터 파일을 빈 클래스로 스텁 생성(각 Task에서 본체 구현):

`src/pal/supervisor/windows-supervisor.ts`, `linux-supervisor.ts`, `macos-supervisor.ts` 각각:

```ts
import { SupervisorPort, ServiceStatus, ServiceSpec } from './supervisor.port';
export class WindowsSupervisor implements SupervisorPort {  // (Linux/Macos는 이름만 교체)
  constructor(private readonly spec: ServiceSpec) {}
  async install(): Promise<void> { throw new Error('미구현(T6)'); }
  async uninstall(): Promise<void> { throw new Error('미구현'); }
  async start(): Promise<void> { throw new Error('미구현'); }
  async stop(): Promise<void> { throw new Error('미구현'); }
  async status(): Promise<ServiceStatus> { return 'not-installed'; }
}
```

`src/pal/supervisor/supervisor.factory.ts`:

```ts
import { SupervisorPort, ServiceSpec } from './supervisor.port';
import { WindowsSupervisor } from './windows-supervisor';
import { LinuxSupervisor } from './linux-supervisor';
import { MacosSupervisor } from './macos-supervisor';

// process.platform으로 OS 어댑터 선택(설계 §10.1). OS별로 갈리는 유일한 코드.
export function createSupervisor(platform: NodeJS.Platform, spec: ServiceSpec): SupervisorPort {
  switch (platform) {
    case 'win32': return new WindowsSupervisor(spec);
    case 'linux': return new LinuxSupervisor(spec);
    case 'darwin': return new MacosSupervisor(spec);
    default: throw new Error(`미지원 플랫폼: ${platform} (Windows·Linux·macOS만 지원)`);
  }
}
```

- [ ] **Step 5: 통과 확인 + 커밋**

Run: `npx jest supervisor.factory && npx tsc --noEmit`
Expected: PASS, 타입 0

```bash
git add src/pal/supervisor/
git commit -m "feat(phase5b): SupervisorPort + 플랫폼 팩토리 + 어댑터 스텁"
```

---

### Task 6: Windows 어댑터 (node-windows)

**Files:**
- Modify: `package.json` (`node-windows` 의존성)
- Create: `src/types/node-windows.d.ts` (타입 미제공 시 최소 선언)
- Modify: `src/pal/supervisor/windows-supervisor.ts` (본체)
- Test: `src/pal/supervisor/windows-supervisor.spec.ts` (인자 구성 — node-windows 목)

**Interfaces:**
- Consumes: `node-windows` `Service`, `ServiceSpec`(T5).
- Produces: `WindowsSupervisor`가 SCM에 상주 스크립트 등록.

> **검증**: install/start의 실제 SCM 동작은 **이 머신서 수동 검증**(관리자 권한 필요). 단위테스트는 node-windows `Service`를 목으로 주입해 **인자 구성**(name·script·env)만 검증.

- [ ] **Step 1: 의존성 설치**

Run: `npm install node-windows`
(타입 패키지 있으면 `npm install -D @types/node-windows`; 없으면 Step 2의 d.ts.)

- [ ] **Step 2: 타입 선언(미제공 시)**

`src/types/node-windows.d.ts`:

```ts
declare module 'node-windows' {
  export class Service {
    constructor(opts: { name: string; description?: string; script: string; env?: { name: string; value: string }[]; wait?: number; grow?: number });
    on(event: 'install' | 'uninstall' | 'start' | 'stop' | 'alreadyinstalled' | 'error', cb: (...args: unknown[]) => void): void;
    install(): void;
    uninstall(): void;
    start(): void;
    stop(): void;
    exists?: boolean;
  }
}
```

- [ ] **Step 3: 실패 테스트(목 주입)**

`src/pal/supervisor/windows-supervisor.spec.ts`:

```ts
import { WindowsSupervisor } from './windows-supervisor';

describe('WindowsSupervisor', () => {
  it('install은 name·script·env(ENGRAM_DATA_DIR)로 서비스를 구성한다', async () => {
    let opts: any;
    const fakeServiceFactory = (o: any) => {
      opts = o;
      const handlers: Record<string, () => void> = {};
      return { on: (e: string, cb: () => void) => { handlers[e] = cb; }, install: () => handlers['install']?.(), uninstall: () => {}, start: () => {}, stop: () => {} };
    };
    const sup = new WindowsSupervisor({ name: 'Engram', scriptPath: 'C:/app/main.js', dataDir: 'C:/data' }, fakeServiceFactory as any);
    await sup.install();
    expect(opts.name).toBe('Engram');
    expect(opts.script).toBe('C:/app/main.js');
    expect(opts.env).toEqual([{ name: 'ENGRAM_DATA_DIR', value: 'C:/data' }]);
  });
});
```

- [ ] **Step 4: 실패 확인**

Run: `npx jest windows-supervisor`
Expected: FAIL — 생성자 2번째 인자(factory) 미지원 / `미구현(T6)` throw

- [ ] **Step 5: 구현**

`src/pal/supervisor/windows-supervisor.ts`:

```ts
import { Service } from 'node-windows';
import { SupervisorPort, ServiceStatus, ServiceSpec } from './supervisor.port';

type ServiceFactory = (opts: ConstructorParameters<typeof Service>[0]) => Service;

// Windows 서비스 어댑터(spec B2). node-windows로 SCM 등록 — 부팅 자동시작·죽으면 재시작·백오프는 SCM이 네이티브 제공.
export class WindowsSupervisor implements SupervisorPort {
  private readonly make: ServiceFactory;
  constructor(private readonly spec: ServiceSpec, make?: ServiceFactory) {
    this.make = make ?? ((o) => new Service(o));
  }

  private build(): Service {
    return this.make({
      name: this.spec.name,
      description: 'Engram 24/7 상주 지식 코어',
      script: this.spec.scriptPath,
      env: [{ name: 'ENGRAM_DATA_DIR', value: this.spec.dataDir }],
      wait: 2,   // 재시작 대기 시작값(초)
      grow: 0.5, // 백오프 증가율
    });
  }

  private once(svc: Service, event: 'install' | 'uninstall' | 'start' | 'stop', action: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      svc.on(event, () => resolve());
      svc.on('alreadyinstalled', () => resolve());
      svc.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
      action();
    });
  }

  async install(): Promise<void> { const s = this.build(); await this.once(s, 'install', () => s.install()); }
  async uninstall(): Promise<void> { const s = this.build(); await this.once(s, 'uninstall', () => s.uninstall()); }
  async start(): Promise<void> { const s = this.build(); await this.once(s, 'start', () => s.start()); }
  async stop(): Promise<void> { const s = this.build(); await this.once(s, 'stop', () => s.stop()); }
  async status(): Promise<ServiceStatus> { return this.build().exists ? 'running' : 'not-installed'; }
}
```

- [ ] **Step 6: 통과 확인 + 커밋**

Run: `npx jest windows-supervisor && npx tsc --noEmit`
Expected: PASS, 타입 0

```bash
git add package.json package-lock.json src/types/node-windows.d.ts src/pal/supervisor/windows-supervisor.ts src/pal/supervisor/windows-supervisor.spec.ts
git commit -m "feat(phase5b): Windows 서비스 어댑터(node-windows)"
```

---

### Task 7: Linux 어댑터 (systemd 유닛 생성)

**Files:**
- Modify: `src/pal/supervisor/linux-supervisor.ts` (본체)
- Test: `src/pal/supervisor/linux-supervisor.spec.ts`

**Interfaces:**
- Produces: `buildUnit(spec): string` (순수, 테스트 대상) + install/start/stop이 유닛 파일 쓰고 `systemctl --user` 실행.

> **검증**: `buildUnit` 문자열은 단위테스트. 실제 `systemctl` 동작은 **Linux에서 사용자 수동 검증**(spec §3.7).

- [ ] **Step 1: 실패 테스트**

`src/pal/supervisor/linux-supervisor.spec.ts`:

```ts
import { LinuxSupervisor } from './linux-supervisor';

describe('LinuxSupervisor.buildUnit', () => {
  it('systemd 유닛에 재시작·환경·실행경로를 담는다', () => {
    const unit = new LinuxSupervisor({ name: 'engram', scriptPath: '/app/main.js', dataDir: '/data' }).buildUnit();
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('Environment=ENGRAM_DATA_DIR=/data');
    expect(unit).toContain('ExecStart=');
    expect(unit).toContain('/app/main.js');
    expect(unit).toContain('WatchdogSec=');  // 멈춤 감지 네이티브(설계 §10.1)
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest linux-supervisor`
Expected: FAIL — `buildUnit is not a function` / `미구현`

- [ ] **Step 3: 구현**

`src/pal/supervisor/linux-supervisor.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { SupervisorPort, ServiceStatus, ServiceSpec } from './supervisor.port';

// Linux systemd 어댑터(설계 §10.1). user 단위 서비스 — Restart=always + WatchdogSec(멈춤 감지 네이티브).
export class LinuxSupervisor implements SupervisorPort {
  constructor(private readonly spec: ServiceSpec) {}

  buildUnit(): string {
    return [
      '[Unit]',
      'Description=Engram 24/7 상주 지식 코어',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${process.execPath} ${this.spec.scriptPath}`,
      `Environment=ENGRAM_DATA_DIR=${this.spec.dataDir}`,
      'Restart=always',
      'RestartSec=2',
      'WatchdogSec=120',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
  }

  private unitPath(): string {
    return path.join(os.homedir(), '.config', 'systemd', 'user', `${this.spec.name}.service`);
  }

  async install(): Promise<void> {
    const p = this.unitPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, this.buildUnit());
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', this.spec.name]);
  }
  async uninstall(): Promise<void> {
    execFileSync('systemctl', ['--user', 'disable', this.spec.name]);
    try { fs.unlinkSync(this.unitPath()); } catch { /* 이미 없음 */ }
    execFileSync('systemctl', ['--user', 'daemon-reload']);
  }
  async start(): Promise<void> { execFileSync('systemctl', ['--user', 'start', this.spec.name]); }
  async stop(): Promise<void> { execFileSync('systemctl', ['--user', 'stop', this.spec.name]); }
  async status(): Promise<ServiceStatus> {
    try {
      const out = execFileSync('systemctl', ['--user', 'is-active', this.spec.name]).toString().trim();
      return out === 'active' ? 'running' : 'stopped';
    } catch { return 'not-installed'; }
  }
}
```

- [ ] **Step 4: 통과 확인 + 커밋**

Run: `npx jest linux-supervisor && npx tsc --noEmit`
Expected: PASS, 타입 0

```bash
git add src/pal/supervisor/linux-supervisor.ts src/pal/supervisor/linux-supervisor.spec.ts
git commit -m "feat(phase5b): Linux systemd 어댑터(유닛 생성 + systemctl)"
```

---

### Task 8: macOS 어댑터 (launchd plist 생성)

**Files:**
- Modify: `src/pal/supervisor/macos-supervisor.ts` (본체)
- Test: `src/pal/supervisor/macos-supervisor.spec.ts`

**Interfaces:**
- Produces: `buildPlist(spec): string` (순수, 테스트 대상) + install/start/stop이 plist 쓰고 `launchctl` 실행.

> **검증**: `buildPlist`는 단위테스트. 실제 `launchctl`은 **macOS에서 사용자 수동 검증**(spec §3.7).

- [ ] **Step 1: 실패 테스트**

`src/pal/supervisor/macos-supervisor.spec.ts`:

```ts
import { MacosSupervisor } from './macos-supervisor';

describe('MacosSupervisor.buildPlist', () => {
  it('plist에 라벨·KeepAlive·RunAtLoad·환경·실행인자를 담는다', () => {
    const plist = new MacosSupervisor({ name: 'com.engram.daemon', scriptPath: '/app/main.js', dataDir: '/data' }).buildPlist();
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('com.engram.daemon');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('ENGRAM_DATA_DIR');
    expect(plist).toContain('/app/main.js');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest macos-supervisor`
Expected: FAIL — `buildPlist is not a function` / `미구현`

- [ ] **Step 3: 구현**

`src/pal/supervisor/macos-supervisor.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { SupervisorPort, ServiceStatus, ServiceSpec } from './supervisor.port';

// macOS launchd 어댑터(설계 §10.1). LaunchAgent plist — KeepAlive(죽으면 재시작) + RunAtLoad(부팅 시작).
export class MacosSupervisor implements SupervisorPort {
  constructor(private readonly spec: ServiceSpec) {}

  buildPlist(): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      `  <string>${this.spec.name}</string>`,
      '  <key>ProgramArguments</key>',
      `  <array><string>${process.execPath}</string><string>${this.spec.scriptPath}</string></array>`,
      '  <key>EnvironmentVariables</key>',
      `  <dict><key>ENGRAM_DATA_DIR</key><string>${this.spec.dataDir}</string></dict>`,
      '  <key>KeepAlive</key><true/>',
      '  <key>RunAtLoad</key><true/>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
  }

  private plistPath(): string {
    return path.join(os.homedir(), 'Library', 'LaunchAgents', `${this.spec.name}.plist`);
  }

  async install(): Promise<void> {
    const p = this.plistPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, this.buildPlist());
    execFileSync('launchctl', ['load', p]);
  }
  async uninstall(): Promise<void> {
    try { execFileSync('launchctl', ['unload', this.plistPath()]); } catch { /* 미로드 */ }
    try { fs.unlinkSync(this.plistPath()); } catch { /* 이미 없음 */ }
  }
  async start(): Promise<void> { execFileSync('launchctl', ['start', this.spec.name]); }
  async stop(): Promise<void> { execFileSync('launchctl', ['stop', this.spec.name]); }
  async status(): Promise<ServiceStatus> {
    try {
      execFileSync('launchctl', ['list', this.spec.name]);
      return 'running';
    } catch { return 'not-installed'; }
  }
}
```

- [ ] **Step 4: 통과 확인 + 커밋**

Run: `npx jest macos-supervisor && npx tsc --noEmit`
Expected: PASS, 타입 0

```bash
git add src/pal/supervisor/macos-supervisor.ts src/pal/supervisor/macos-supervisor.spec.ts
git commit -m "feat(phase5b): macOS launchd 어댑터(plist 생성 + launchctl)"
```

---

### Task 9: CLI engram service + 상주 배선(PalModule)

**Files:**
- Create: `src/pal/pal.module.ts`
- Modify: `src/app.module.ts` (PalModule import)
- Modify: `src/edge/cli.gateway.ts` (`service` 분기)
- Test: `src/edge/cli.gateway.spec.ts` (service status 경로)

**Interfaces:**
- Consumes: `createSupervisor`(T5), `HeartbeatEmitter`(T2), `MemoryMonitor`(T4), `PathResolver`·`PinoLogger`.
- Produces: `engram service install|uninstall|start|stop|status`. HeartbeatEmitter·MemoryMonitor가 상주 모듈 그래프에 등록(상주에서 @Interval 발화).

- [ ] **Step 1: PalModule 작성**

`src/pal/pal.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { KnowledgeCoreModule } from '../knowledge-core/knowledge-core.module';
import { HeartbeatEmitter } from './heartbeat';
import { MemoryMonitor } from './memory-monitor';
import { PathResolver } from './path-resolver';
import { PinoLogger } from './logger';

// PAL 상주 위생(설계 §10). HeartbeatEmitter·MemoryMonitor @Interval 등록.
// PathResolver·PinoLogger는 KnowledgeCoreModule이 export.
@Module({
  imports: [KnowledgeCoreModule, ScheduleModule.forRoot()],
  providers: [
    HeartbeatEmitter,
    { provide: MemoryMonitor, useFactory: (p: PathResolver, l: PinoLogger) => new MemoryMonitor(p, l), inject: [PathResolver, PinoLogger] },
  ],
})
export class PalModule {}
```

(주의: `ScheduleModule.forRoot()`는 앱에 1회면 충분 — EdgeModule이 이미 forRoot 중이면 PalModule은 `ScheduleModule`만 두거나 import 생략. app.module 구성 확인 후 중복 forRoot 제거.)

- [ ] **Step 2: app.module에 PalModule 추가**

`src/app.module.ts`의 `imports`에 `PalModule` 추가(import 문 포함).

- [ ] **Step 3: service CLI 실패 테스트**

`src/edge/cli.gateway.spec.ts`에 추가:

```ts
it('service status는 supervisor.status 결과를 출력', async () => {
  const out: string[] = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((s: any) => { out.push(String(s)); return true; });
  // createSupervisor를 목으로 대체할 수 있도록 CliGateway가 주입받는 형태면 주입; 아니면 service 분기가
  // process.platform 기반이라 status만 호출되는 스모크로 충분(미설치 → not-installed/에러 문구).
  const gw = new CliGateway({} as any, {} as any, {} as any);
  await gw.run(['service', 'status']);
  expect(out.join('')).toMatch(/서비스|설치|installed|running|stopped/);
  (process.stdout.write as any).mockRestore();
});
```

- [ ] **Step 4: 실패 확인**

Run: `npx jest cli.gateway -t service`
Expected: FAIL — `service` 분기 없음

- [ ] **Step 5: service 분기 구현**

`src/edge/cli.gateway.ts`:
- import 추가:

```ts
import { createSupervisor, SupervisorPort } from '../pal/supervisor/supervisor.factory'; // SupervisorPort는 port에서
import { findRepoRoot } from '../pal/repo-root';
import * as path from 'path';
```

(정확히: `createSupervisor`는 `supervisor.factory`, `SupervisorPort`·`ServiceSpec`은 `supervisor.port`에서 import.)

- `run()` 디스패치에 분기 추가:

```ts
    } else if (argv[0] === 'service') {
      await this.service(argv.slice(1));
    }
```

- 메서드 추가:

```ts
  private async service(args: string[]): Promise<void> {
    const verb = args[0];
    if (!['install', 'uninstall', 'start', 'stop', 'status'].includes(verb)) {
      process.stdout.write('사용법: engram service install|uninstall|start|stop|status\n');
      return;
    }
    const dataDir = this.paths ? this.paths.getDataDir() : process.cwd();
    const scriptPath = path.join(findRepoRoot(__dirname), 'dist', 'src', 'main.js');
    let sup: SupervisorPort;
    try {
      sup = createSupervisor(process.platform, { name: 'Engram', scriptPath, dataDir });
    } catch (e) { process.stdout.write(`${String(e)}\n`); return; }
    try {
      if (verb === 'status') { process.stdout.write(`서비스 상태: ${await sup.status()}\n`); return; }
      await (sup as any)[verb]();
      process.stdout.write(`서비스 ${verb} 완료\n`);
    } catch (e) { process.stdout.write(`서비스 ${verb} 실패: ${String(e)}\n`); }
  }
```

(`this.paths`는 기존 `@Optional() PathResolver` — 이미 생성자에 존재. `SupervisorPort` import는 `../pal/supervisor/supervisor.port`로 정확히.)

- 사용법 문자열에 `| engram service install|...|status` 추가.

- [ ] **Step 6: 통과 확인 + 커밋**

Run: `npx jest cli.gateway && npx tsc --noEmit`
Expected: PASS, 타입 0

```bash
git add src/pal/pal.module.ts src/app.module.ts src/edge/cli.gateway.ts src/edge/cli.gateway.spec.ts
git commit -m "feat(phase5b): engram service CLI + PalModule(상주 heartbeat·memory) 배선"
```

---

### Task 10: 전체 검증 + Windows 수동 검증 + 문서

**Files:**
- (검증만 — 새 파일 없음)
- Modify: `README.md` 또는 `docs/`에 `engram service`·watchdog 운영 안내(선택)

- [ ] **Step 1: 전체 테스트 + 빌드**

Run: `npx jest && npx tsc --noEmit`
(레포 스크립트 우선: `npm test`, `npm run build`.)
Expected: 전체 PASS, 타입 0

- [ ] **Step 2: Windows 서비스 수동 검증(이 머신)**

관리자 PowerShell에서:

```
npm run build
node dist/src/cli.js service install
node dist/src/cli.js service status   # → running 또는 stopped
node dist/src/cli.js service start
# (services.msc에서 Engram 확인 / runtime/state/heartbeat 갱신 확인)
node dist/src/cli.js service stop
node dist/src/cli.js service uninstall
```

Expected: 설치·상태·시작·정지·삭제가 오류 없이 동작. heartbeat 파일이 1분 내 갱신.

- [ ] **Step 3: watchdog 수동 스모크**

```
# 별도 창에서: 상주 main 실행 후 watchdog 실행 → 상주 강제종료해 알림 경로 확인
node dist/src/watchdog.js   # heartbeat 끊기면 알림(config/alert.json 설정 시)
```

Expected: 상주 멈춤/종료 시 watchdog이 pid kill + 알림(설정된 채널) 시도.

- [ ] **Step 4: Mac/Linux 검증 안내 명시**

`buildUnit`/`buildPlist` 단위테스트는 통과하지만 실제 `systemctl`/`launchctl`은 해당 OS에서 검증 필요함을 커밋 메시지/PR에 명시(spec §3.7).

- [ ] **Step 5: 최종 커밋**

```bash
git add -A
git commit -m "test(phase5b): PAL 전체 검증 — Windows 수동 통과 + Mac/Linux 생성물 단위테스트"
```

---

## Self-Review (작성자 점검 결과)

- **스펙 커버리지(spec §3)**: B1 OS 3종(T6·T7·T8 + T5 팩토리) · B2 node-windows(T6) · B3 heartbeat+watchdog(T2·T3) · B4 설정형 알림(T1) · B5 메모리 감시(T4) · CLI engram service(T9) · 상주 배선(T9 PalModule). 누락 없음.
- **타입 일관성**: `SupervisorPort`·`ServiceSpec`·`ServiceStatus`(T5) — 3 어댑터(T6~T8)·팩토리·CLI에서 동일 사용. `sendAlert`/`loadAlertConfig`(T1) — watchdog·MemoryMonitor 공유. `isStale`/`readHeartbeat`(T3)·`isOverLimit`(T4) 정의/사용 일치.
- **플레이스홀더**: T5 어댑터 스텁은 T6~T8에서 본체로 교체(throw→구현). 의도된 단계적 구현(스텁→TDD)이며 최종 상태에 throw 잔존 없음.
- **검증 한계 명시**: Mac/Linux 실 OS 통합은 단위테스트 불가 — 생성물·명령 문자열만 테스트, 실동작은 사용자 수동 검증(spec §3.7·Global Constraints).
- **의존성**: `node-windows` 1개만 추가(spec B2 승인). 그 외 stdlib.
- **주의(구현자)**: `ScheduleModule.forRoot()` 중복 등록 주의 — app.module 그래프에서 1회만(EdgeModule이 이미 forRoot면 PalModule은 생략/조정). `cli.gateway`의 `service` 테스트는 실제 OS 호출을 피하도록 status 스모크 위주(install 등은 수동 검증).
