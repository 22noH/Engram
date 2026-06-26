import { ImportanceGate } from './importance-gate';

const f = (importance: number) => ({ claim: 'c', importance, sourceQuote: 's' });

describe('ImportanceGate', () => {
  it('기본 임계치 3 미만은 폐기한다', () => {
    const gate = new ImportanceGate({} as any);
    expect(gate.threshold).toBe(3);
    expect(gate.filter([f(1), f(2), f(3), f(5)]).map((x) => x.importance)).toEqual([3, 5]);
  });
  it('env 임계치를 따른다', () => {
    const gate = new ImportanceGate({ ENGRAM_IMPORTANCE_THRESHOLD: '4' } as any);
    expect(gate.filter([f(3), f(4)]).map((x) => x.importance)).toEqual([4]);
  });
  it('비숫자 env는 기본 3으로 폴백한다', () => {
    const gate = new ImportanceGate({ ENGRAM_IMPORTANCE_THRESHOLD: 'abc' } as any);
    expect(gate.threshold).toBe(3);
  });
  it('범위(1~5) 밖 숫자 env는 기본 3으로 폴백한다', () => {
    expect(new ImportanceGate({ ENGRAM_IMPORTANCE_THRESHOLD: '6' } as any).threshold).toBe(3);
    expect(new ImportanceGate({ ENGRAM_IMPORTANCE_THRESHOLD: '0' } as any).threshold).toBe(3);
    expect(new ImportanceGate({ ENGRAM_IMPORTANCE_THRESHOLD: '-1' } as any).threshold).toBe(3);
  });
});
