import { Injectable } from '@nestjs/common';
import { Orchestrator } from './orchestrator';
import { WikiEngine } from '../knowledge-core/wiki/wiki-engine';
import { TaskStore } from '../knowledge-core/task-store';
import { PinoLogger } from '../pal/logger';
import { DEFAULT_USER } from '../pal/path-resolver';

export interface MeetingDef { name: string; schedule: string; roster: string[]; agenda: string }

// 제네릭 회의 = 안건 고정 협업(설계 §7). 산출물: 회의록=위키, 결정=TaskStore(board-decision).
@Injectable()
export class MeetingEngine {
  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly wiki: WikiEngine,
    private readonly tasks: TaskStore,
    private readonly logger: PinoLogger,
  ) {}

  async run(def: MeetingDef, userId: string = DEFAULT_USER): Promise<{ minutesSlug: string; decisionId: string }> {
    const summary = await this.orchestrator.collaborate(def.agenda, def.roster, userId);
    const date = new Date().toISOString().slice(0, 10);
    const slug = `meeting-${def.name}-${date}`;
    // Record(서기)가 회의록을 위키에(설계 §7.3 산출물 매핑). 회의록은 확정 기록 → published.
    await this.wiki.createPage(
      { slug, title: `${def.name} 회의록 (${date})`, category: 'meeting', body: `# 안건\n${def.agenda}\n\n# 결론\n${summary}`, status: 'published' },
      userId,
    );
    const decision = await this.tasks.create({ kind: 'board-decision', question: def.agenda, assignees: def.roster });
    await this.tasks.transition(decision.id, 'RUNNING');
    await this.tasks.setResult(decision.id, summary);
    await this.tasks.transition(decision.id, 'SUCCESS');
    this.logger.log(`회의 완료: ${def.name} → ${slug}`, 'MeetingEngine');
    return { minutesSlug: slug, decisionId: decision.id };
  }
}
