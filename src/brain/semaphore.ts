// 동시 실행 상한(설계 §8 — 동시에 생각하는 두뇌 수에 천장).
// ponytail: p-limit 대체 인라인 구현. p-limit v4+는 순수 ESM이라 CJS(ts-jest/Nest)와 충돌.
//           기능이 더 필요해지면 p-limit@3(CJS)로 교체.
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}
