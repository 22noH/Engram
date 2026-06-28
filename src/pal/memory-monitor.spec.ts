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
