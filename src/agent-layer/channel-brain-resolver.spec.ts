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

  // Finding 2(스펙 §3.5): loadBrainProfile은 미등록 이름을 default로 "조용히" 대체(절대 throw 안 함)라
  // resolveByName만으로는 삭제된 프로필을 감지 못한다 — listNames로 등록 여부를 먼저 걸러야 한다.
  it('이름이 등록 목록에 없음(삭제된 프로필) → 주입된 defaultBrain 인스턴스 그대로 + warn(resolveByName은 호출 안 함)', () => {
    const def = brain('default');
    const silentSubstitute = brain('silently-substituted-default'); // loadBrainProfile이 만들 "복사본" 시늉
    let called = false;
    const r = new ChannelBrainResolver(
      () => { called = true; return silentSubstitute; },
      def,
      logger,
      () => ['claude', 'judge'],
    );
    const result = r.resolve('deleted-brain');
    expect(result).toBe(def); // 새로 빌드된 복사본이 아니라 주입된 인스턴스 그 자체
    expect(called).toBe(false); // resolveByName까지 갈 필요가 없다 — listNames에서 먼저 걸러짐
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain('deleted-brain');
  });

  it('이름이 등록 목록에 있음 → 기존과 동일하게 resolveByName 결과 반환(listNames 주입돼도 정상 이름은 무영향)', () => {
    const def = brain('default');
    const named = brain('qwen');
    const r = new ChannelBrainResolver((name) => (name === 'qwen' ? named : def), def, logger, () => ['qwen', 'claude']);
    expect(r.resolve('qwen')).toBe(named);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('listNames 미주입(구식 DI) → 기존 try/catch 경로만 탄다(회귀 0)', () => {
    const def = brain('default');
    const named = brain('qwen');
    const r = new ChannelBrainResolver((name) => (name === 'qwen' ? named : def), def, logger);
    expect(r.resolve('qwen')).toBe(named);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
