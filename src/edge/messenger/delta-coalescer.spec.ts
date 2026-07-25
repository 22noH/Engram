import { createDeltaCoalescer, DELTA_INTERVAL_MS, DELTA_MAX_CHARS } from './delta-coalescer';

// 답변 실시간 스트리밍: 두뇌 onChunk는 토큰마다(수 바이트씩) 쏟아진다 — 그대로 ws 프레임 1개씩
// 내보내면 폭주다. 짧은 간격으로 모아 한 번에 흘려보내는 코얼레서의 계약을 못 박는다.
describe('delta-coalescer — 짧은 간격 코얼레싱', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('간격 안에 들어온 여러 델타를 하나로 합쳐 한 번만 흘린다', () => {
    const out: string[] = [];
    const c = createDeltaCoalescer((t) => out.push(t));
    c.push('안');
    c.push('녕');
    c.push('하세요');
    expect(out).toEqual([]); // 아직 간격 전 — 프레임 0개
    jest.advanceTimersByTime(DELTA_INTERVAL_MS);
    expect(out).toEqual(['안녕하세요']);
  });

  it('간격이 지나면 다음 배치를 다시 모아 흘린다(연속 스트림)', () => {
    const out: string[] = [];
    const c = createDeltaCoalescer((t) => out.push(t));
    c.push('a');
    jest.advanceTimersByTime(DELTA_INTERVAL_MS);
    c.push('b');
    c.push('c');
    jest.advanceTimersByTime(DELTA_INTERVAL_MS);
    expect(out).toEqual(['a', 'bc']);
  });

  it('버퍼가 상한을 넘으면 간격을 안 기다리고 즉시 흘린다(긴 답 체감 지연 방지)', () => {
    const out: string[] = [];
    const c = createDeltaCoalescer((t) => out.push(t));
    c.push('x'.repeat(DELTA_MAX_CHARS));
    expect(out).toEqual(['x'.repeat(DELTA_MAX_CHARS)]); // 타이머 진행 없이 이미 나갔다
    jest.advanceTimersByTime(DELTA_INTERVAL_MS);
    expect(out).toHaveLength(1); // 빈 버퍼는 다시 안 흘린다
  });

  it('stop()은 대기 중인 버퍼를 버리고 타이머도 없앤다(턴 종료·중지 시 정리)', () => {
    const out: string[] = [];
    const c = createDeltaCoalescer((t) => out.push(t));
    c.push('버려질 조각');
    c.stop();
    jest.advanceTimersByTime(DELTA_INTERVAL_MS * 10);
    expect(out).toEqual([]);
  });

  it('빈 문자열 push는 무시한다(빈 프레임 0)', () => {
    const out: string[] = [];
    const c = createDeltaCoalescer((t) => out.push(t));
    c.push('');
    jest.advanceTimersByTime(DELTA_INTERVAL_MS);
    expect(out).toEqual([]);
  });

  it('sink가 던져도 push/flush가 던지지 않는다(never-throw 격리)', () => {
    const c = createDeltaCoalescer(() => { throw new Error('ws boom'); });
    c.push('조각');
    expect(() => jest.advanceTimersByTime(DELTA_INTERVAL_MS)).not.toThrow();
  });

  it('옵션으로 간격·상한을 바꿀 수 있다', () => {
    const out: string[] = [];
    const c = createDeltaCoalescer((t) => out.push(t), { intervalMs: 10, maxChars: 3 });
    c.push('ab');
    jest.advanceTimersByTime(10);
    expect(out).toEqual(['ab']);
    c.push('cde'); // 상한 3 도달 → 즉시
    expect(out).toEqual(['ab', 'cde']);
  });
});
