import { Backoff, STABLE_UPTIME_MS, WARN_AFTER } from './backoff';

describe('Backoff', () => {
  it('5초→30초→5분→5분 순으로 지연을 늘린다', () => {
    const b = new Backoff();
    expect(b.next()).toBe(5_000);
    expect(b.next()).toBe(30_000);
    expect(b.next()).toBe(300_000);
    expect(b.next()).toBe(300_000); // 최댓값 고정
  });

  it('reset하면 처음(5초)부터 다시', () => {
    const b = new Backoff();
    b.next();
    b.next();
    b.reset();
    expect(b.next()).toBe(5_000);
  });

  it('consecutiveFails는 next 횟수를 센다', () => {
    const b = new Backoff();
    b.next();
    b.next();
    expect(b.consecutiveFails).toBe(2);
    b.reset();
    expect(b.consecutiveFails).toBe(0);
  });

  it('상수: 1분 생존이면 안정, 3연속 실패면 경고', () => {
    expect(STABLE_UPTIME_MS).toBe(60_000);
    expect(WARN_AFTER).toBe(3);
  });
});
