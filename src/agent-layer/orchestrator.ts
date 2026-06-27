import { Injectable, Optional, Inject } from '@nestjs/common';
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
import { BrainProvider, BRAIN } from '../brain/brain.port';
import { parseJsonBlock } from './parse-json-block';
import { ProjectStore, ProjectConfig } from '../knowledge-core/project-store';
import { VerificationGate } from './verification-gate';
import { CodingGit } from '../knowledge-core/coding-git';
import { CodingSpecialist } from './coding-specialist';
import { ReviewerAgent } from './reviewer-agent';
import { StuckDetector } from './stuck-detector';

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
    @Optional() private readonly projects?: ProjectStore,
    @Optional() private readonly gate?: VerificationGate,
    @Optional() private readonly codingGit?: CodingGit,
    @Optional() private readonly coder?: CodingSpecialist,
    @Optional() private readonly reviewer?: ReviewerAgent,
    @Optional() @Inject(BRAIN) private readonly codeBrain?: BrainProvider,
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

  private runState: 'running' | 'paused' | 'stopped' = 'running';
  setRunState(s: 'running' | 'paused' | 'stopped'): void { this.runState = s; }
  getRunState(): string { return this.runState; }

  // 코딩 루프(설계 §4). 유일 배정구(seam #1). run-state로 stop·stuck·budget 통합(§6).
  async codeRun(
    projectId: string,
    opts: { maxRounds?: number; stuckK?: number; onChunk?: (t: string) => void } = {},
  ): Promise<{ status: 'SUCCESS' | 'STUCK' | 'STOPPED' | 'BUDGET'; sessionId: string }> {
    if (!this.projects || !this.gate || !this.codingGit || !this.coder || !this.reviewer || !this.sem || !this.codeBrain) {
      throw new Error('코딩 협력자가 주입되지 않음(Orchestrator.codeRun)');
    }
    const project = await this.projects.get(projectId);
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`);
    if (!project.approved) throw new Error(`완성조건 미승인 — engram code 승인 먼저: ${projectId}`);

    await this.codingGit.ensureBranch(project.targetPath, project.branch);
    const session = await this.tasks!.createCoding({
      question: project.acceptanceCriteria.join(' / '), projectRef: projectId,
      criteriaTotal: project.acceptanceCriteria.length,
    });
    await this.tasks!.transition(session.id, 'RUNNING');
    const initial = await this.decompose(project.acceptanceCriteria.join('\n'), this.codeBrain);
    await this.tasks!.addTickets(session.id, initial);

    const stuck = new StuckDetector(opts.stuckK ?? 3);
    const maxRounds = opts.maxRounds ?? 100;
    let budgetSpent = 0;

    for (let round = 0; round < maxRounds; round++) {
      if (this.runState !== 'running') return this.exit(session, 'STOPPED');

      const fresh = await this.tasks!.get(session.id);
      const open = (fresh?.tickets ?? []).filter((t) => t.status !== 'SUCCESS');

      // 동시 코딩(공유 체크아웃, N=concurrency). Semaphore가 동시 호출 제한.
      await Promise.all(open.map((ticket) => this.sem!.run(async () => {
        if (this.runState !== 'running') return;
        try {
          await this.tasks!.updateTicket(session.id, ticket.id, { status: 'RUNNING', attempts: ticket.attempts + 1 });
          const summary = await this.coder!.work(this.pickPersona(project), ticket, project, opts.onChunk);
          budgetSpent += 1; // ponytail: 호출 수 근사. 실토큰 회계는 후속(§14).
          const result = await this.gate!.run(project.targetPath, project.gate);
          if (result.pass) {
            await this.codingGit!.commitAll(project.targetPath, `engram: ${ticket.id} ${ticket.area}`);
            await this.tasks!.updateTicket(session.id, ticket.id, { status: 'SUCCESS', gate: { pass: true, output: summary } });
            await this.tasks!.contribute(session.id, ticket.id, summary);
          } else {
            await this.tasks!.updateTicket(session.id, ticket.id, { status: 'PENDING', gate: { pass: false, output: result.output } });
          }
        } catch (err) {
          this.logger.warn(`코딩 티켓 실패(재시도 대기) ${ticket.id}: ${String(err)}`, 'Orchestrator');
          await this.tasks!.updateTicket(session.id, ticket.id, { status: 'PENDING' });
        }
      })));

      const after = await this.tasks!.get(session.id);
      const landed = (after?.tickets ?? []).filter((t) => t.status === 'SUCCESS').length;
      const total = after?.tickets?.length ?? 0;
      const allLanded = total > 0 && landed === total;
      // criteriaMet을 한 번만 계산해 recordProgress와 stuck 관측 모두 사용(불일치 방지).
      const criteriaMet = allLanded ? project.acceptanceCriteria.length : 0;
      await this.tasks!.recordProgress(session.id, { landed, criteriaMet });

      if (allLanded) {
        // SUCCESS는 리뷰어 승인 경유만 — 오픈 티켓 0이어도 여기서 판정(우회 차단).
        const review = await this.reviewer!.review(project.acceptanceCriteria, Object.values(after?.blackboard ?? {}).join('\n'));
        if (review.approved) return this.exit(session, 'SUCCESS');
        await this.tasks!.addTickets(session.id, review.extraTickets.map((t, i) => ({ id: `tk_rev_${round}_${i}`, area: t.area, instruction: t.instruction })));
      }

      if (project.budget.tokens !== null && budgetSpent >= project.budget.tokens) { this.runState = 'paused'; return this.exit(session, 'BUDGET'); }
      // 방금 기록한 진전 값으로 stuck 관측(재조회 불필요). progressKey = landed:criteriaMet.
      if (stuck.observe(`${landed}:${criteriaMet}`)) { this.runState = 'paused'; return this.exit(session, 'STUCK'); }
    }
    return this.exit(session, 'STUCK');
  }

  private pickPersona(_project: ProjectConfig): string {
    return 'Infra'; // ponytail: 코딩 페르소나 1개로 시작. 영역별 라우팅은 후속(§14).
  }

  private async exit(
    session: { id: string },
    status: 'SUCCESS' | 'STUCK' | 'STOPPED' | 'BUDGET',
  ): Promise<{ status: 'SUCCESS' | 'STUCK' | 'STOPPED' | 'BUDGET'; sessionId: string }> {
    if (status === 'SUCCESS') {
      await this.tasks!.setResult(session.id, '완성조건 충족 — 사람 머지 대기');
      await this.tasks!.transition(session.id, 'SUCCESS');
      await this.tasks!.remove(session.id); // 진행상태 일회용 — 완료 시 삭제(findings는 위키 보존)
    } else {
      this.logger.warn(`코딩 세션 ${status}: ${session.id} — 사람 알림`, 'Orchestrator');
    }
    return { status, sessionId: session.id };
  }
}
