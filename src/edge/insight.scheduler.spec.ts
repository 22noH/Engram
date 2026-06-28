import { InsightScheduler } from './insight.scheduler';
import { PinoLogger } from '../pal/logger';
import { PathResolver } from '../pal/path-resolver';

describe('InsightScheduler', () => {
  const logger = new PinoLogger(new PathResolver(require('os').tmpdir()));

  it('tick은 orchestrator.insight를 호출한다', async () => {
    let called = false;
    const orch = { insight: async () => { called = true; return { date: '2026-06-28', metrics: {} as any, report: 'r' }; } };
    await new InsightScheduler(orch as any, logger).tick();
    expect(called).toBe(true);
  });

  it('insight 예외가 프로세스를 죽이지 않는다(로깅 후 정상 반환)', async () => {
    const orch = { insight: async () => { throw new Error('boom'); } };
    await expect(new InsightScheduler(orch as any, logger).tick()).resolves.toBeUndefined();
  });
});
