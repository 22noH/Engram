import { ChannelBrainResolver } from './channel-brain-resolver';
import { BrainProvider } from '../brain/brain.port';

const logger = { warn: jest.fn(), error() {}, log() {} } as any;

function brain(tag: string): BrainProvider {
  return { complete: async () => ({ text: tag, costUsd: 0, isError: false }) };
}

describe('ChannelBrainResolver', () => {
  beforeEach(() => { logger.warn.mockClear(); });

  it('이름 미지정 → 주입된 기본 두뇌 그대로(회귀 0)', () => {
    const def = brain('default');
    const r = new ChannelBrainResolver(() => brain('never'), def, logger);
    expect(r.resolve(undefined)).toBe(def);
  });

  it('이름 지정 → 이름→두뇌 캐시 resolve 결과', () => {
    const def = brain('default');
    const named = brain('qwen');
    const seen: string[] = [];
    const r = new ChannelBrainResolver((name) => { seen.push(name); return named; }, def, logger);
    expect(r.resolve('qwen')).toBe(named);
    expect(seen).toEqual(['qwen']);
  });

  it('존재하지 않는 이름(resolve가 throw) → 기본 폴백 + warn 로그', () => {
    const def = brain('default');
    const r = new ChannelBrainResolver(() => { throw new Error('삭제된 프로필'); }, def, logger);
    expect(r.resolve('gone')).toBe(def);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain('gone');
  });
});
