import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { isOverLimit, MemoryMonitor } from './memory-monitor';
import { PathResolver } from './path-resolver';
import { PinoLogger } from './logger';

describe('memory-monitor', () => {
  const ORIGINAL_RESIDENT = process.env.ENGRAM_RESIDENT;
  beforeEach(() => { process.env.ENGRAM_RESIDENT = '1'; }); // sample()은 상주 게이트 뒤에 있음
  afterEach(() => {
    delete process.env.ENGRAM_HEAP_KEEP;
    if (ORIGINAL_RESIDENT === undefined) delete process.env.ENGRAM_RESIDENT;
    else process.env.ENGRAM_RESIDENT = ORIGINAL_RESIDENT;
  });

  it('ENGRAM_RESIDENT 미설정(헤드리스 등) — sample 무발화', () => {
    delete process.env.ENGRAM_RESIDENT;
    const paths = new PathResolver(os.tmpdir());
    const logger = new PinoLogger(paths);
    let sampled = false;
    const m = new MemoryMonitor(paths, logger, { limitMb: 1, rssFn: () => { sampled = true; return 999 * 1024 * 1024; }, alertFn: async () => {}, snapshotFn: () => 'x' });
    m.sample();
    expect(sampled).toBe(false);
  });

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

  it('스냅샷 후 오래된 heap 파일을 정리한다(최신 keep개만)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
    const paths = new PathResolver(dir);
    const logs = paths.getLogsDir();
    fs.mkdirSync(logs, { recursive: true });
    for (const t of ['001', '002', '003']) fs.writeFileSync(path.join(logs, `heap-${t}.heapsnapshot`), 'x');
    const logger = new PinoLogger(paths);
    const m = new MemoryMonitor(paths, logger, {
      limitMb: 1, keepSnapshots: 2,
      rssFn: () => 999 * 1024 * 1024,
      alertFn: async () => {},
      snapshotFn: () => { const p = path.join(logs, 'heap-004.heapsnapshot'); fs.writeFileSync(p, 'x'); return p; },
    });
    m.sample();
    const remaining = fs.readdirSync(logs).filter((f: string) => f.startsWith('heap-')).sort();
    expect(remaining).toEqual(['heap-003.heapsnapshot', 'heap-004.heapsnapshot']);
  });

  it('keepSnapshots=0은 무제한(스냅샷 정리 안 함)', () => {
    const fs2 = require('fs'); const p2 = require('path');
    const dir = fs2.mkdtempSync(p2.join(os.tmpdir(), 'mm0-'));
    const paths = new PathResolver(dir);
    const logs = paths.getLogsDir(); fs2.mkdirSync(logs, { recursive: true });
    for (const t of ['001', '002', '003']) fs2.writeFileSync(p2.join(logs, `heap-${t}.heapsnapshot`), 'x');
    const logger = new PinoLogger(paths);
    const m = new MemoryMonitor(paths, logger, {
      limitMb: 1, keepSnapshots: 0,
      rssFn: () => 999 * 1024 * 1024,
      alertFn: async () => {},
      snapshotFn: () => { const p = p2.join(logs, 'heap-004.heapsnapshot'); fs2.writeFileSync(p, 'x'); return p; },
    });
    m.sample();
    const remaining = fs2.readdirSync(logs).filter((f: string) => f.startsWith('heap-')).sort();
    expect(remaining).toEqual(['heap-001.heapsnapshot', 'heap-002.heapsnapshot', 'heap-003.heapsnapshot', 'heap-004.heapsnapshot']); // 전부 보존
  });

  it('ENGRAM_HEAP_KEEP 미설정이면 무제한(정리 안 함)', () => {
    const fs2 = require('fs'); const p2 = require('path');
    delete process.env.ENGRAM_HEAP_KEEP;
    const dir = fs2.mkdtempSync(p2.join(os.tmpdir(), 'mmd-'));
    const paths = new PathResolver(dir);
    const logs = paths.getLogsDir(); fs2.mkdirSync(logs, { recursive: true });
    for (const t of ['001', '002', '003']) fs2.writeFileSync(p2.join(logs, `heap-${t}.heapsnapshot`), 'x');
    const logger = new PinoLogger(paths);
    // keepSnapshots는 deps에서 빼서 env(미설정→NaN→무제한) 경로를 탄다
    const m = new MemoryMonitor(paths, logger, {
      limitMb: 1,
      rssFn: () => 999 * 1024 * 1024,
      alertFn: async () => {},
      snapshotFn: () => { const p = p2.join(logs, 'heap-004.heapsnapshot'); fs2.writeFileSync(p, 'x'); return p; },
    });
    m.sample();
    const remaining = fs2.readdirSync(logs).filter((f: string) => f.startsWith('heap-')).sort();
    expect(remaining).toEqual(['heap-001.heapsnapshot', 'heap-002.heapsnapshot', 'heap-003.heapsnapshot', 'heap-004.heapsnapshot']);
  });
});
