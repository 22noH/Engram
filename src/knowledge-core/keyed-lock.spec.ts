import { KeyedLock } from './keyed-lock';

describe('KeyedLock', () => {
  it('같은 키는 직렬 실행된다(늦게 끝나는 작업이 먼저 완료)', async () => {
    const lock = new KeyedLock();
    const order: number[] = [];
    const first = lock.run('a', async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    });
    const second = lock.run('a', async () => {
      order.push(2);
    });
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  it('다른 키는 병렬 진행한다', async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const a = lock.run('a', async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push('a');
    });
    const b = lock.run('b', async () => {
      order.push('b');
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['b', 'a']);
  });

  it('작업이 throw해도 같은 키의 다음 작업이 진행된다', async () => {
    const lock = new KeyedLock();
    await expect(
      lock.run('a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(lock.run('a', async () => 42)).resolves.toBe(42);
  });

  it('키의 마지막 작업 후 내부 맵을 정리한다(누수 방지)', async () => {
    const lock = new KeyedLock();
    await lock.run('a', async () => 1);
    await new Promise((r) => setTimeout(r, 0));
    expect((lock as unknown as { chains: Map<string, unknown> }).chains.size).toBe(0);
  });
});
