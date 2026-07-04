import { Injectable, Optional, Inject } from '@nestjs/common';
import { ReaderAgent } from './reader-agent';
import { ConversationStore } from '../knowledge-core/conversation-store';
import { PinoLogger } from '../pal/logger';
import { CoreMessage } from '../edge/core-message';
import { IngesterAgent } from './ingester-agent';
import { DEFAULT_USER, PathResolver } from '../pal/path-resolver';
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
import { CodingGit } from '../knowledge-core/coding-git';
import { CodingSpecialist } from './coding-specialist';
import { ReviewerAgent } from './reviewer-agent';
import { StuckDetector } from './stuck-detector';
import { PermissionFence } from './permission-fence';
import { InsightReporter } from './insight-reporter';
import { DayInsight } from '../knowledge-core/insight/insight-store';
import { PersonaRegistry } from './persona-registry';
import { MentionTracker, TrackedTask } from './mention-tracker';
import { loadCodeRepos, resolveRepo, CodeReposConfig } from './coderepos';
import { loadChannelPolicy, allows, ChannelPolicy } from './channel-policy';
import { SchedulerPort, ScheduleEntry } from './schedule-store';
import { computeResume } from './resume-policy';
import { RagStore } from '../knowledge-core/rag/rag-store';

// prompts/decompose.md 없을 때의 내장 기본값. JSON 계약은 decompose()가 코드에서 덧붙인다.
const DECOMPOSE_DEFAULT = [
  '아래 목표를 작업 조각으로 분할하라.',
  '**가능한 한 적게 나눠라.** 목표가 작거나 한 영역(한두 파일)이면 작업 1개로 둬라.',
  '진짜로 독립적인(서로 다른 파일/영역, 겹치지 않는) 부분일 때만 여러 개로 쪼개라 — 과분해는 에이전트끼리 같은 파일을 두고 혼란을 일으킨다.',
].join('\n');

// prompts/ambient.md 없을 때의 내장 기본값. JSON 계약은 observe()가 코드에서 덧붙인다.
const AMBIENT_DEFAULT = [
  '대화 메시지와 위키 발췌가 주어진다. 위키 정보가 이 대화에 실질적으로 도움이 될 때만 끼어들어라.',
  '확실하지 않으면 끼어들지 마라 — interject=false가 기본값이다.',
  '끼어들 땐 한두 문장으로 요점만, 근거 위키 페이지(slug)를 함께 밝혀라.',
].join('\n');

// prompts/triage.md 없을 때의 내장 기본값. JSON 계약은 classify()가 코드에서 덧붙인다.
const TRIAGE_DEFAULT = [
  '사용자 메시지가 (1) 단순 질문/잡담인지 "chat", (2) 여러 전문가가 머리를 맞대야 하는 일인지 "collaborate"인지 판정하라.',
  'collaborate면 아래 전문가 목록에서 이 일에 꼭 필요한 사람만 골라 team에 이름을 넣어라(없으면 빈 배열).',
  '(3) 특정 레포(코드 저장소)에 코드를 쓰거나 고치거나 구현하라는 일이면 "code" — repo에 레포 참조(이름/별칭/경로), goal에 할 일을 넣어라.',
  '(4) 정해진 시간/주기에 무언가를 하라는 예약이면 "schedule" — cron에 5필드 cron(예: 매일 9시=0 9 * * *), task에 할 일, 반복 아니고 한 번이면 once=true를 넣어라.',
  '확실치 않으면 chat을 택하라.',
].join('\n');

// 코딩 위임 대기(스레드별 2단: 후보 선택 → 승인). 6b-2.
type PendingCode =
  | { kind: 'disambiguate'; candidates: string[]; goal: string }
  | { kind: 'approve'; projectId: string; path: string };

