import { BrainProvider, DelegateHandle } from '../brain/brain.port';

// 지휘자 위임 실행기(스펙 §2.3). 이름으로 등록 두뇌를 resolve해 complete를 부른다.
// 깊이 1: 일꾼에겐 delegate 미전달 → 재위임 불가(무한 재귀 차단). never-throw.
// resolve/names는 agent-layer.module이 주입(createBrain 캐시·brains.json 로딩 재사용).
export class BrainDelegator {
  private spent = 0;

  constructor(
    private readonly resolve: (name: string) => BrainProvider,
    private readonly names: () => string[],
  ) {}

  handle(): DelegateHandle {
    this.spent = 0;
    return {
      brains: this.names(),
      run: async (brain, task) => {
        const available = this.names();
        if (!available.includes(brain)) {
          return `delegate error: unknown brain "${brain}" (available: ${available.join(', ')})`;
        }
        const worker = this.resolve(brain);
        const r = await worker.complete(task); // cwd 없음=채팅작업, delegate 없음=깊이 1
        this.spent += r.costUsd;
        return r.isError ? `delegate error: brain "${brain}" failed (${String(r.raw)})` : r.text;
      },
    };
  }

  spentUsd(): number {
    return this.spent;
  }
}
