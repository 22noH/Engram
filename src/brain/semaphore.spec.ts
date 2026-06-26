import { Semaphore } from './semaphore';

describe('Semaphore', () => {
  it('max=1이면 동시 실행 최대치를 1로 제한한다', async () => {
    const sem = new Semaphore(1);
    let active = 0;
    let peak = 0;
    const task = () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      });
    await Promise.all([task(), task(), task()]);
    expect(peak).toBe(1);
  });

  it('max=2면 동시 2개까지 허용한다', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      });
    await Promise.all([task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });

  it('작업이 throw해도 다음 대기자를 풀어준다', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(sem.run(async () => 42)).resolves.toBe(42);
  });
});