// 허브(설계 §7.1). 모든 흐름이 경유 — Gateway는 Orchestrator만 알고 에이전트를 직접 모른다.
// 매 턴 대화를 ConversationStore에 적재(B 수집 소스).
@Injectable()
export class Orchestrator {
  // 멘션 작업 상태(in-memory) + 백그라운드 inflight(테스트 drain용). ponytail: 재시작 소실은 6b-3.
  private readonly tracker = new MentionTracker();
  private readonly inflight: Promise<void>[] = [];
  // 코딩 위임 대기(스레드별 2단: 후보 선택 → 승인). 6b-2.
  private readonly pending = new Map<string, PendingCode>();
  private codeReposCache?: CodeReposConfig;
  private channelPolicyCache?: ChannelPolicy;
  // 예약(스케줄) 포트 — main.ts에서 setter 주입(메신저처럼 DI 밖). 6b-3.
  private scheduler?: SchedulerPort;

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
    @Optional() private readonly paths?: PathResolver,
    @Optional() private readonly rag?: RagStore,
  ) {}

  digest(userId: string = DEFAULT_USER): Promise<{ extracted: number; gated: number; proposed: number }> {
    return this.ingester.run(userId);
  }

  // 일일 인사이트 생성(설계 §5.4). date 생략=오늘(기존), 지정=그 날(ambient가 어제를 넘김).
  insight(userId: string = DEFAULT_USER, date?: string): Promise<DayInsight | null> {
    if (!this.reporter) throw new Error('InsightReporter 미주입(Orchestrator)');
    return this.reporter.run(userId, date);
  }

  setScheduler(scheduler: SchedulerPort): void {
    this.scheduler = scheduler;
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

  // 멘션 진입점(Phase 6a→6b-1, the colleague brain). 허브가 유일 배정구(§7.1) 유지.
  // post 콜백 모델: ack·진행·결과·상태를 여러 번 게시. collaborate는 백그라운드로 detach.
  async handleMention(
    msg: CoreMessage,
    post: (text: string) => Promise<void>,
    threadKey: string = msg.userId,
  ): Promise<void> {
    const trimmed = msg.text.trim();

    // 상태 조회: 이 스레드의 진행/최근 작업 보고.
    if (trimmed === '상태' || trimmed === 'status') {
      await post(this.formatStatus(this.tracker.status(threadKey)));
      return;
    }
    // 코딩 위임 대기 처리(pending 있을 때만 — 없으면 통과해 일반 대화로).
    const p = this.pending.get(threadKey);
    if (p) {
      if (trimmed === '취소' || trimmed === '아니오' || trimmed === 'cancel') {
        this.pending.delete(threadKey);
        await post('취소했어요.');
        return;
      }
      if (p.kind === 'disambiguate') {
        if (/^\d+$/.test(trimmed)) {
          const n = parseInt(trimmed, 10);
          if (n < 1 || n > p.candidates.length) { await post(`1~${p.candidates.length} 중에서 골라주세요.`); return; }
          this.pending.delete(threadKey);
          await this.startProposal(p.candidates[n - 1], p.goal, threadKey, post);
          return;
        }
        // 비숫자·비취소 → 이 스레드의 모호선택을 포기(스테일 방지), 아래 일반 처리로 흐름.
        this.pending.delete(threadKey);
      } else if (p.kind === 'approve' && (trimmed === '승인' || trimmed === 'approve')) {
        this.pending.delete(threadKey);
        await this.approveProject(p.projectId);
        this.launchCoding(p.projectId, p.path, threadKey, post);
        return;
      }
    }
    // escape hatch: code <repoRef> <goal>
    if (trimmed.startsWith('code ')) {
      const rest = trimmed.slice('code '.length);
      const sp = rest.indexOf(' ');
      const repoRef = sp < 0 ? rest : rest.slice(0, sp);
      const goal = sp < 0 ? '' : rest.slice(sp + 1);
      if (!(await this.channelGate('coding', msg.userId, post))) return;
      await this.startCoding(repoRef, goal, threadKey, post);
      return;
    }
    // 예약(스케줄) 관리 명령
    if (trimmed === '예약목록' || trimmed === 'schedules') {
      await post(this.formatSchedules(msg.userId));
      return;
    }
    if (trimmed.startsWith('예약취소 ') || trimmed.startsWith('schedule cancel ')) {
      const id = (trimmed.startsWith('예약취소 ') ? trimmed.slice('예약취소 '.length) : trimmed.slice('schedule cancel '.length)).trim();
      if (!this.scheduler) { await post('예약 기능이 준비되지 않았어요.'); return; }
      const mine = this.scheduler.list(msg.userId).some((e) => e.id === id);
      const ok = mine && this.scheduler.remove(id);
      await post(ok ? '취소했어요.' : '그 예약을 못 찾았어요.');
      return;
    }
    if (trimmed.startsWith('schedule ')) {
      const rest = trimmed.slice('schedule '.length).trim();
      const parts = rest.split(' ').filter(Boolean);
      const cron = parts.slice(0, 5).join(' ');
      const task = parts.slice(5).join(' ');
      if (!(await this.channelGate('schedule', msg.userId, post))) return;
      await this.doSchedule(cron, task, false, msg.userId, threadKey, post);
      return;
    }
    // 자가 재개(6b-3-2): 예약 발사 재주입용 내부 명령(사용자 직접 입력도 동작 — 승인된 프로젝트 재실행뿐).
    if (trimmed.startsWith('resume ')) {
      const parts = trimmed.slice('resume '.length).trim().split(/\s+/);
      const attempt = /^\d+$/.test(parts[1] ?? '') ? parseInt(parts[1], 10) : 0;
      if (!(await this.channelGate('coding', msg.userId, post))) return;
      await this.resumeCoding(parts[0] ?? '', attempt, threadKey, post);
      return;
    }
    // 협업 재시도 재주입(6b-3-2). 형식: retry <attempt> <팀CSV> <질문> — 불일치면 일반 흐름으로.
    if (trimmed.startsWith('retry ')) {
      const m = trimmed.match(/^retry (\d+) (\S+) ([\s\S]+)$/);
      if (m) {
        const attempt = parseInt(m[1], 10);
        const team = m[2].split(',').map((s) => s.trim()).filter(Boolean);
        if (!(await this.channelGate('collaborate', msg.userId, post))) return;
        await post(`팀 구성: ${team.join('·')} — 다시 해볼게요 (재시도 ${attempt}/2)`);
        this.launchCollaboration(m[3], team.length ? team : ['Manager'], msg.userId, threadKey, post, attempt);
        return;
      }
    }
    // escape hatch(접근 C): 명시 명령은 분류를 건너뛰고 직접 실행.
    if (trimmed.startsWith('team ')) {
      const rest = trimmed.slice('team '.length);
      const sp = rest.indexOf(' ');
      const names = (sp < 0 ? rest : rest.slice(0, sp)).split(',').map((s) => s.trim()).filter(Boolean);
      const q = sp < 0 ? '' : rest.slice(sp + 1);
      const team = names.length ? names : ['Manager'];
      if (!(await this.channelGate('collaborate', msg.userId, post))) return;
      await post(`팀 구성: ${team.join('·')} — 알아볼게요`);
      this.launchCollaboration(q, team, msg.userId, threadKey, post);
      return;
    }
    if (trimmed.startsWith('ask ')) {
      await post(await this.route({ text: trimmed.slice('ask '.length), userId: msg.userId }));
      return;
    }

    // Code 채널(Phase 10): classify 건너뛰고 바인딩된 repoPath로 바로 코딩(오분류 차단).
    // 벽은 아님 — 위의 escape hatch(team/ask/code/schedule)가 이미 처리됐다면 여기 안 옴.
    if (msg.mode === 'code') {
      if (!msg.repoPath) {
        await post('이 채널엔 아직 작업 폴더가 없어요. 채널에 들어가 폴더를 먼저 선택해 주세요 📁');
        return;
      }
      if (!(await this.channelGate('coding', msg.userId, post))) return;
      await this.startProposal(msg.repoPath, trimmed, threadKey, post);
      return;
    }

    const decision = await this.classify(trimmed);
    if (decision.kind === 'code') {
      if (!(await this.channelGate('coding', msg.userId, post))) return;
      await this.startCoding(decision.repoRef ?? '', decision.goal ?? msg.text, threadKey, post);
      return;
    }
    if (decision.kind === 'schedule') {
      if (!(await this.channelGate('schedule', msg.userId, post))) return;
      await this.doSchedule(decision.cron ?? '', decision.task ?? '', decision.once ?? false, msg.userId, threadKey, post);
      return;
    }
    if (decision.kind === 'collaborate') {
      if (!(await this.channelGate('collaborate', msg.userId, post))) return;
      const team = decision.team.length ? decision.team : ['Manager'];
      await post(`팀 구성: ${team.join('·')} — 알아볼게요`);
      this.launchCollaboration(msg.text, team, msg.userId, threadKey, post);
      return;
    }
    await post(await this.route(msg));
  }

  // collaborate를 백그라운드로 detach. 끝나면 결과 게시 + 대화로그 적재 + 트래커 종료.
  // 자체 try/catch로 상주를 불사(unhandled rejection 0). inflight는 테스트 drain용.
  private launchCollaboration(
    question: string,
    team: string[],
    userId: string,
    threadKey: string,
    post: (text: string) => Promise<void>,
    attempt = 0,
  ): void {
    const t = this.tracker.start(threadKey, { question, team });
    const work: Promise<void> = (async (): Promise<void> => {
      try {
        const result = await this.collaborate(question, team, userId, { onProgress: post });
        // 채널 기억: 결과를 대화로그에 적재(후속 맥락·B수집 소스). 부수효과 실패는 무시.
        await this.conversations
          .append(userId, { ts: new Date().toISOString(), question, answer: result, sources: [] })
          .catch(() => {});
        this.tracker.finish(threadKey, t.id, 'done');
        await post(result);
      } catch (err) {
        this.tracker.finish(threadKey, t.id, 'failed');
        this.logger.warn(`백그라운드 협업 실패: ${String(err)}`, 'Orchestrator');
        try {
          // 자가 재시도(6b-3-2): 예외 실패만, 상한 2회. 예약 실패(미주입·null)는 기존 메시지 강등.
          if (attempt >= 2) { await post('작업 중 문제가 생겼어요 — 사람이 봐야 해요 🙏'); return; }
          if (await this.scheduleCollabRetry(question, team, threadKey, attempt, post)) return;
          await post('작업 중 문제가 생겼어요 🙏');
        } catch { /* post도 실패하면 포기 */ }
      }
    })().finally(() => {
      const idx = this.inflight.indexOf(work);
      if (idx !== -1) this.inflight.splice(idx, 1);
    });
    this.inflight.push(work);
  }

  private codeRepos(): CodeReposConfig {
    if (!this.codeReposCache) {
      this.codeReposCache = this.paths ? loadCodeRepos(this.paths.getConfigDir()) : { aliases: {}, searchRoots: [] };
    }
    return this.codeReposCache;
  }

  // 채널 정책 lazy 캐시(6c-2). 변경은 재시작 반영(coderepos와 동일 성질). 테스트는 override.
  private policy(): ChannelPolicy {
    if (!this.channelPolicyCache) {
      this.channelPolicyCache = this.paths ? loadChannelPolicy(this.paths.getConfigDir()) : { channels: {} };
    }
    return this.channelPolicyCache;
  }

  // 채널 능력 게이트(6c-2). 허용이면 true, 차단이면 안내 게시 후 false(막다른 길 없음).
  // 이름이 channelGate인 이유: 생성자 필드 gate(VerificationGate)와의 이름 충돌 회피.
  private async channelGate(
    cap: 'coding' | 'schedule' | 'collaborate',
    channelId: string,
    post: (text: string) => Promise<void>,
  ): Promise<boolean> {
    if (allows(this.policy(), channelId, cap)) return true;
    const label: Record<string, string> = { coding: '코딩', schedule: '예약', collaborate: '협업' };
    await post(`이 채널에선 ${label[cap]}을 쓸 수 없어요(채널 설정).`);
    return false;
  }

  // 테스트에서 override 가능하도록 메서드로 감쌈(모듈 resolveRepo는 coderepos.spec이 커버).
  private resolveRepoPaths(repoRef: string): string[] {
    return resolveRepo(repoRef, this.codeRepos());
  }

  // 멘션 코딩 진입: repo 해소 → 0/1/N 분기.
  private async startCoding(repoRef: string, goal: string, threadKey: string, post: (t: string) => Promise<void>): Promise<void> {
    const matches = this.resolveRepoPaths(repoRef);
    if (matches.length === 0) {
      await post(`'${repoRef}' 레포를 못 찾았어요. coderepos.json의 alias나 정확한 경로로 불러주세요.`);
      return;
    }
    if (matches.length > 1) {
      this.pending.set(threadKey, { kind: 'disambiguate', candidates: matches, goal });
      await post(`여러 개 찾았어요:\n${matches.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n@Engram <번호>로 골라주세요.`);
      return;
    }
    await this.startProposal(matches[0], goal, threadKey, post);
  }

  // 완성조건 초안 → 대상·조건 게시 → 승인 대기.
  private async startProposal(targetPath: string, goal: string, threadKey: string, post: (t: string) => Promise<void>): Promise<void> {
    if (!this.fence || !this.projects) { await post('코딩 기능이 준비되지 않았어요.'); return; }
    try { this.fence.assertWritable(targetPath); }
    catch { await post('그 경로엔 쓸 수 없어요(보호 경로).'); return; }
    const cfg = await this.proposeProject(targetPath, goal);
    this.pending.set(threadKey, { kind: 'approve', projectId: cfg.id, path: targetPath });
    const crit = cfg.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
    await post(
      `📁 대상: ${targetPath}\n📋 완성조건:\n${crit}\n` +
      `게이트: test=${cfg.gate.test}|build=${cfg.gate.build}|typecheck=${cfg.gate.typecheck}\n` +
      `맞으면 @Engram 승인 / 취소는 @Engram 취소`,
    );
  }

  // codeRun을 백그라운드로 detach(6b-1 패턴). 진행만 중계, 코드 에이전트 onChunk는 미게시.
  private launchCoding(projectId: string, targetPath: string, threadKey: string, post: (text: string) => Promise<void>, attempt = 0): void {
    const t = this.tracker.start(threadKey, { question: `코딩: ${targetPath}`, team: ['Coder'] });
    const work: Promise<void> = (async (): Promise<void> => {
      try {
        await post('자율 코딩 시작할게요. 진행은 여기 올릴게요.');
        const r = await this.codeRun(projectId, { channelId: threadKey, onProgress: (m) => { void post(`· ${m}`); } });
        this.tracker.finish(threadKey, t.id, r.status === 'SUCCESS' ? 'done' : 'failed');
        // 자가 재개(6b-3-2): STUCK/BUDGET만, 상한 2회. STOPPED=사용자 의지, SUCCESS=끝.
        if (r.status === 'STUCK' || r.status === 'BUDGET') {
          if (attempt >= 2) { await post(`⚠️ 두 번 재개해도 못 끝냈어요 — 사람이 봐야 해요 🙏 (세션 ${r.sessionId})`); return; }
          if (await this.scheduleCodingResume(projectId, r.status, threadKey, attempt, post)) return;
        }
        await post(this.codingResultMessage(r, targetPath));
      } catch (err) {
        this.tracker.finish(threadKey, t.id, 'failed');
        this.logger.warn(`백그라운드 코딩 실패: ${String(err)}`, 'Orchestrator');
        try { await post('코딩 중 문제가 생겼어요 🙏'); } catch { /* post도 실패하면 포기 */ }
      }
    })().finally(() => {
      const idx = this.inflight.indexOf(work);
      if (idx !== -1) this.inflight.splice(idx, 1);
    });
    this.inflight.push(work);
  }

  // 자가 재개 예약(6b-3-2). 성공 시 ⏸ 안내 게시까지 하고 true, 실패(미주입·add null)면 false → 기존 메시지 강등.
  // channelId=threadKey: Discord에서 스레드는 자체 channelId라 threadKey가 곧 게시 대상(6b-1 수렴).
  // ponytail: 어댑터가 threadId를 채우게 되면 doSchedule처럼 channelId/threadId 분리로 — 아니면 스레드발 예약이 예약취소 스코프(부모채널) 밖.
  private async scheduleCodingResume(
    projectId: string,
    status: 'STUCK' | 'BUDGET',
    threadKey: string,
    attempt: number,
    post: (text: string) => Promise<void>,
  ): Promise<boolean> {
    if (!this.scheduler) return false;
    const { cron, human } = computeResume(status, new Date());
    const e = this.scheduler.add(
      { channelId: threadKey, cron, task: `resume ${projectId} ${attempt + 1}`, once: true },
      { internal: true },
    );
    if (!e) return false;
    const why = status === 'STUCK' ? '막힘(진전 정체)' : '예산 소진';
    await post(`⏸ ${why} — ${human} 자동 재개 예약했어요 (#${e.id}, 재개 ${attempt + 1}/2). 멈추려면 @Engram 예약취소 ${e.id}`);
    return true;
  }

  // 예약된 코딩 재개 실행: 존재·승인 확인 → runState 복원(STUCK이 남긴 paused) → 백그라운드 재실행.
  private async resumeCoding(projectId: string, attempt: number, threadKey: string, post: (text: string) => Promise<void>): Promise<void> {
    if (!this.projects) { await post('코딩 기능이 준비되지 않았어요.'); return; }
    const project = await this.projects.get(projectId);
    if (!project) { await post('그 프로젝트를 못 찾았어요.'); return; }
    if (!project.approved) { await post('승인되지 않은 프로젝트예요.'); return; }
    // ponytail: runState는 전역 스위치(N=1 가정) — 재개가 engram pause로 멈춘 다른 코딩까지 풀 수 있다. N>1이면 프로젝트별 run-state로.
    this.setRunState('running');
    await post(`▶ 이어서 할게요: ${project.targetPath} (재개 ${attempt}/2)`);
    this.launchCoding(projectId, project.targetPath, threadKey, post, attempt);
  }

  // 재시작 생존(Phase 10b): 부팅 시 호출. RUNNING 코딩 레코드를 각자 채널로 재개(승인된 프로젝트만 —
  // resume hatch가 approved 확인). 스테일 레코드는 제거(재개가 새 세션을 만든다).
  // ponytail: 코딩만 — 협업은 분 단위라 재개 불필요. 재개 시 attempt=0(fresh).
  async resumeInterrupted(post: (channelId: string, text: string) => Promise<void>): Promise<number> {
    if (!this.tasks) return 0;
    let resumed = 0;
    let records: Awaited<ReturnType<TaskStore['list']>>;
    try { records = await this.tasks.list(); } catch { return 0; }
    for (const rec of records) {
      if (rec.kind !== 'coding' || rec.status !== 'RUNNING') continue;
      const channelId = rec.channelId;
      const projectRef = rec.projectRef;
      if (!channelId || !projectRef) continue; // 게시 대상/프로젝트 불명 → 스킵(고아로 남김)
      try {
        await this.tasks.remove(rec.id); // 스테일 세션 제거 — 재개가 새 세션 생성
        await this.handleMention(
          { text: `resume ${projectRef}`, userId: channelId },
          (t) => post(channelId, t),
          channelId,
        );
        resumed++;
      } catch (err) {
        this.logger.warn(`재시작 재개 실패(${rec.id}): ${String(err)}`, 'Orchestrator');
      }
    }
    return resumed;
  }

  // 협업 재시도 예약(6b-3-2). 같은 질문·같은 팀 재주입(재분류 없음). channelId=threadKey(scheduleCodingResume와 동일 근거).
  private async scheduleCollabRetry(
    question: string,
    team: string[],
    threadKey: string,
    attempt: number,
    post: (text: string) => Promise<void>,
  ): Promise<boolean> {
    if (!this.scheduler) return false;
    const { cron, human } = computeResume('COLLAB', new Date());
    const e = this.scheduler.add(
      { channelId: threadKey, cron, task: `retry ${attempt + 1} ${team.join(',')} ${question}`, once: true },
      { internal: true },
    );
    if (!e) return false;
    await post(`⏸ 작업 중 문제가 생겼어요 — ${human} 다시 해볼게요 (#${e.id}, 재시도 ${attempt + 1}/2). 멈추려면 @Engram 예약취소 ${e.id}`);
    return true;
  }

  private codingResultMessage(r: { status: string; sessionId: string }, targetPath: string): string {
    if (r.status === 'SUCCESS') return `✅ 코딩 완료: ${targetPath} (격리 브랜치에 착지 — 사람 머지 대기)`;
    const why: Record<string, string> = { STUCK: '막힘(진전 정체)', STOPPED: '정지됨', BUDGET: '예산 소진' };
    return `⚠️ 코딩 종료: ${why[r.status] ?? r.status} (세션 ${r.sessionId})`;
  }

  private async doSchedule(cron: string, task: string, once: boolean, channelId: string, threadKey: string, post: (t: string) => Promise<void>): Promise<void> {
    if (!this.scheduler) { await post('예약 기능이 준비되지 않았어요.'); return; }
    const threadId = threadKey !== channelId ? threadKey : undefined;
    const e = this.scheduler.add({ channelId, threadId, cron, task, once });
    if (!e) { await post('언제인지 잘 모르겠어요. "매일 아침 9시"처럼 다시 말해줄래요?'); return; }
    await post(`네, 예약했어요 📅 (예약 #${e.id}, ${e.cron})${once ? ' — 1회' : ''}`);
  }

  private formatSchedules(channelId: string): string {
    if (!this.scheduler) return '예약 기능이 준비되지 않았어요.';
    const list = this.scheduler.list(channelId);
    if (list.length === 0) return '예약이 없어요.';
    return list.map((e: ScheduleEntry, i: number) => `${i + 1}. [#${e.id}] ${e.cron} — "${e.task.slice(0, 40)}"${e.once ? ' (1회)' : ''}`).join('\n');
  }

  // @Engram 상태 출력. 질문은 40자 잘라 표시(상대시간은 비범위 — 단순화).
  private formatStatus(tasks: TrackedTask[]): string {
    if (tasks.length === 0) return '지금 진행 중이거나 최근 완료한 작업이 없어요.';
    const line = (t: TrackedTask): string =>
      `  - "${t.question.slice(0, 40)}" (팀: ${t.team.join('·') || '-'})${t.state === 'failed' ? ' (실패)' : ''}`;
    const running = tasks.filter((t) => t.state === 'running');
    const finished = tasks.filter((t) => t.state !== 'running');
    const parts: string[] = [];
    if (running.length) parts.push(`진행 중 ${running.length}건:\n${running.map(line).join('\n')}`);
    if (finished.length) parts.push(`최근 완료:\n${finished.map(line).join('\n')}`);
    return parts.join('\n');
  }

  // 테스트 전용: detach된 백그라운드 작업이 끝날 때까지 대기. ponytail: 테스트 훅(운영 무관).
  private async drainForTest(): Promise<void> {
    await Promise.all(this.inflight);
  }

  // 관찰 끼어들기(6c-1). 비용 사다리: 짧음→쿨다운→RAG(로컬·공짜)→두뇌 1콜. 모든 실패 무음(상주 불사).
  // ponytail: 쿨다운은 in-memory(재시작 리셋) — 영속 필요해지면 state 파일로.
  private readonly observeCooldown = new Map<string, number>();

  async observe(msg: CoreMessage, post: (text: string) => Promise<void>): Promise<void> {
    try {
      if (!this.rag || !this.codeBrain) return;
      const text = msg.text.trim();
      if (text.length < 10) return;
      const n = Number(process.env.ENGRAM_AMBIENT_COOLDOWN_MIN);
      const coolMin = Number.isFinite(n) && n > 0 ? n : 30;
      const last = this.observeCooldown.get(msg.userId) ?? -Infinity;
      if (this.now() - last < coolMin * 60_000) return;
      const hits = await this.rag.search(text, 3, msg.userId);
      if (hits.length === 0) return;
      const prompt = [
        loadPrompt('ambient', AMBIENT_DEFAULT),
        `\n# 대화 메시지\n${text}`,
        `\n# 위키 발췌\n${hits.map((h) => `- [${h.slug}] ${h.text.slice(0, 200)}`).join('\n')}`,
        '\n반드시 이 JSON만: {"interject":true|false,"text":"한두 문장"}',
      ].join('\n');
      const r = await this.codeBrain.complete(prompt);
      if (r.isError) return;
      const o = parseJsonBlock<{ interject?: unknown; text?: unknown }>(r.text);
      if (!o || o.interject !== true || typeof o.text !== 'string' || !o.text.trim()) return;
      this.observeCooldown.set(msg.userId, this.now());
      await post(`💡 ${o.text.trim()}`);
    } catch (err) {
      this.logger.warn(`observe 실패(무시): ${String(err)}`, 'Orchestrator');
    }
  }

  // 테스트 주입용 시계(쿨다운 결정적 테스트).
  protected now(): number { return Date.now(); }

  // 멘션 분류 + 로스터/코딩대상/예약 추출(두뇌 1콜). 실패는 전부 chat 폴백(상주를 막지 않음).
  private async classify(text: string): Promise<{ kind: 'chat' | 'collaborate' | 'code' | 'schedule'; team: string[]; repoRef?: string; goal?: string; cron?: string; task?: string; once?: boolean }> {
    if (!this.codeBrain) return { kind: 'chat', team: [] };
    const roster = (this.registry?.all() ?? []).map((p) => `- ${p.name}: ${p.role}`).join('\n');
    const aliases = Object.keys(this.codeRepos().aliases);
    const prompt = [
      loadPrompt('triage', TRIAGE_DEFAULT),
      `\n# 사용 가능한 전문가\n${roster || '(없음)'}`,
      `\n# 코딩 가능한 레포(alias)\n${aliases.join(', ') || '(없음)'}`,
      `\n# 사용자 메시지\n${text}`,
      '\n반드시 이 JSON만: {"kind":"chat"|"collaborate"|"code"|"schedule","team":["이름",...],"repo":"레포참조","goal":"할 일","cron":"0 9 * * *","task":"할 일","once":false}',
    ].join('\n');
    try {
      const r = await this.codeBrain.complete(prompt);
      if (r.isError) return { kind: 'chat', team: [] };
      const o = parseJsonBlock<{ kind?: unknown; team?: unknown; repo?: unknown; goal?: unknown; cron?: unknown; task?: unknown; once?: unknown }>(r.text);
      const kind = o && (o.kind === 'collaborate' || o.kind === 'code' || o.kind === 'schedule') ? o.kind : 'chat';
      const team = o && Array.isArray(o.team) ? o.team.map(String) : [];
      const repoRef = o && typeof o.repo === 'string' ? o.repo : undefined;
      const goal = o && typeof o.goal === 'string' ? o.goal : undefined;
      const cron = o && typeof o.cron === 'string' ? o.cron : undefined;
      const task = o && typeof o.task === 'string' ? o.task : undefined;
      const once = o && o.once === true ? true : undefined;
      return { kind, team, repoRef, goal, cron, task, once };
    } catch {
      return { kind: 'chat', team: [] };
    }
  }

  // B 협업(설계 §4): 분해는 호출자가 결정(personas), 여기서 배정·수집·종합. 유일 배정구(seam #1).
  async collaborate(
    question: string,
    personas: string[],
    userId: string = DEFAULT_USER,
    opts: { turnBudget?: number; onProgress?: (text: string) => Promise<void> } = {},
  ): Promise<string> {
    if (!this.tasks || !this.specialist || !this.synthesizer || !this.sem) {
      throw new Error('협업 협력자가 주입되지 않음(Orchestrator)');
    }
    // 진행 중계(선택). 깜깜이 방지용 부수효과라 실패는 무시 — 본 작업 흐름과 무관.
    const prog = async (text: string): Promise<void> => { try { await opts.onProgress?.(text); } catch { /* 무시 */ } };
    const budget = new TurnBudget(opts.turnBudget ?? personas.length + 1);
    const session = await this.tasks.create({ kind: 'collaboration', question, assignees: personas });
    await this.tasks.transition(session.id, 'RUNNING');
    await prog(`🧑‍🤝‍🧑 팀 구성: ${personas.join(', ')} — 각자 조사 시작합니다`);
    await Promise.all(
      personas.map((p) =>
        this.sem!.run(async () => {
          if (!budget.tryConsume()) return; // 예산 소진 → 스킵(턴 천장)
          try {
            const text = await this.specialist!.contribute(p, question, userId);
            await this.tasks!.contribute(session.id, p, text);
            await prog(`✔ ${p} 의견 도착`);
          } catch (err) {
            this.logger.warn(`페르소나 기여 실패(스킵) ${p}: ${String(err)}`, 'Orchestrator');
            await prog(`⚠ ${p} 스킵(오류)`);
          }
        }),
      ),
    );
    await prog('📝 의견 종합 중…');
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
    opts: { maxRounds?: number; stuckK?: number; onChunk?: (t: string) => void; onProgress?: (m: string) => void; channelId?: string } = {},
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
      ...(opts.channelId ? { channelId: opts.channelId } : {}),
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
