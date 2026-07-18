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

  // selfName(최종 리뷰 지적): 이 위임 세션을 여는 지휘자 자신의(채널로 해소된) 두뇌 이름. anthropic/openai-api
  // 하네스는 complete() 전체를 세마포어(보통 concurrency:1)로 감싸므로, 지휘자가 ask_brain으로 자기 자신의
  // 이름을 부르면 같은 permit을 쥔 채 같은 인스턴스의 complete()를 재진입해 영구 데드락에 빠진다. 기본 지휘자
  // (주입 BRAIN, 이름 미지정)는 selfName 없음 → 전 목록 그대로(회귀 0) — 주입 BRAIN은 BRAIN_NAME_RESOLVE
  // 캐시에 pre-seed 안 되므로(모듈 주석) 애초에 같은 인스턴스가 아니다.
  handle(selfName?: string): DelegateSession {
    let spent = 0;
    const available = (): string[] => this.names().filter((n) => n !== selfName);
    return {
      brains: available(),
      run: async (brain, task) => {
        const list = available();
        if (!list.includes(brain)) {
          return `delegate error: unknown brain "${brain}" (available: ${list.join(', ')})`;
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
