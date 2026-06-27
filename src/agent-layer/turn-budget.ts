// 협업 세션당 총 두뇌호출 상한(설계 §8). 소진 시 추가 배정 중단 → 가진 것으로 종합.
export class TurnBudget {
  private spent = 0;
  constructor(private readonly max: number) {}
  tryConsume(): boolean {
    if (this.spent >= this.max) return false;
    this.spent++;
    return true;
  }
  remaining(): number { return Math.max(0, this.max - this.spent); }
  used(): number { return this.spent; }
}
