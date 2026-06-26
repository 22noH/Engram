import { DigestScheduler } from './digest.scheduler';

it('tick은 orchestrator.digest를 호출한다', async () => {
  const orch = { digest: jest.fn().mockResolvedValue({ extracted: 0, gated: 0, proposed: 2 }) } as any;
  const logger = { log: jest.fn(), error: jest.fn() } as any;
  await new DigestScheduler(orch, logger).tick();
  expect(orch.digest).toHaveBeenCalled();
});

it('digest 실패해도 throw하지 않는다(상주 보호)', async () => {
  const orch = { digest: jest.fn().mockRejectedValue(new Error('boom')) } as any;
  const logger = { log: jest.fn(), error: jest.fn() } as any;
  await expect(new DigestScheduler(orch, logger).tick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalled();
});
