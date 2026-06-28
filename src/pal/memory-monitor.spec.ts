import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
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
});
