import { DigestScheduler, resolveCron } from './digest.scheduler';

describe('resolveCron', () => {
  it('5~6 필드 표현식은 그대로 쓴다', () => {
    expect(resolveCron('0 3 * * *')).toBe('0 3 * * *');
    expect(resolveCron('*/30 * * * * *')).toBe('*/30 * * * * *'); // 6필드(초 포함)
  });
  it('미설정·필드 수 불일치는 기본값으로 폴백한다', () => {
    expect(resolveCron(undefined)).toBe('0 3 * * *');
    expect(resolveCron('every day')).toBe('0 3 * * *'); // 2필드 — 사람 문구
    expect(resolveCron('3am')).toBe('0 3 * * *');
  });
  it('resolveCron은 def 인자로 기본값을 바꿀 수 있다', () => {
    expect(resolveCron(undefined, '0 4 * * *')).toBe('0 4 * * *');
    expect(resolveCron('잘못된 문구', '0 4 * * *')).toBe('0 4 * * *');
    expect(resolveCron('0 9 * * *', '0 4 * * *')).toBe('0 9 * * *');
  });
});

describe('tick (상주 게이트 — heartbeat와 동일)', () => {
  const ORIGINAL = process.env.ENGRAM_RESIDENT;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ENGRAM_RESIDENT;
    else process.env.ENGRAM_RESIDENT = ORIGINAL;
  });

  it('tick은 orchestrator.digest를 호출한다(상주)', async () => {
    process.env.ENGRAM_RESIDENT = '1';
    const orch = { digest: jest.fn().mockResolvedValue({ extracted: 0, gated: 0, proposed: 2 }) } as any;
    const logger = { log: jest.fn(), error: jest.fn() } as any;
    await new DigestScheduler(orch, logger).tick();
    expect(orch.digest).toHaveBeenCalled();
  });

  it('digest 실패해도 throw하지 않는다(상주 보호)', async () => {
    process.env.ENGRAM_RESIDENT = '1';
    const orch = { digest: jest.fn().mockRejectedValue(new Error('boom')) } as any;
    const logger = { log: jest.fn(), error: jest.fn() } as any;
    await expect(new DigestScheduler(orch, logger).tick()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it('ENGRAM_RESIDENT 미설정(헤드리스 등) — 무발화', async () => {
    delete process.env.ENGRAM_RESIDENT;
    const orch = { digest: jest.fn() } as any;
    const logger = { log: jest.fn(), error: jest.fn() } as any;
    await new DigestScheduler(orch, logger).tick();
    expect(orch.digest).not.toHaveBeenCalled();
  });
});
