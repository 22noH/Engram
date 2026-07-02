// 자식(상주) 크래시 재시작 백오프(스펙 §7): 5초 → 30초 → 5분, 이후 5분 고정.
const STEPS = [5_000, 30_000, 300_000];

// 자식이 이 시간 이상 살아있었으면 "안정"으로 보고 백오프를 리셋한다.
export const STABLE_UPTIME_MS = 60_000;

// 연속 실패가 이 횟수에 달하면 트레이 아이콘을 경고 상태로 바꾼다.
export const WARN_AFTER = 3;

export class Backoff {
  private fails = 0;

  next(): number {
    const delay = STEPS[Math.min(this.fails, STEPS.length - 1)];
    this.fails++;
    return delay;
  }

  reset(): void {
    this.fails = 0;
  }

  get consecutiveFails(): number {
    return this.fails;
  }
}
