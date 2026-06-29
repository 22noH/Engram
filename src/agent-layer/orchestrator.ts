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
import { detectGate } from './gate-detect';
import { loadPrompt } from './prompt-store';

// prompts/decompose.md 없을 때의 내장 기본값. JSON 계약은 decompose()가 코드에서 덧붙인다.
const DECOMPOSE_DEFAULT = [
  '아래 목표를 작업 조각으로 분할하라.',
  '**가능한 한 적게 나눠라.** 목표가 작거나 한 영역(한두 파일)이면 작업 1개로 둬라.',
  '진짜로 독립적인(서로 다른 파일/영역, 겹치지 않는) 부분일 때만 여러 개로 쪼개라 — 과분해는 에이전트끼리 같은 파일을 두고 혼란을 일으킨다.',
].join('\n');

// prompts/triage.md 없을 때의 내장 기본값. JSON 계약은 classify()가 코드에서 덧붙인다.
const TRIAGE_DEFAULT = [
  '사용자 메시지가 (1) 단순 질문/잡담인지 "chat", (2) 여러 전문가가 머리를 맞대야 하는 일인지 "collaborate"인지 판정하라.',
  'collaborate면 아래 전문가 목록에서 이 일에 꼭 필요한 사람만 골라 team에 이름을 넣어라(없으면 빈 배열).',
  '확실치 않으면 chat을 택하라.',
].join('\n');
import { CodingGit } from '../knowledge-core/coding-git';
import { CodingSpecialist } from './coding-specialist';
import { ReviewerAgent } from './reviewer-agent';
import { StuckDetector } from './stuck-detector';
import { PermissionFence } from './permission-fence';
import { InsightReporter } from './insight-reporter';
import { DayInsight } from '../knowledge-core/insight/insight-store';
import { PersonaRegistry } from './persona-registry';

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
    @Optional() private readonly fence?: PermissionFence,
    @Optional() private readonly reporter?: InsightReporter,
    @Optional() private readonly registry?: PersonaRegistry,
  ) {}

  digest(userId: string = DEFAULT_USER): Promise<{ extracted: number; gated: number; proposed: number }> {
    return this.ingester.run(userId);
  }

  // 일일 인사이트 생성(설계 §5.4). DigestScheduler→digest와 동렬: 스케줄러·CLI가 호출.
  insight(userId: string = DEFAULT_USER): Promise<DayInsight | null> {
    if (!this.reporter) throw new Error('InsightReporter 미주입(Orchestrator)');
    return this.reporter.run(userId);
  }

  async route(msg: CoreMessage, onChunk?: (t: string) => void): Promise<string> {
    let sources: string[] = [];
    const answer = await this.reader.handle(msg, onChunk, (s) => { sources = s; });
    try {
      await this.conversations.append(msg.userId, {
        ts: new Date().toISOString(), question: msg.text, answer, sources,
      });
    } catch (err) {
      // 부수효과(대화 적재) 실패가 답변 경로를 죽이지 않게(§10.3)
      this.logger.warn(`대화 적재 실패(답변은 정상 반환): ${String(err)}`, 'Orchestrator');
    }
    return answer;
  }

  // 멘션 진입점(Phase 6a, the colleague brain). 허브가 유일 배정구(§7.1) 유지.
  // 두뇌 1콜로 {chat | collaborate, team}을 받아 기존 엔진으로 디스패치. 막다른 길 없음.
  async handleMention(msg: CoreMessage, onAck?: (t: string) => Promise<void>): Promise<string> {
    const trimmed = msg.text.trim();

    // escape hatch(접근 C): 명시 명령은 분류를 건너뛰고 직접 실행 — 두뇌 판단이 빗나갈 때 수동 우회.
    if (trimmed.startsWith('team ')) {
      const rest = trimmed.slice('team '.length);
      const sp = rest.indexOf(' ');
      const names = (sp < 0 ? rest : rest.slice(0, sp)).split(',').map((s) => s.trim()).filter(Boolean);
      const q = sp < 0 ? '' : rest.slice(sp + 1);
      return this.collaborate(q, names.length ? names : ['Manager'], msg.userId);
    }
    if (trimmed.startsWith('ask ')) {
      return this.route({ text: trimmed.slice('ask '.length), userId: msg.userId });
    }

    const decision = await this.classify(msg.text);
    if (decision.kind === 'collaborate') {
      const team = decision.team.length ? decision.team : ['Manager'];
      if (onAck) await onAck('알아볼게요');
      return this.collaborate(msg.text, team, msg.userId);
    }
    return this.route(msg);
  }

  // 멘션 분류 + 로스터 선택(두뇌 1콜). 실패는 전부 chat 폴백(상주를 막지 않음).
  private async classify(text: string): Promise<{ kind: 'chat' | 'collaborate'; team: string[] }> {
    if (!this.codeBrain) return { kind: 'chat', team: [] };
    const roster = (this.registry?.all() ?? []).map((p) => `- ${p.name}: ${p.role}`).join('\n');
    const prompt = [
      loadPrompt('triage', TRIAGE_DEFAULT),
      `\n# 사용 가능한 전문가\n${roster || '(없음)'}`,
      `\n# 사용자 메시지\n${text}`,
      '\n반드시 이 JSON만: {"kind":"chat"|"collaborate","team":["이름",...]}',
    ].join('\n');
    try {
      const r = await this.codeBrain.complete(prompt);
      if (r.isError) return { kind: 'chat', team: [] };
      const o = parseJsonBlock<{ kind?: unknown; team?: unknown }>(r.text);
      const kind = o && o.kind === 'collaborate' ? 'collaborate' : 'chat';
      const team = o && Array.isArray(o.team) ? o.team.map(String) : [];
      return { kind, team };
    } catch {
      return { kind: 'chat', team: [] };
    }
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
      loadPrompt('decompose', DECOMPOSE_DEFAULT),
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

  // 시작 게이트(설계 §4-0, D). 완성조건은 두뇌 추정, 게이트는 프로젝트 파일에서 *결정적 탐지*
  // (두뇌 추측 'node x.js'는 로드만 보고 거짓 통과 → detectGate로 package.json/tsconfig 직접 읽음).
  async proposeProject(targetPath: string, goal: string): Promise<ProjectConfig> {
    if (!this.projects || !this.codeBrain || !this.fence) throw new Error('proposeProject 협력자 미주입');
    this.fence.assertWritable(targetPath); // denyPaths/writePaths 밖 거부(자기수정 차단 ③)
    const prompt = [
      '아래 목표에 대한 완성조건(검증 가능한 항목)을 추정하라.',
      `\n# 목표\n${goal}\n# 타깃 경로\n${targetPath}`,
      '\n반드시 이 JSON만: {"acceptanceCriteria":["..."]}',
    ].join('\n');
    const r = await this.codeBrain.complete(prompt);
    const draft = this.parseProposal(r.isError ? '' : r.text);
    const id = `proj_${targetPath.replace(/[^a-zA-Z0-9]/g, '_').slice(-24)}_${this.hashPath(targetPath)}`;
    const cfg: ProjectConfig = {
      id, targetPath, branch: `engram/${id}`,
      gate: detectGate(targetPath), acceptanceCriteria: draft.acceptanceCriteria,
      writePaths: [targetPath], concurrency: 1, budget: { tokens: null }, approved: false,
    };
    await this.projects.create(cfg);
    return cfg;
  }

  async approveProject(projectId: string): Promise<void> {
    if (!this.projects) throw new Error('projects 미주입');
    await this.projects.update(projectId, { approved: true });
  }

  // 기존 parseJsonBlock 재사용(T8). 게이트는 detectGate가 담당 — 여기선 완성조건만.
  private parseProposal(text: string): { acceptanceCriteria: string[] } {
    const o = parseJsonBlock<{ acceptanceCriteria?: unknown }>(text);
    return { acceptanceCriteria: o && Array.isArray(o.acceptanceCriteria) ? o.acceptanceCriteria.map(String) : [] };
  }

  private runState: 'running' | 'paused' | 'stopped' = 'running';
  setRunState(s: 'running' | 'paused' | 'stopped'): void { this.runState = s; }
  getRunState(): string { return this.runState; }

  // 코딩 루프(설계 §4). 유일 배정구(seam #1). run-state로 stop·stuck·budget 통합(§6).
  async codeRun(
    projectId: string,
    opts: { maxRounds?: number; stuckK?: number; onChunk?: (t: string) => void; onProgress?: (m: string) => void } = {},
  ): Promise<{ status: 'SUCCESS' | 'STUCK' | 'STOPPED' | 'BUDGET'; sessionId: string }> {
    if (!this.projects || !this.gate || !this.codingGit || !this.coder || !this.reviewer || !this.sem || !this.codeBrain || !this.fence) {
      throw new Error('코딩 협력자가 주입되지 않음(Orchestrator.codeRun)');
    }
    // 진행 narrate(블랙박스 방지). CLI가 stdout으로 흘린다.
    const report = opts.onProgress ?? ((): void => {});
    const project = await this.projects.get(projectId);
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`);
    if (!project.approved) throw new Error(`완성조건 미승인 — engram code 승인 먼저: ${projectId}`);

    // 심층 방어: codeRun 진입 시점에도 쓰기 권한 재검증(proposeProject 이후 설정 변경 대비).
    this.fence.assertWritable(project.targetPath);

    await this.codingGit.ensureBranch(project.targetPath, project.branch);
    const session = await this.tasks!.createCoding({
      question: project.acceptanceCriteria.join(' / '), projectRef: projectId,
      criteriaTotal: project.acceptanceCriteria.length,
    });
    await this.tasks!.transition(session.id, 'RUNNING');
    report(`작업 분해 중… (두뇌 호출)`);
    const initial = await this.decompose(project.acceptanceCriteria.join('\n'), this.codeBrain);
    await this.tasks!.addTickets(session.id, initial);
    report(`분해 완료 — 작업 ${initial.length}개`);

    const stuck = new StuckDetector(opts.stuckK ?? 3);
    const maxRounds = opts.maxRounds ?? 100;
    let budgetSpent = 0;

    for (let round = 0; round < maxRounds; round++) {
      if (this.runState !== 'running') return this.exit(session, 'STOPPED');

      const fresh = await this.tasks!.get(session.id);
      const open = (fresh?.tickets ?? []).filter((t) => t.status !== 'SUCCESS');
      report(`라운드 ${round + 1}: 작업 ${open.length}개 진행`);

      // 동시 코딩(공유 체크아웃, N=concurrency). Semaphore가 동시 호출 제한.
      await Promise.all(open.map((ticket) => this.sem!.run(async () => {
        if (this.runState !== 'running') return;
        try {
          report(`  코딩 중: ${ticket.area} — ${ticket.instruction}`);
          await this.tasks!.updateTicket(session.id, ticket.id, { status: 'RUNNING', attempts: ticket.attempts + 1 });
          const summary = await this.coder!.work(this.pickPersona(project), ticket, project, opts.onChunk);
          budgetSpent += 1; // ponytail: 호출 수 근사. 실토큰 회계는 후속(§14).
          report(`  게이트 실행 중: ${ticket.area}`);
          const result = await this.gate!.run(project.targetPath, project.gate);
          if (result.pass) {
            await this.codingGit!.commitAll(project.targetPath, `engram: ${ticket.id} ${ticket.area}`);
            await this.tasks!.updateTicket(session.id, ticket.id, { status: 'SUCCESS', gate: { pass: true, output: summary } });
            await this.tasks!.contribute(session.id, ticket.id, summary);
            report(`  ✓ 착지: ${ticket.area}`);
          } else {
            await this.tasks!.updateTicket(session.id, ticket.id, { status: 'PENDING', gate: { pass: false, output: result.output } });
            report(`  ✗ 게이트 빨강(재시도 대기): ${ticket.area} [${result.failed ?? '실패'}]`);
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
        report(`완성조건 리뷰 중…`);
        const review = await this.reviewer!.review(project.acceptanceCriteria, Object.values(after?.blackboard ?? {}).join('\n'));
        if (review.approved) { report(`✓ 완성조건 충족 — 완료`); return this.exit(session, 'SUCCESS'); }
        report(`리뷰어 추가 작업 ${review.extraTickets.length}개`);
        await this.tasks!.addTickets(session.id, review.extraTickets.map((t, i) => ({ id: `tk_rev_${round}_${i}`, area: t.area, instruction: t.instruction })));
      }

      if (project.budget.tokens !== null && budgetSpent >= project.budget.tokens) { this.runState = 'paused'; return this.exit(session, 'BUDGET'); }
      // 방금 기록한 진전 값으로 stuck 관측(재조회 불필요). progressKey = landed:criteriaMet.
      if (stuck.observe(`${landed}:${criteriaMet}`)) { this.runState = 'paused'; return this.exit(session, 'STUCK'); }
    }
    return this.exit(session, 'STUCK');
  }

  // djb2 해시(결정적, 외부 의존 없음). 서로 다른 경로의 id 충돌 방지.
  private hashPath(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
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
