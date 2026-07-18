import { InsightScheduler } from './insight.scheduler';
import { PinoLogger } from '../pal/logger';
import { PathResolver } from '../pal/path-resolver';

describe('InsightScheduler', () => {
  const logger = new PinoLogger(new PathResolver(require('os').tmpdir()));
  const ORIGINAL = process.env.ENGRAM_RESIDENT;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ENGRAM_RESIDENT;
    else process.env.ENGRAM_RESIDENT = ORIGINAL;
  });

  it('tick은 orchestrator.insight를 호출한다(상주)', async () => {
    process.env.ENGRAM_RESIDENT = '1';
    let called = false;
    const orch = { insight: async () => { called = true; return { date: '2026-06-28', metrics: {} as any, report: 'r' }; } };
    await new InsightScheduler(orch as any, logger).tick();
    expect(called).toBe(true);
  });

  it('insight 예외가 프로세스를 죽이지 않는다(로깅 후 정상 반환)', async () => {
    process.env.ENGRAM_RESIDENT = '1';
    const orch = { insight: async () => { throw new Error('boom'); } };
    await expect(new InsightScheduler(orch as any, logger).tick()).resolves.toBeUndefined();
  });

  it('ENGRAM_RESIDENT 미설정(헤드리스 등) — 무발화', async () => {
    delete process.env.ENGRAM_RESIDENT;
    let called = false;
    const orch = { insight: async () => { called = true; return null; } };
    await new InsightScheduler(orch as any, logger).tick();
    expect(called).toBe(false);
  });
});
