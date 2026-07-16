import { BrainProvider, DelegateHandle } from '../brain/brain.port';

// 한 대화의 위임 세션 = DelegateHandle + 그 세션 동안 누적된 위임 비용 조회.
export type DelegateSession = DelegateHandle & { spentUsd(): number };

// 지휘자 위임 실행기(스펙 §2.3). 이름으로 등록 두뇌를 resolve해 complete를 부른다.
// 깊이 1: 일꾼에겐 delegate 미전달 → 재위임 불가(무한 재귀 차단). never-throw.
// 비용은 handle()별 클로저에 누적(싱글턴 필드 아님 — 동시 대화 간 간섭 없음).
// resolve/names는 agent-layer.module이 주입. resolve는 지휘자 자신의 인스턴스가 아닌 새 인스턴스를 준다(세마포어 분리).
export class BrainDelegator {
  constructor(
    private readonly resolve: (name: string) => BrainProvider,
    private readonly names: () => string[],
  ) {}

  handle(): DelegateSession {
    let spent = 0;
    return {
      brains: this.names(),
      run: async (brain, task) => {
        const available = this.names();
        if (!available.includes(brain)) {
          return `delegate error: unknown brain "${brain}" (available: ${available.join(', ')})`;
        }
        try {
          const worker = this.resolve(brain); // 프로필 빌드 실패(미지원 provider 등)도 여기서 삼킨다.
          const r = await worker.complete(task); // delegate 없음=깊이 1, cwd 없음=채팅작업
          spent += r.costUsd;
          return r.isError ? `delegate error: brain "${brain}" failed (${String(r.raw)})` : r.text;
        } catch (e) {
          return `delegate error: brain "${brain}" threw (${String(e)})`;
        }
      },
      spentUsd: () => spent,
    };
  }
}
