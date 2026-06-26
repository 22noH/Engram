import { Injectable } from '@nestjs/common';
import { ReaderAgent } from './reader-agent';
import { CoreMessage } from '../edge/core-message';

// 허브(설계 §7.1). 모든 흐름이 경유 — Gateway는 Orchestrator만 알고 에이전트를 직접 모른다.
// Phase 1은 단일 에이전트라 위임만. Phase 3에서 분해·종합·TurnBudget이 여기 채워진다.
@Injectable()
export class Orchestrator {
  constructor(private readonly reader: ReaderAgent) {}

  route(msg: CoreMessage, onChunk?: (t: string) => void): Promise<string> {
    return this.reader.handle(msg, onChunk);
  }
}
