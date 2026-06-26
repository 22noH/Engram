import { Injectable } from '@nestjs/common';
import { ReaderAgent } from './reader-agent';
import { ConversationStore } from '../knowledge-core/conversation-store';
import { CoreMessage } from '../edge/core-message';

// 허브(설계 §7.1). 모든 흐름이 경유 — Gateway는 Orchestrator만 알고 에이전트를 직접 모른다.
// 매 턴 대화를 ConversationStore에 적재(B 수집 소스).
@Injectable()
export class Orchestrator {
  constructor(
    private readonly reader: ReaderAgent,
    private readonly conversations: ConversationStore,
  ) {}

  async route(msg: CoreMessage, onChunk?: (t: string) => void): Promise<string> {
    const answer = await this.reader.handle(msg, onChunk);
    await this.conversations.append(msg.userId, {
      ts: new Date().toISOString(), question: msg.text, answer,
    });
    return answer;
  }
}
