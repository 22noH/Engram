import { Injectable } from '@nestjs/common';
import { ReaderAgent } from './reader-agent';
import { ConversationStore } from '../knowledge-core/conversation-store';
import { PinoLogger } from '../pal/logger';
import { CoreMessage } from '../edge/core-message';

// 허브(설계 §7.1). 모든 흐름이 경유 — Gateway는 Orchestrator만 알고 에이전트를 직접 모른다.
// 매 턴 대화를 ConversationStore에 적재(B 수집 소스).
@Injectable()
export class Orchestrator {
  constructor(
    private readonly reader: ReaderAgent,
    private readonly conversations: ConversationStore,
    private readonly logger: PinoLogger,
  ) {}

  async route(msg: CoreMessage, onChunk?: (t: string) => void): Promise<string> {
    const answer = await this.reader.handle(msg, onChunk);
    try {
      await this.conversations.append(msg.userId, {
        ts: new Date().toISOString(), question: msg.text, answer,
      });
    } catch (err) {
      // 부수효과(대화 적재) 실패가 답변 경로를 죽이지 않게(§10.3)
      this.logger.warn(`대화 적재 실패(답변은 정상 반환): ${String(err)}`, 'Orchestrator');
    }
    return answer;
  }
}
