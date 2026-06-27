import { Injectable, Optional } from '@nestjs/common';
import { ReaderAgent } from './reader-agent';
import { ConversationStore } from '../knowledge-core/conversation-store';
import { PinoLogger } from '../pal/logger';
import { CoreMessage } from '../edge/core-message';
import { IngesterAgent } from './ingester-agent';
import { DEFAULT_USER } from '../pal/path-resolver';
import { TaskStore } from '../knowledge-core/task-store';
import { SpecialistAgent } from './specialist-agent';
import { Synthesizer } from './synthesizer';
import { Semaphore } from '../brain/semaphore';
import { TurnBudget } from './turn-budget';
import { BrainProvider } from '../brain/brain.port';
import { parseJsonBlock } from './parse-json-block';

// 허브(설계 §7.1). 모든 흐름이 경유 — Gateway는 Orchestrator만 알고 에이전트를 직접 모른다.
// 매 턴 대화를 ConversationStore에 적재(B 수집 소스).
@Injectable()
export class Orchestrator {
  constructor(
    private readonly reader: ReaderAgent,
    private readonly conversations: ConversationStore,
    private readonly logger: PinoLogger,
    private readonly ingester: IngesterAgent,
    @Optional() private readonly tasks?: TaskStore,
    @Optional() private readonly specialist?: SpecialistAgent,
    @Optional() private readonly synthesizer?: Synthesizer,
    @Optional() private readonly sem?: Semaphore,
  ) {}

  digest(userId: string = DEFAULT_USER): Promise<{ extracted: number; gated: number; proposed: number }> {
    return this.ingester.run(userId);
  }

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

  // B 협업(설계 §4): 분해는 호출자가 결정(personas), 여기서 배정·수집·종합. 유일 배정구(seam #1).
  async collaborate(
    question: string,
    personas: string[],
    userId: string = DEFAULT_USER,
    opts: { turnBudget?: number } = {},
  ): Promise<string> {
    if (!this.tasks || !this.specialist || !this.synthesizer || !this.sem) {
      throw new Error('협업 협력자가 주입되지 않음(Orchestrator)');
    }
    const budget = new TurnBudget(opts.turnBudget ?? personas.length + 1);
    const session = await this.tasks.create({ kind: 'collaboration', question, assignees: personas });
    await this.tasks.transition(session.id, 'RUNNING');
    await Promise.all(
      personas.map((p) =>
        this.sem!.run(async () => {
          if (!budget.tryConsume()) return; // 예산 소진 → 스킵(턴 천장)
          try {
            const text = await this.specialist!.contribute(p, question, userId);
            await this.tasks!.contribute(session.id, p, text);
          } catch (err) {
            this.logger.warn(`페르소나 기여 실패(스킵) ${p}: ${String(err)}`, 'Orchestrator');
          }
        }),
      ),
    );
    const fresh = await this.tasks.get(session.id);
    const result = await this.synthesizer.synthesize(question, fresh?.blackboard ?? {});
    await this.tasks.setResult(session.id, result);
    await this.tasks.transition(session.id, 'SUCCESS');
    return result;
  }

  // 분해=설계(설계 §4-1). 안 겹치는 영역으로 분할 → 티켓. 직접호출 0(seam #1).
  async decompose(goal: string, brain: BrainProvider): Promise<Array<{ id: string; area: string; instruction: string }>> {
    const prompt = [
      '아래 목표를 서로 겹치지 않는(다른 파일/영역) 작업 조각으로 분할하라.',
      '각 조각은 독립적으로 코딩·검증 가능해야 한다.',
      `\n# 목표\n${goal}`,
      '\n반드시 이 JSON만: {"tickets":[{"area":"디렉터리/영역","instruction":"할 일"}]}',
    ].join('\n');
    const r = await brain.complete(prompt);
    const tickets = this.parseTickets(r.isError ? '' : r.text);
    if (tickets.length === 0) return [{ id: this.ticketId(0), area: '.', instruction: goal }];
    return tickets.map((t, i) => ({ id: this.ticketId(i), area: t.area, instruction: t.instruction }));
  }

  private ticketId(i: number): string {
    return `tk_${new Date().toISOString().replace(/[:.]/g, '-')}_${i}`;
  }

  // 기존 parseJsonBlock(Task 8) 재사용 — 새 스캐너 안 만듦.
  private parseTickets(text: string): Array<{ area: string; instruction: string }> {
    const o = parseJsonBlock<{ tickets?: unknown }>(text);
    return o && Array.isArray(o.tickets)
      ? o.tickets.filter((t: any) => t && typeof t.area === 'string' && typeof t.instruction === 'string')
          .map((t: any) => ({ area: t.area, instruction: t.instruction }))
      : [];
  }
}
