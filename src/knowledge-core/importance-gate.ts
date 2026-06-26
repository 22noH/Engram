import { Injectable } from '@nestjs/common';

export interface ScoredFact { claim: string; importance: number; sourceQuote: string }

@Injectable()
export class ImportanceGate {
  readonly threshold: number;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    const n = Number(env.ENGRAM_IMPORTANCE_THRESHOLD);
    this.threshold = Number.isFinite(n) && n >= 1 && n <= 5 ? n : 3; // §5.3 1~5, 기본 3
  }
  filter(facts: ScoredFact[]): ScoredFact[] {
    return facts.filter((x) => x.importance >= this.threshold);
  }
}
