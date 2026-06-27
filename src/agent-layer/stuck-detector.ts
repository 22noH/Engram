// 진전 멈춤 감지(설계 §6, 씨앗 ②). K라운드 연속 progressKey 무변화 → stuck.
// 시간/횟수 상한 아님 — 오직 "진전이 멈췄나"만 본다(정상 장기작업 보호).
export class StuckDetector {
  private last: string | null = null;
  private streak = 0;
  constructor(private readonly k: number = 3) {}

  // 관측 후 stuck 여부 반환. 같은 키 K회 연속이면 true.
  observe(progressKey: string): boolean {
    if (progressKey === this.last) this.streak++;
    else { this.last = progressKey; this.streak = 1; }
    return this.streak >= this.k;
  }
}
