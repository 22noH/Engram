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
import { BrainProvider, BRAIN, EffortLevel } from '../brain/brain.port';
import type { PermMode } from '../../shared/protocol';
import type { BrowserOp, BrowserOpResult } from '../../shared/browser-ops';
import { parseJsonBlock } from './parse-json-block';
import { ProjectStore, ProjectConfig } from '../knowledge-core/project-store';
import { VerificationGate } from './verification-gate';
import { detectGate } from './gate-detect';
import { loadPrompt } from './prompt-store';
import { buildCodeChatPrompt, extractPropose, CODE_CHAT_DEFAULT } from './code-chat';
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
import type { Action, ProgressRun } from '../../shared/protocol';
import { outputDirective, configuredLang } from './language';
import { t } from './i18n';
import { ChannelBrainResolver } from './channel-brain-resolver';
import type { ChatMessage } from '../edge/messenger/chat-store';
import { extractAskUser, questionFallbackText, AskUserPayload } from './ask-user-block';
import { brainErrorHint } from './brain-error-hints';

// post 콜백 통일 타입(Phase 11b Task 3). text만 쓰던 호출부는 넓히기라 무영향.
// question(ask-user Task 3): 범용 경로가 뽑아낸 질문 카드 페이로드 — 기존 (text, actions) 호출부는
// 3번째 인자를 안 넘기니 무영향(TS 함수 타입은 뒤쪽 파라미터를 덜 받는 쪽이 항상 대입 가능).
// toolsUsed(brain-activity Task 1): additive 4번째 — 같은 이유로 미전달 호출부는 무영향.
// progress(진행 중 표시): additive 5번째 — 다단계 작업(협업·코딩 루프)의 "중간 보고"에만 true를 실어
// 게시한다. 렌더러가 진행 메시지를 식별하는 유일한 근거(텍스트 패턴 매칭 금지 — i18n에서 깨진다).
// progress에 ProgressRun 객체를 실으면 "그 실행(카드)의 한 단계"라는 뜻이다(진행 카드 2026-07-25).
// completionReport(additive 6번째): 코딩이 끝나고 두뇌가 쓴 구조화 보고 메시지 표식.
type PostFn = (
  text: string, actions?: Action[], question?: AskUserPayload, toolsUsed?: string[],
  progress?: boolean | ProgressRun, completionReport?: boolean,
) => Promise<void>;

// 진행 단계의 성격(카드 마커) — producer만 안다. 렌더러가 텍스트를 뜯어보지 않게 여기서 말해준다.
type StepKind = ProgressRun['kind'];

// 한 실행(카드 하나)의 id. 시각+난수라 동시에 도는 두 실행이 절대 같은 카드로 섞이지 않고,
// 재시작 뒤에도 기록에 그대로 남아 있어 카드가 그대로 복원된다.
function newRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 한 코딩 실행이 남긴 "실제 재료". 완료 보고서를 두뇌에게 쓰게 할 때 이 값만 넘긴다
// (템플릿 채우기가 아니라 실제 결과를 보고 쓰게 하는 게 목적 — 스펙 §2).
export interface CodeRunLog {
  baseSha: string | null;                                       // 실행 시작 시점 HEAD(변경 파일 계산 기준)
  landed: Array<{ area: string; summary: string }>;             // 착지한 티켓과 코더가 남긴 요약
  retries: Array<{ area: string; attempt: number; reason: string }>; // 실패·재시도 이력(화면에 이미 보인 것과 같은 사실)
  rounds: number;                                               // 돈 라운드 수
}

// prompts/completion-report.md 없을 때의 내장 기본값(파일이 없어도 동작한다).
// "남은 것·판단 필요" 절을 절대 빼먹지 못하게 지시가 명시적이다 — 완료만 던지면 한계를 모르고 넘어간다.
export const COMPLETION_REPORT_DEFAULT = [
  'You are writing a completion report for a coding run that just finished, addressed to the person who asked for it.',
  'Use only the materials below — never invent files, tests, or results that are not there.',
  'Write it as Markdown with exactly these sections, in this order:',
  '1. A one-line title, then one lead line naming the target and branch.',
  '2. `**What was done**` — plain-language results (bullets).',
  '3. `**How it was implemented**` — the key decisions and why (bullets). Skip if the materials say nothing about it.',
  '4. `**Files changed**` — paths with `+n −m`. Skip the section if no files changed.',
  '5. `**Verification**` — which gate commands ran and passed (tests / build / typecheck).',
  '6. `**Left to do / needs a decision**` — limits, what was NOT verified, follow-up decisions for the human.',
  '   This section is mandatory. If there is genuinely nothing, write "None".',
  'Be concrete and short. No preamble, no closing pleasantries, no headings other than the ones above.',
].join('\n');

// 예외 → 화면에 보여줄 한 줄 사유. 스택트레이스가 채팅을 덮지 않게 첫 줄만·200자까지 자른다
// (전문은 항상 로그에 남는다). 사유를 못 뽑으면 빈 문자열이 아니라 원문 문자열화 결과를 쓴다.
export function shortReason(err: unknown, max = 200): string {
  const raw = err instanceof Error ? err.message : String(err);
  const line = raw.split('\n').find((l) => l.trim()) ?? raw;
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

// prompts/decompose.md 없을 때의 내장 기본값. JSON 계약은 decompose()가 코드에서 덧붙인다.
export const DECOMPOSE_DEFAULT = [
  'Split the goal below into work pieces.',
  '**Split as little as possible.** If the goal is small or touches one area (one or two files), keep it as a single task.',
  'Only split into multiple pieces when the parts are truly independent (different, non-overlapping files/areas) — over-splitting makes agents collide on the same file.',
].join('\n');

// prompts/ambient.md 없을 때의 내장 기본값. JSON 계약은 observe()가 코드에서 덧붙인다.
export const AMBIENT_DEFAULT = [
  'You are given a chat message and wiki excerpts. Interject only when the wiki information is genuinely helpful to this conversation.',
  'If unsure, do not interject — interject=false is the default.',
  'When you do interject, give just the point in one or two sentences and cite the wiki page (slug) you relied on.',
].join('\n');

// prompts/triage.md 없을 때의 내장 기본값. JSON 계약은 classify()가 코드에서 덧붙인다.
export const TRIAGE_DEFAULT = [
  'Decide whether the user message is (1) a simple question/chat → "chat", or (2) work that needs several experts together → "collaborate".',
  'For collaborate, pick from the expert list below only the people this work truly needs and put their names in team (empty array if none).',
  '(3) If it asks to write, fix, or implement code in a specific repo → "code": put the repo reference (name/alias/path) in repo and the task in goal.',
  '(4) If it asks to do something at a set time/interval → "schedule": put a 5-field cron in cron (e.g. every day at 9 = 0 9 * * *), the task in task, and once=true if it runs a single time.',
  'When unsure, choose chat.',
].join('\n');

// 코딩 위임 대기(스레드별 2단: 후보 선택 → 승인). 6b-2.
type PendingCode =
  | { kind: 'disambiguate'; candidates: string[]; goal: string }
  | { kind: 'approve'; projectId: string; path: string }
  | { kind: 'proposeReady'; repoPath: string; goal: string };

// 허브(설계 §7.1). 모든 흐름이 경유 — Gateway는 Orchestrator만 알고 에이전트를 직접 모른다.
// 매 턴 대화를 ConversationStore에 적재(B 수집 소스).
@Injectable()
export class Orchestrator {
  // 멘션 작업 상태(in-memory) + 백그라운드 inflight(테스트 drain용). ponytail: 재시작 소실은 6b-3.
  private readonly tracker = new MentionTracker();
  private readonly inflight: Promise<void>[] = [];
  // 코딩 위임 대기(스레드별 2단: 후보 선택 → 승인). 6b-2.
  private readonly pending = new Map<string, PendingCode>();
  // Task 4(여러 줄 입력+생성 중지): threadKey별 진행 중 턴의 AbortController. handleMention 진입 시
  // 등록, 종료(finally) 시 제거 — cancel(threadKey)이 stopGeneration ws 프레임의 최종 도착지.
  private readonly abortRegistry = new Map<string, AbortController>();
  private codeReposCache?: CodeReposConfig;
  private channelPolicyCache?: ChannelPolicy;
  // 예약(스케줄) 포트 — main.ts에서 setter 주입(메신저처럼 DI 밖). 6b-3.
  private scheduler?: SchedulerPort;
  // 프로젝트당 코딩 실행 1개 가드(2026-08-01) — launchCoding 진입/종료에서만 만진다.
  private readonly codingInflightProjects = new Set<string>();
  // 채널→브레인 조회(ChatStore) — main.ts에서 setter 주입(scheduler와 동일 결, DI 밖·chat 비활성이면 미주입).
  // 리뷰 지적 Finding 1: resumeInterrupted의 재개 발사가 채널 브레인을 안 실어보내던 것 — 부팅 시점에
  // "현재" 채널 브레인을 조회해 넣는다(재시작 사이 채널 브레인이 바뀌었어도 최신 값 반영).
  private chatStoreForBrain?: { listChannels(): Array<{ id: string; brain?: string }> };
  // AI 웹 조작(2단계) — main.ts에서 setter 주입(scheduler와 동일 결, DI 밖). 코드 채널 턴에서만
  // 쓰인다: 자체 하네스엔 CompleteOpts.browser 클로저로(채널이 클로저에 묶임), CLI 하네스엔
  // spawn env(ENGRAM_CHANNEL_ID)로 — 후자가 MCP 도구에 채널 정체성을 넘기는 유일한 경로다.
  private browserBus?: { request(channelId: string, op: BrowserOp): Promise<BrowserOpResult> };
  // /compact 실행기(CompactService) — main.ts에서 setter 주입(구조적 타입, 순환 회피 —
  // main.ts에서만 조립 가능한 chatStore를 CompactService가 필요로 해 DI로는 못 넣는다. clear-compact Task 3b).
  // summarizeToWiki는 Task 5(자동 compact)가 쓴다 — 같은 CompactService 인스턴스가 두 메서드를 다 가진다.
  private compactSvc?: {
    compact(channelId: string, opts: { brain: BrainProvider; auto?: boolean }): Promise<{ summary: string; slug: string } | null>;
    summarizeToWiki(channelId: string, msgs: ChatMessage[], opts: { brain: BrainProvider; auto?: boolean }): Promise<{ slug: string } | null>;
  };

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
    // 채널별 두뇌 해소(스펙 §3.2). 미주입(구식 DI·기존 테스트)이면 resolveMsgBrain이 기존 codeBrain 그대로 돌려준다(회귀 0).
    @Optional() private readonly channelBrain?: ChannelBrainResolver,
  ) {}

  // ask-user 범용 경로(Task 3): 두뇌의 최종 자유텍스트 응답을 게시하기 직전 여기를 거친다.
  // ```ask_user 블록이 있으면(도구 없이 텍스트만 내는 CLI 하네스·비도구 로컬 LLM까지 커버) 본문(또는
  // 없으면 폴백 텍스트)+question을 게시 — actions는 question과 함께 안 보낸다(질문 카드 자체가 응답 UI라
  // 별도 액션 버튼과 동시 노출하면 사용자가 어느 쪽에 답해야 할지 헷갈린다). 블록이 없으면 기존 그대로
  // (text, actions)만 게시(회귀 0).
  private async postReply(reply: string, post: PostFn, actions?: Action[], toolsUsed?: string[]): Promise<void> {
    const { text, question } = extractAskUser(reply);
    if (question) {
      await post(text || questionFallbackText(question), undefined, question, toolsUsed);
      return;
    }
    await post(text, actions, undefined, toolsUsed);
  }

  // Task 4(여러 줄 입력+생성 중지): route()가 돌려준 시점에 이미 이 턴이 stopGeneration으로 중단됐으면
  // (signal.aborted) route()의 반환 텍스트(브레인이 abort 시 돌려주는 부분 결과·에러 문구)는 버리고
  // 짧은 중단 안내만 게시 — 이 post()는 일반 채널 게시 경로 그대로라 렌더러 awaiting을 정상 해제한다
  // (별도 클라 신호 불필요). signal이 한 번도 abort 안 되는 압도적 다수 경로는 이 분기 자체를 안 타
  // postReply 그대로(회귀 0).
  private async postReplyOrInterrupted(
    reply: string,
    post: PostFn,
    signal: AbortSignal,
    actions?: Action[],
    toolsUsed?: string[],
  ): Promise<void> {
    if (signal.aborted) { await post(t('interrupted')); return; }
    await this.postReply(reply, post, actions, toolsUsed);
  }

  // 진행 중 표시: 다단계 작업의 중간 보고 전용 post 래퍼. 진행 보고를 내는 지점(협업 onProgress,
  // 코딩 루프 onProgress)이 모두 이 한 곳을 거치게 해서 "무엇이 진행 메시지인가"의 정의가 코드에
  // 한 번만 적히게 한다. 최종 결과·질문·에러는 이 래퍼를 안 쓰므로 표식이 없고, 렌더러는 그 차이로
  // 애니메이션을 멈춘다.
  // run을 주면(진행 카드) 그 실행 id·제목·단계 성격을 함께 실어 보낸다 — 렌더러가 이 표식만으로
  // 연속된 보고를 카드 하나로 묶고, 기록에 남으니 재시작 후에도 그대로 복원된다. run 없이 쓰면
  // 예전처럼 boolean 표식만 붙는다(카드 없이 한 줄 — 회귀 0).
  private progressPost(post: PostFn, run?: { id: string; title: string }): (text: string, kind?: StepKind) => Promise<void> {
    return (text, kind) => post(
      text, undefined, undefined, undefined,
      run ? { id: run.id, title: run.title, ...(kind ? { kind } : {}) } : true,
    );
  }

  // ask_user 도구 경로(Task 4): 도구 호출 중간에 곧바로 카드를 게시하는 클로저 — postReply의 펜스텍스트
  // 경로와 게시 형태를 맞춘다(폴백 텍스트+question). route()가 인터랙티브·예약을 안 가리므로 이 클로저도
  // 항상 넘긴다(브리프: 새 플래그 배관 없이 기존 프롬프트 지침에 의존).
  private askUserFor(post: PostFn): (q: AskUserPayload) => Promise<void> {
    return async (q) => { await post(questionFallbackText(q), undefined, q); };
  }

  // 이 메시지가 쓸 두뇌를 요청 한정으로 해소(스펙 §3.2) — 결과는 지역 변수로만 쓴다(싱글턴 필드 오염 금지).
  // channelBrain 미주입 시 기존 codeBrain 그대로(회귀 0). msg.brain 미지정이면 resolve가 기본(=codeBrain)을 돌려준다.
  private resolveMsgBrain(msg: CoreMessage): BrainProvider | undefined {
    return this.channelBrain ? this.channelBrain.resolve(msg.brain) : this.codeBrain;
  }

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

  // ChatStore를 채널→브레인 조회로 주입(구조적 타입, 순환 회피 — Finding 1). main.ts에서 chatStore 있을 때만 호출.
  setChannelBrainSource(source: { listChannels(): Array<{ id: string; brain?: string }> }): void {
    this.chatStoreForBrain = source;
  }

  // AI 웹 조작(2단계): BrowserBus 주입(main.ts). 미주입이면 코드 채널 턴이 8c 이전과 완전히 동일하다
  // (도구도 env도 안 붙는다 — 회귀 0).
  setBrowserBus(bus: { request(channelId: string, op: BrowserOp): Promise<BrowserOpResult> }): void {
    this.browserBus = bus;
  }

  // CompactService 주입(clear-compact Task 3b). main.ts에서 wiki 배선이 있을 때만(메인 서버) 호출 —
  // 미주입이면 compactChannel/autoCompact가 null(자기위임 없음, self.adapter의 compact 케이스·chat-store의
  // autoCompactHook 둘 다 무크래시 no-op으로 흡수).
  setCompactService(svc: {
    compact(channelId: string, opts: { brain: BrainProvider; auto?: boolean }): Promise<{ summary: string; slug: string } | null>;
    summarizeToWiki(channelId: string, msgs: ChatMessage[], opts: { brain: BrainProvider; auto?: boolean }): Promise<{ slug: string } | null>;
  }): void {
    this.compactSvc = svc;
  }

  // channelId의 "현재" 브레인 조회(never-throw — 조회 실패는 brain 미지정으로 폴백).
  private channelBrainOf(channelId: string): string | undefined {
    if (!this.chatStoreForBrain) return undefined;
    try {
      return this.chatStoreForBrain.listChannels().find((c) => c.id === channelId)?.brain;
    } catch {
      return undefined;
    }
  }

  // self.adapter의 compact ws 케이스가 부르는 훅(clear-compact Task 3b — 3의 opts.compactHandler 계약을
  // 채운다). 요청 한정 채널 두뇌로 요약→위키 게시→정리(CompactService.compact)를 수행. never-throw —
  // compactSvc 미주입/브레인 미해소/compact 자체 실패는 전부 null(ws 루프는 조용한 no-op으로 흡수).
  async compactChannel(channelId: string, brainName?: string): Promise<{ slug: string } | null> {
    if (!this.compactSvc) return null;
    const brain = this.resolveMsgBrain({ text: '', userId: channelId, ...(brainName ? { brain: brainName } : {}) });
    if (!brain) return null;
    try {
      const r = await this.compactSvc.compact(channelId, { brain });
      return r ? { slug: r.slug } : null;
    } catch (err) {
      this.logger.warn(`compact 실패(무시): ${String(err)}`, 'Orchestrator');
      return null;
    }
  }

  // clear-compact Task 5: chat-store.setAutoCompactHook이 부르는 훅(main.ts가 이 메서드를 그대로
  // 훅으로 넘긴다). compactChannel과 달리 채널 전체가 아니라 프루닝이 버릴 dropped 메시지만 받아
  // CompactService.summarizeToWiki(clear/append 없음, 위키 게시만)로 넘긴다 — 채널 정리는 chat-store가
  // 이 메서드의 성공 여부(null 아님)를 보고 removeMessagesByIds로 정밀 수행한다.
  // 브레인은 "이 채널의 현재" 브레인을 channelBrainOf로 조회(재개 발사와 동일 결 — Finding 1 재사용).
  // never-throw — compactSvc 미주입/브레인 미해소/summarizeToWiki 자체 실패는 전부 null(chat-store가
  // false로 받아 아무것도 지우지 않는다).
  async autoCompact(channelId: string, dropped: ChatMessage[]): Promise<{ slug: string } | null> {
    if (!this.compactSvc) return null;
    const brainName = this.channelBrainOf(channelId);
    const brain = this.resolveMsgBrain({ text: '', userId: channelId, ...(brainName ? { brain: brainName } : {}) });
    if (!brain) return null;
    try {
      return await this.compactSvc.summarizeToWiki(channelId, dropped, { brain, auto: true });
    } catch (err) {
      this.logger.warn(`자동 compact 실패(무시): ${String(err)}`, 'Orchestrator');
      return null;
    }
  }

  // askUser(Task 4): 있으면 reader.handle로 그대로 흘려 CompleteOpts.askUser에 실린다(delegate와 동일 결).
  // route()는 인터랙티브 호출(handleMention)과 예약 재주입(resumeInterrupted 등)이 같은 경로를 타 여기서
  // 인터랙티브 여부를 가르지 않는다 — TOOL_USAGE_GUIDANCE 프롬프트 지침이 예약 턴 사용을 이미 막는다.
  // activity/onToolsUsed(brain-activity Task 1): askUser와 같은 결로 reader.handle에 그대로 통과.
  async route(
    msg: CoreMessage,
    onChunk?: (t: string) => void,
    askUser?: (q: AskUserPayload) => Promise<void>,
    activity?: (label: string) => void,
    onToolsUsed?: (names: string[]) => void,
    // Task 4(여러 줄 입력+생성 중지, additive): reader.handle까지 그대로 관통 → CompleteOpts.signal.
    signal?: AbortSignal,
  ): Promise<string> {
    let sources: string[] = [];
    const answer = await this.reader.handle(msg, onChunk, (s) => { sources = s; }, askUser, activity, onToolsUsed, signal);
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
  // activity(brain-activity Task 1): additive — bridge가 port.activity 지원 어댑터에서만 만들어 넘긴다.
  // 미지원 어댑터·재주입(resumeInterrupted 등 3인자 호출)은 undefined(reader-agent까지 no-op으로 흡수, 회귀 0).
  // delta(답변 실시간 스트리밍): additive 5번째 — activity와 같은 결로 bridge가 port.delta 지원 어댑터에서만
  // 만들어 넘긴다. route()의 onChunk 자리로 그대로 흘러 reader-agent→brain.complete의 스트리밍 콜백이 된다.
  async handleMention(
    msg: CoreMessage,
    post: PostFn,
    threadKey: string = msg.userId,
    activity?: (label: string) => void,
    delta?: (text: string) => void,
  ): Promise<void> {
    // Task 4(여러 줄 입력+생성 중지): 이 턴 전용 AbortController를 등록(threadKey 키) — self.adapter의
    // stopGeneration 프레임이 cancel(threadKey)/cancelByChannel(channelId)로 이걸 abort시킨다. 종료(성공·
    // 실패·중간 return 전부)엔 반드시 finally로 제거 — 동시성 방어로 "그 사이 새 턴이 같은 threadKey로
    // 다시 시작해 레지스트리를 갈아치우지 않았을 때만" 지운다(identity 비교, 늦은 finally가 새 턴 것을
    // 실수로 지우지 않게).
    const ctrl = new AbortController();
    this.abortRegistry.set(threadKey, ctrl);
    try {
      await this.handleMentionCore(msg, post, threadKey, activity, delta, ctrl.signal);
    } finally {
      if (this.abortRegistry.get(threadKey) === ctrl) this.abortRegistry.delete(threadKey);
    }
  }

  // stopGeneration ws 프레임의 최종 도착지(self.adapter opts.stopHandler → 이 메서드). threadKey에 등록된
  // AbortController가 있으면 abort하고 true(있었음), 없으면(무턴) false — 호출부가 조용히 무시하는 재료.
  cancel(threadKey: string): boolean {
    const ctrl = this.abortRegistry.get(threadKey);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  // self.adapter의 stopHandler 훅(channelId 기준). self 채팅은 threadId를 항상 비워(messenger-bridge.ts
  // 참고) threadKey가 곧 channelId — cancel과 동일 레지스트리를 그대로 재사용.
  cancelByChannel(channelId: string): boolean {
    return this.cancel(channelId);
  }

  // 노력(effort) 단일 결정 지점. 채널 설정(msg.effort)을 그대로 믿지 않고 채널 모드로 한 번 더 가른다:
  //  - 코드 채널: 채널에 저장된 값(사용자가 채널마다 고른다). 미설정이면 high.
  //  - Chat·Team 채널: 항상 high 고정(설정 UI 자체가 없다 — 저장값이 섞여 들어와도 여기서 덮어쓴다).
  // 여기 한 곳만 고치면 reader(chat)·answerInCode(code) 양쪽이 같이 바뀐다.
  private resolveTurnEffort(msg: CoreMessage): EffortLevel {
    return msg.mode === 'code' ? (msg.effort ?? 'high') : 'high';
  }

  // 권한 모드(permMode) 단일 결정 지점 — resolveTurnEffort와 같은 결. 코드 채널만 채널에 저장된 값을
  // 쓰고(Chat·Team은 설정 UI가 없으니 값이 섞여 들어와도 무시), 값이 없으면 undefined를 그대로 흘린다.
  // undefined = "이 턴엔 모드 주입 없음" → PermissionFence가 전역 설정(permissions.json
  // allow.commandMode)으로 폴백한다(기존 동작 보존 = 회귀 0).
  // ⚠️ 중요: 이 값은 턴마다 새로 계산돼 코딩 실행부(codeRun→CodingSpecialist.work→fence 게이트)까지
  // 인자로 흘러간다. 부팅 시 fence.load()가 캐시한 값이 아니라 이 인자가 이번 턴의 판정을 지배하므로
  // 채널 모드 변경이 재시작 없이 즉시 먹힌다(전역 coding 설정의 appliesAfterRestart 함정 회피).
  private resolveTurnPermMode(msg: CoreMessage): PermMode | undefined {
    return msg.mode === 'code' ? msg.permMode : undefined;
  }

  // 계획만(plan) 모드면 구현 진입을 막고 안내를 게시한다(true=막음). 코딩으로 들어가는 문이 여러 개라
  // (제안 버튼·승인·code/resume 명령) 판단을 여기 한 곳으로 모은다. plan이 아니면 아무 것도 안 한다.
  private async denyIfPlanOnly(permMode: PermMode | undefined, post: PostFn): Promise<boolean> {
    if (permMode !== 'plan') return false;
    await post(t('planOnlyBlocked'));
    return true;
  }

  private async handleMentionCore(
    msg: CoreMessage,
    post: PostFn,
    threadKey: string,
    activity: ((label: string) => void) | undefined,
    delta: ((text: string) => void) | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const trimmed = msg.text.trim();
    // 이 요청 한정 두뇌(스펙 §3.2) — 아래 코딩/분류 경로 전부가 이 지역 변수를 공유한다.
    const brain = this.resolveMsgBrain(msg);
    // 이 턴에 적용할 노력(단일 결정 지점) — 아래 답변 경로(route·answerInCode)로만 흘린다.
    // 분류(classify)·코딩 루프 등 내부 호출엔 안 싣는다(그쪽은 별도 예산 정책, 회귀 0).
    const effort = this.resolveTurnEffort(msg);
    // 이 턴에 적용할 권한 모드(단일 결정 지점) — 아래 코딩 진입 경로 전부가 이 지역 변수를 공유한다.
    const permMode = this.resolveTurnPermMode(msg);

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
        await post(t('cancelled'));
        return;
      }
      if (p.kind === 'disambiguate') {
        if (/^\d+$/.test(trimmed)) {
          const n = parseInt(trimmed, 10);
          if (n < 1 || n > p.candidates.length) { await post(t('chooseFromRange', p.candidates.length)); return; }
          this.pending.delete(threadKey);
          if (await this.denyIfPlanOnly(permMode, post)) return;
          await this.startProposal(p.candidates[n - 1], p.goal, threadKey, post, brain, permMode);
          return;
        }
        // 비숫자·비취소 → 이 스레드의 모호선택을 포기(스테일 방지), 아래 일반 처리로 흐름.
        this.pending.delete(threadKey);
      } else if (p.kind === 'approve' && (trimmed === '승인' || trimmed === 'approve')) {
        this.pending.delete(threadKey);
        if (await this.denyIfPlanOnly(permMode, post)) return;
        await this.approveProject(p.projectId);
        this.launchCoding(p.projectId, p.path, threadKey, post, 0, brain, permMode);
        return;
      } else if (p.kind === 'proposeReady') {
        if (trimmed === '구현 시작' || trimmed === '승인' || trimmed === 'approve') {
          this.pending.delete(threadKey);
          if (await this.denyIfPlanOnly(permMode, post)) return;
          if (!(await this.channelGate('coding', msg.userId, post))) return;
          await this.startProposal(p.repoPath, p.goal, threadKey, post, brain, permMode);
          return;
        }
        // 비매칭 → 스테일 제안 버리고 아래 일반 흐름으로(disambiguate와 동일 패턴)
        this.pending.delete(threadKey);
      }
    }
    // escape hatch: code <repoRef> <goal>
    if (trimmed.startsWith('code ')) {
      const rest = trimmed.slice('code '.length);
      const sp = rest.indexOf(' ');
      const repoRef = sp < 0 ? rest : rest.slice(0, sp);
      const goal = sp < 0 ? '' : rest.slice(sp + 1);
      if (await this.denyIfPlanOnly(permMode, post)) return;
      if (!(await this.channelGate('coding', msg.userId, post))) return;
      await this.startCoding(repoRef, goal, threadKey, post, brain, permMode, msg.scheduled === true);
      return;
    }
    // 예약(스케줄) 관리 명령
    if (trimmed === '예약목록' || trimmed === 'schedules') {
      // 취소 버튼(2026-08-01, UX): ID를 손으로 치는 대신 목록 항목마다 클릭 한 번 — send에 기존
      // 예약취소 명령을 그대로 실어 별도 배관 없이 동작한다(버튼=타이핑 대행).
      const entries = this.scheduler?.list(msg.userId) ?? [];
      await post(
        this.formatSchedules(msg.userId),
        entries.length ? entries.map((e, i) => ({ label: t('cancelScheduleLabel', i), send: `예약취소 ${e.id}` })) : undefined,
      );
      return;
    }
    if (trimmed.startsWith('예약취소 ') || trimmed.startsWith('schedule cancel ')) {
      const id = (trimmed.startsWith('예약취소 ') ? trimmed.slice('예약취소 '.length) : trimmed.slice('schedule cancel '.length)).trim();
      if (!this.scheduler) { await post(t('scheduleNotReady')); return; }
      const mine = this.scheduler.list(msg.userId).some((e) => e.id === id);
      const ok = mine && this.scheduler.remove(id);
      await post(ok ? t('cancelled') : t('scheduleNotFound'));
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
      if (await this.denyIfPlanOnly(permMode, post)) return;
      if (!(await this.channelGate('coding', msg.userId, post))) return;
      await this.resumeCoding(parts[0] ?? '', attempt, threadKey, post, brain, permMode);
      return;
    }
    // 협업 재시도 재주입(6b-3-2). 형식: retry <attempt> <팀CSV> <질문> — 불일치면 일반 흐름으로.
    if (trimmed.startsWith('retry ')) {
      const m = trimmed.match(/^retry (\d+) (\S+) ([\s\S]+)$/);
      if (m) {
        const attempt = parseInt(m[1], 10);
        const team = m[2].split(',').map((s) => s.trim()).filter(Boolean);
        if (!(await this.channelGate('collaborate', msg.userId, post))) return;
        await post(t('teamFormedRetry', team.join('·'), attempt));
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
      await post(t('teamFormed', team.join('·')));
      this.launchCollaboration(q, team, msg.userId, threadKey, post);
      return;
    }
    if (trimmed.startsWith('ask ')) {
      let toolsUsed: string[] = [];
      await this.postReplyOrInterrupted(
        await this.route(
          { text: trimmed.slice('ask '.length), userId: msg.userId, effort },
          delta, // 답변 실시간 스트리밍: onChunk 자리 — 미주입(delta undefined)이면 기존과 바이트 동일(회귀 0)
          this.askUserFor(post),
          activity,
          (names) => { toolsUsed = names; },
          signal,
        ),
        post,
        signal,
        undefined,
        toolsUsed,
      );
      return;
    }

    // Code 채널(2026-07-07): 대화 기본. 레포 읽고 답하고, 코드요청이면 [구현 시작] 제안(escalate).
    // 대화 자체는 게이트 없음(질문=chat과 동급). 코딩 게이트는 '구현 시작' 클릭 시(proposeReady 처리).
    if (msg.mode === 'code') {
      if (!msg.repoPath) {
        await post(t('noRepoFolder'));
        return;
      }
      // 코드 채널 스트리밍(2026-07-25): delta를 그대로 넘겨 두뇌 답이 첫 글자부터 흐른다. 확정 전
      // 원시 펜스(ask_user/engram:propose)는 messenger-bridge의 펜스 가드가 델타 단계에서 걸러낸다
      // — 저장·확정 텍스트는 여전히 아래 extract* 결과가 권위(가드는 표시용).
      const { reply, goal, question } = await this.answerInCode(msg, threadKey, brain, delta, effort);
      // ask-user(실사고 2026-07-25): 코드 채널만 extractAskUser가 빠져 있어 두뇌가 되물어도 카드가
      // 안 뜨고 펜스 JSON이 채팅·대화기록에 날것으로 박혔다. 미배선 사유였던 "[구현 시작] 버튼과 경합"은
      // 잘못된 전제 — 되묻는 턴은 구현 제안이 아니라 애초에 경합이 없다. 질문이 있으면 질문이 이기고
      // (버튼·pending 안 걺: 답을 받은 다음 턴이 제안을 다시 만든다), 없으면 기존 동작 그대로(회귀 0 —
      // 블록이 없으면 extractAskUser가 원문을 그대로 돌려준다).
      // 질문 추출은 answerInCode가 이미 마쳤다(제안 마커보다 먼저 떼야 해서) — 여기선 표시 텍스트만 정한다.
      const replyText = reply;
      const answerForLog = question ? (replyText || questionFallbackText(question)) : replyText;
      // 이 채널의 다음 턴 연속성을 위해 Q&A 적재(answerInCode의 recent가 읽는다). 실패는 continuity만 포기.
      try {
        await this.conversations.append(msg.userId, { ts: new Date().toISOString(), question: msg.text, answer: answerForLog, sources: [] });
      } catch { /* 적재 실패는 답변에 영향 없음 */ }
      if (question) {
        await post(replyText || questionFallbackText(question), undefined, question);
      } else if (goal && permMode === 'plan') {
        // 계획만(plan): 두뇌가 구현을 제안해도 [구현 시작] 버튼·pending을 걸지 않는다. 답(=계획)은
        // 그대로 보여주고 실행으로 넘어가는 문만 닫는다 — 사용자가 배지에서 모드를 올리면 열린다.
        await post(replyText);
      } else if (goal && this.fence && this.projects) {
        this.pending.set(threadKey, { kind: 'proposeReady', repoPath: msg.repoPath, goal });
        await post(replyText, [{ label: t('startImplementationLabel'), send: '구현 시작' }]);
      } else {
        await post(replyText); // 코딩 미배선이거나 순수 대화면 답만
      }
      return;
    }

    const decision = await this.classify(trimmed, brain);
    if (decision.kind === 'code') {
      if (!(await this.channelGate('coding', msg.userId, post))) return;
      await this.startCoding(decision.repoRef ?? '', decision.goal ?? msg.text, threadKey, post, brain, undefined, msg.scheduled === true);
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
      await post(t('teamFormed', team.join('·')));
      this.launchCollaboration(msg.text, team, msg.userId, threadKey, post);
      return;
    }
    let toolsUsed: string[] = [];
    await this.postReplyOrInterrupted(
      // 답변 실시간 스트리밍: delta가 route의 onChunk 자리 — 미주입이면 기존과 바이트 동일(회귀 0).
      // effort는 resolveTurnEffort가 정한 이 턴의 확정값(Chat=항상 high).
      await this.route({ ...msg, effort }, delta, this.askUserFor(post), activity, (names) => { toolsUsed = names; }, signal),
      post,
      signal,
      undefined,
      toolsUsed,
    );
  }

  // collaborate를 백그라운드로 detach. 끝나면 결과 게시 + 대화로그 적재 + 트래커 종료.
  // 자체 try/catch로 상주를 불사(unhandled rejection 0). inflight는 테스트 drain용.
  private launchCollaboration(
    question: string,
    team: string[],
    userId: string,
    threadKey: string,
    post: PostFn,
    attempt = 0,
  ): void {
    const tracked = this.tracker.start(threadKey, { question, team });
    const work: Promise<void> = (async (): Promise<void> => {
      try {
        // 진행 중 표시: 협업의 중간 보고(팀 구성·의견 도착·종합 중)는 진행 메시지로 게시한다 —
        // 아래 최종 결과 post는 표식 없이 나가 렌더러 애니메이션이 그 시점에 멈춘다.
        // 진행 카드: 이 협업 한 번이 카드 하나다(실행 id로 묶여 코딩 카드와 절대 안 섞인다).
        const run = { id: newRunId(), title: t('runCollabTitle') };
        const result = await this.collaborate(question, team, userId, { onProgress: this.progressPost(post, run) });
        // ask-user(실사고 2026-07-25): 여기도 미배선이라 합성 결과에 펜스가 섞이면 JSON이 날것으로
        // 노출됐다. 합성 결과라도 사용자에게 물을 게 있으면 카드가 맞다(답은 새 멘션으로 재진입).
        const { text: resultText, question: resultQuestion } = extractAskUser(result);
        // 채널 기억: 결과를 대화로그에 적재(후속 맥락·B수집 소스). 부수효과 실패는 무시.
        await this.conversations
          .append(userId, {
            ts: new Date().toISOString(),
            question,
            answer: resultQuestion ? (resultText || questionFallbackText(resultQuestion)) : resultText,
            sources: [],
          })
          .catch(() => {});
        this.tracker.finish(threadKey, tracked.id, 'done');
        if (resultQuestion) await post(resultText || questionFallbackText(resultQuestion), undefined, resultQuestion);
        else await post(resultText);
      } catch (err) {
        this.tracker.finish(threadKey, tracked.id, 'failed');
        this.logger.warn(`백그라운드 협업 실패: ${String(err)}`, 'Orchestrator');
        try {
          // 자가 재시도(6b-3-2): 예외 실패만, 상한 2회. 예약 실패(미주입·null)는 기존 메시지 강등.
          if (attempt >= 2) { await post(t('collabFailedNeedHuman')); return; }
          if (await this.scheduleCollabRetry(question, team, threadKey, attempt, post)) return;
          await post(t('collabFailed'));
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
    post: PostFn,
  ): Promise<boolean> {
    if (allows(this.policy(), channelId, cap)) return true;
    const label: Record<string, string> = { coding: t('capCoding'), schedule: t('capSchedule'), collaborate: t('capCollaborate') };
    await post(t('channelCapBlocked', label[cap]));
    return false;
  }

  // 테스트에서 override 가능하도록 메서드로 감쌈(모듈 resolveRepo는 coderepos.spec이 커버).
  private resolveRepoPaths(repoRef: string): string[] {
    return resolveRepo(repoRef, this.codeRepos());
  }

  // 멘션 코딩 진입: repo 해소 → 0/1/N 분기. brain: 요청 한정 채널 두뇌(스펙 §3.2, 미지정=기존 codeBrain).
  private async startCoding(repoRef: string, goal: string, threadKey: string, post: PostFn, brain?: BrainProvider, permMode?: PermMode, scheduled = false): Promise<void> {
    const matches = this.resolveRepoPaths(repoRef);
    if (matches.length === 0) {
      await post(t('repoNotFound', repoRef));
      return;
    }
    if (matches.length > 1) {
      this.pending.set(threadKey, { kind: 'disambiguate', candidates: matches, goal });
      const actions: Action[] = [
        ...matches.map((m, i) => ({ label: `${i + 1}. ${m}`, send: String(i + 1) })),
        { label: t('cancelLabel'), send: '취소' },
      ];
      await post(t('multipleReposFound', matches.map((m, i) => `${i + 1}. ${m}`).join('\n')), actions);
      return;
    }
    await this.startProposal(matches[0], goal, threadKey, post, brain, permMode, scheduled);
  }

  // Code 채널 대화(2026-07-07): 레포 읽고(읽기전용) 대화체로 답 + 코드요청이면 goal 추출.
  // 조회만 한다 — 게시·pending은 호출 분기(Step 6)가 결정. 읽기전용이라 게이트 없음(질문=chat 동급).
  // brain: 요청 한정 채널 두뇌(미지정=기존 codeBrain).
  // onChunk(코드 채널 스트리밍): 있으면 두뇌가 흘리는 텍스트 조각을 그대로 중계한다(미주입=기존과 바이트 동일).
  // effort(노력): resolveTurnEffort가 정한 이 턴의 확정값 — 미주입이면 CompleteOpts에 필드 자체가 안 생긴다.
  private async answerInCode(
    msg: CoreMessage,
    threadKey: string,
    brain?: BrainProvider,
    onChunk?: (text: string) => void,
    effort?: EffortLevel,
  ): Promise<{ reply: string; goal?: string; question?: AskUserPayload }> {
    const useBrain = brain ?? this.codeBrain;
    if (!useBrain || !msg.repoPath) return { reply: t('answerUnavailable') };

    let recent = '';
    try {
      const recs = await this.conversations.recent(msg.userId, 6);
      recent = recs.map((r) => `Q: ${r.question}\nA: ${r.answer.slice(0, 400)}`).join('\n');
    } catch { /* 연속성 실패는 무시 — 답변은 계속 */ }

    const tasks = this.tracker.status(threadKey);
    const taskStatus = tasks.length ? tasks.map((t) => `- ${t.question} — ${t.state}`).join('\n') : '';

    const prompt = buildCodeChatPrompt(loadPrompt('code-chat', CODE_CHAT_DEFAULT), {
      repoPath: msg.repoPath, userText: msg.text.trim(), recent, taskStatus,
    });
    // 읽기전용 도구 + --add-dir로 레포 읽기 보장(헤드리스 claude가 cwd 밖을 막을 수 있음).
    // 읽기전용은 이 allowedTools에 쓰기 도구가 없음에 의존한다 — 프로필(brains.json)이 Edit/Write를 직접 주면 깨질 수 있음(기본 프로필 extraArgs는 비어 안전).
    // AI 웹 조작(2단계): 버스가 배선돼 있을 때만 두 가지가 더 붙는다 —
    //  ① CLI 하네스: 엔그램 MCP를 허용 목록에 넣고(browser_* 도구가 그리로 온다) 스폰 env에
    //     ENGRAM_CHANNEL_ID를 심는다. claude가 스폰하는 MCP 자식이 이 env를 물려받는 것이 실측 확인됐다.
    //  ② 자체 하네스: 채널이 묶인 클로저(browser)로 직접 노출.
    // 미배선이면 인수·env·도구 전부 기존과 바이트 동일(회귀 0).
    const webControl = this.browserBus
      ? {
          allowed: 'Read,Glob,Grep,WebSearch,WebFetch,mcp__engram,mcp__plugin_engram_engram',
          // threadKey가 곧 채널 id다(self 채팅은 threadId를 안 쓴다 — cancelByChannel 주석과 동일 근거).
          env: { ENGRAM_CHANNEL_ID: threadKey },
          browser: (op: BrowserOp): Promise<BrowserOpResult> => this.browserBus!.request(threadKey, op),
        }
      : null;
    const r = await useBrain.complete(prompt, onChunk, {
      cwd: msg.repoPath,
      extraArgs: ['--allowedTools', webControl?.allowed ?? 'Read,Glob,Grep,WebSearch,WebFetch', '--add-dir', msg.repoPath],
      ...(webControl ? { env: webControl.env, browser: webControl.browser } : {}),
      ...(effort ? { effort } : {}),
    });
    if (r.isError) return { reply: brainErrorHint(r.raw) };
    // 질문 블록을 먼저 떼어낸 뒤 제안 마커를 판정한다(순서 중요 — 실사고 2026-07-25): ask_user가
    // 뒤에 붙으면 propose의 끝 앵커가 안 맞아 제안이 통째로 무시됐다. 먼저 떼면 남은 텍스트의
    // 끝이 다시 propose가 되어 둘 다 산다. 블록이 없으면 extractAskUser는 원문을 그대로 돌려준다(회귀 0).
    const { text: withoutAsk, question } = extractAskUser(r.text);
    return { ...extractPropose(withoutAsk), question };
  }

  // 완성조건 초안 → 대상·조건 게시 → 승인 대기. brain: 요청 한정 채널 두뇌(미지정=기존 codeBrain).
  // permMode: 이 턴의 채널 권한 모드 — 쓰기 검증(bypass면 울타리 밖 폴더도 통과)에 그대로 넘긴다.
  private async startProposal(targetPath: string, goal: string, threadKey: string, post: PostFn, brain?: BrainProvider, permMode?: PermMode, scheduled = false): Promise<void> {
    if (!this.fence || !this.projects) { await post(t('codingNotReady')); return; }
    try { this.fence.assertWritable(targetPath, permMode); }
    catch { await post(t('pathProtected')); return; }
    const cfg = await this.proposeProject(targetPath, goal, brain);
    const crit = cfg.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
    // 예약발(2026-08-01): 승인 대기 없이 바로 실행. 예약 등록이 곧 승인이고, 무인 시간대에 답할
    // 사람이 없다 — 완성조건은 그대로 게시해 아침에 무엇이 어떤 기준으로 돌았는지 남긴다.
    if (scheduled) {
      await this.approveProject(cfg.id);
      await post(t('proposalAutoStart', targetPath, crit, cfg.gate.test, cfg.gate.build, cfg.gate.typecheck));
      this.launchCoding(cfg.id, targetPath, threadKey, post, 0, brain, permMode);
      return;
    }
    this.pending.set(threadKey, { kind: 'approve', projectId: cfg.id, path: targetPath });
    await post(
      t('proposalReady', targetPath, crit, cfg.gate.test, cfg.gate.build, cfg.gate.typecheck),
      [
        { label: t('approveLabel'), send: '승인', confirm: t('startCodingConfirm') },
        { label: t('cancelLabel'), send: '취소' },
      ],
    );
  }

  // codeRun을 백그라운드로 detach(6b-1 패턴). 진행만 중계, 코드 에이전트 onChunk는 미게시.
  // brain: 요청 한정 채널 두뇌(스펙 §3.2, 미지정=기존 codeBrain) — codeRun·CodingSpecialist.work까지 전달.
  // permMode: 이 턴의 채널 권한 모드 — codeRun을 거쳐 CodingSpecialist의 게이트까지 그대로 흘러간다.
  private launchCoding(projectId: string, targetPath: string, threadKey: string, post: PostFn, attempt = 0, brain?: BrainProvider, permMode?: PermMode): void {
    // 프로젝트당 실행 1개(2026-08-01 실측): 예약 발사×2·예약+부팅재개가 같은 projectId(targetPath
    // 결정적)로 동시에 돌아 같은 저장소 티켓을 이중 수행했다. 모든 시작 경로(승인·예약·재개)가
    // 여기로 수렴하므로 이 가드 하나로 전부 잠긴다. 거부는 조용히 하지 않는다 — 사유를 게시.
    if (this.codingInflightProjects.has(projectId)) { void post(t('codingAlreadyRunning', targetPath)); return; }
    this.codingInflightProjects.add(projectId);
    const tracked = this.tracker.start(threadKey, { question: t('codingTaskLabel', targetPath), team: ['Coder'] });
    const work: Promise<void> = (async (): Promise<void> => {
      try {
        // 진행 중 표시: 시작 안내부터 루프의 각 단계까지 전부 진행 메시지 — 마지막 하나만 렌더러에서
        // 애니메이션이 돌고 앞의 것들은 완료 점으로 남는다. 결과/실패 메시지는 표식 없이 나간다.
        // 진행 카드: 이 코딩 실행 한 번이 카드 하나다. 같은 채널에서 협업이 동시에 돌아도 실행 id가
        // 달라 섞이지 않고, 표식이 기록에 남아 재시작 후에도 같은 카드로 복원된다.
        const run = { id: newRunId(), title: t('runCodingTitle') };
        const report = this.progressPost(post, run);
        await report(t('codingStarted'));
        const r = await this.codeRun(projectId, {
          channelId: threadKey,
          onProgress: (m, kind) => { void report(`· ${m}`, kind); },
          brain, ...(permMode ? { permMode } : {}),
        });
        this.tracker.finish(threadKey, tracked.id, r.status === 'SUCCESS' ? 'done' : 'failed');
        // 자가 재개(6b-3-2): STUCK/BUDGET만, 상한 2회. STOPPED=사용자 의지, SUCCESS=끝.
        if (r.status === 'STUCK' || r.status === 'BUDGET') {
          if (attempt >= 2) { await post(t('resumeGaveUp', r.sessionId)); return; }
          if (await this.scheduleCodingResume(projectId, r.status, threadKey, attempt, post)) return;
        }
        // 완료 보고서(2026-07-25): 성공했으면 실제 재료(착지 티켓·재시도 이력·변경 파일·게이트)를
        // 두뇌에게 주고 쓰게 한다. 실패하면 절대 침묵하지 않고 기존 한 줄로 되돌아간다.
        if (r.status === 'SUCCESS' && await this.postCompletionReport(projectId, r.log, post, brain)) return;
        await post(this.codingResultMessage(r, targetPath));
      } catch (err) {
        this.tracker.finish(threadKey, tracked.id, 'failed');
        this.logger.warn(`백그라운드 코딩 실패: ${String(err)}`, 'Orchestrator');
        try { await post(t('codingFailed')); } catch { /* post도 실패하면 포기 */ }
      }
    })().finally(() => {
      this.codingInflightProjects.delete(projectId);
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
    post: PostFn,
  ): Promise<boolean> {
    if (!this.scheduler) return false;
    const { cron, human } = computeResume(status, new Date());
    const e = this.scheduler.add(
      { channelId: threadKey, cron, task: `resume ${projectId} ${attempt + 1}`, once: true },
      { internal: true },
    );
    if (!e) return false;
    const why = status === 'STUCK' ? t('stuckLabel') : t('budgetLabel');
    await post(t('resumeScheduled', why, human, e.id, attempt));
    return true;
  }

  // 예약된 코딩 재개 실행: 존재·승인 확인 → runState 복원(STUCK이 남긴 paused) → 백그라운드 재실행.
  // brain: 요청 한정 채널 두뇌(재주입 메시지가 실어온 것 — self.adapter가 매 이벤트에 최신 채널 brain을
  // 첨부하므로 사용자의 "resume" 답장이나 예약 발사 둘 다 이 경로로 흐른다. 미지정=기존 codeBrain).
  private async resumeCoding(projectId: string, attempt: number, threadKey: string, post: PostFn, brain?: BrainProvider, permMode?: PermMode): Promise<void> {
    if (!this.projects) { await post(t('codingNotReady')); return; }
    const project = await this.projects.get(projectId);
    if (!project) { await post(t('projectNotFound')); return; }
    if (!project.approved) { await post(t('projectNotApproved')); return; }
    // ponytail: runState는 전역 스위치(N=1 가정) — 재개가 engram pause로 멈춘 다른 코딩까지 풀 수 있다. N>1이면 프로젝트별 run-state로.
    this.setRunState('running');
    await post(t('resuming', project.targetPath, attempt));
    this.launchCoding(projectId, project.targetPath, threadKey, post, attempt, brain, permMode);
  }

  // 재시작 생존(Phase 10b): 부팅 시 호출. RUNNING 코딩 레코드를 각자 채널로 재개(승인된 프로젝트만 —
  // resume hatch가 approved 확인). 스테일 레코드는 제거(재개가 새 세션을 만든다).
  // ponytail: 코딩만 — 협업은 분 단위라 재개 불필요. 재개 시 attempt=0(fresh).
  // post: 진행 표식(progress/completionReport)까지 관통(2026-08-01) — 좁히면 재개된 코딩의 진행
  // 카드·완료 보고 표식이 생산 단계에서 유실된다(dev 실측: 재개 실행 메시지에 표식 없음).
  async resumeInterrupted(post: (channelId: string, text: string, progress?: boolean | ProgressRun, completionReport?: boolean) => Promise<void>): Promise<number> {
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
        // remove→re-inject 순서: handleMention이 remove와 launch 사이에서 동기 throw하면 이 레코드는 유실된다.
        // 실제로 resumeCoding은 실패 시 post 후 return(throw 아님)이고 launchCoding은 자기격리라 창은 사실상 0.
        // 뒤집으면(재주입 후 remove) 옛 RUNNING 레코드와 새 세션이 겹쳐 다음 부팅에 이중 재개 위험 → 현 순서 유지.
        await this.tasks.remove(rec.id); // 스테일 세션 제거 — 재개가 새 세션 생성
        await this.handleMention(
          { text: `resume ${projectRef}`, userId: channelId, brain: this.channelBrainOf(channelId) },
          (t, _actions, _question, _tools, progress, completionReport) => post(channelId, t, progress, completionReport),
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
    post: PostFn,
  ): Promise<boolean> {
    if (!this.scheduler) return false;
    const { cron, human } = computeResume('COLLAB', new Date());
    const e = this.scheduler.add(
      { channelId: threadKey, cron, task: `retry ${attempt + 1} ${team.join(',')} ${question}`, once: true },
      { internal: true },
    );
    if (!e) return false;
    await post(t('collabRetryScheduled', human, e.id, attempt));
    return true;
  }

  // 완료 보고서 게시(2026-07-25). 성공했으면 "무엇을·어떻게·무엇이 바뀌었고·검증은 됐고·뭐가
  // 남았는지"까지 두뇌가 실제 재료를 보고 쓴다. 게시했으면 true — 호출부는 기존 한 줄을 생략한다.
  // ⚠️ 여기서 무슨 일이 나도 false를 돌려줄 뿐 절대 던지지 않는다: 보고서 실패가 "완료했다"는
  //   사실 자체를 삼켜 화면이 침묵하면 그게 제일 나쁜 결과다(호출부가 기존 한 줄로 폴백).
  private async postCompletionReport(
    projectId: string, log: CodeRunLog, post: PostFn, brain?: BrainProvider,
  ): Promise<boolean> {
    try {
      const text = await this.buildCompletionReport(projectId, log, brain);
      if (!text) return false;
      await post(text, undefined, undefined, undefined, undefined, true);
      return true;
    } catch (err) {
      this.logger.warn(`완료 보고서 생성 실패(기존 한 줄로 폴백): ${String(err)}`, 'Orchestrator');
      return false;
    }
  }

  // 재료 → 두뇌 → 보고서 본문. 재료는 전부 이번 실행이 실제로 남긴 것(착지 티켓·재시도 이력·
  // git 변경 통계·게이트 명령)뿐이다 — 지어내지 말라고 프롬프트에도 못 박는다.
  // 못 쓰면 null(협력자 미주입·두뇌 오류·빈 응답) → 호출부가 기존 한 줄로 폴백.
  async buildCompletionReport(projectId: string, log: CodeRunLog, brain?: BrainProvider): Promise<string | null> {
    const useBrain = brain ?? this.codeBrain;
    const project = await this.projects?.get(projectId);
    if (!useBrain || !project) return null;
    const files = log.baseSha && this.codingGit
      ? await this.codingGit.diffStat(project.targetPath, log.baseSha)
      : [];
    const materials = [
      `\n# Target\n${project.targetPath} (branch ${project.branch})`,
      `\n# Acceptance criteria\n${project.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n') || '(none)'}`,
      `\n# What landed\n${log.landed.map((l) => `- [${l.area}] ${l.summary}`).join('\n') || '(nothing recorded)'}`,
      `\n# Failures and retries during the run\n${
        log.retries.map((r) => `- [${r.area}] attempt ${r.attempt}: ${r.reason}`).join('\n') || '(none)'}`,
      `\n# Files changed (git, this run)\n${
        files.map((f) => `- ${f.path} +${f.added} −${f.removed}`).join('\n') || '(none detected)'}`,
      `\n# Verification gate (all of these passed before each commit)\ntest: ${project.gate.test}\nbuild: ${project.gate.build}\ntypecheck: ${project.gate.typecheck}`,
      `\n# Rounds\n${log.rounds}`,
    ].join('\n');
    const prompt = [
      loadPrompt('completion-report', COMPLETION_REPORT_DEFAULT),
      materials,
      `\n${outputDirective('autonomous')}`,
    ].join('\n');
    const r = await useBrain.complete(prompt);
    if (r.isError) return null;
    const text = r.text.trim();
    return text || null;
  }

  private codingResultMessage(r: { status: string; sessionId: string }, targetPath: string): string {
    if (r.status === 'SUCCESS') return t('codingSuccessMessage', targetPath);
    const why: Record<string, string> = { STUCK: t('stuckLabel'), STOPPED: t('stoppedLabel'), BUDGET: t('budgetLabel') };
    return t('codingEndedMessage', why[r.status] ?? r.status, r.sessionId);
  }

  private async doSchedule(cron: string, task: string, once: boolean, channelId: string, threadKey: string, post: PostFn): Promise<void> {
    if (!this.scheduler) { await post(t('scheduleNotReady')); return; }
    const threadId = threadKey !== channelId ? threadKey : undefined;
    const e = this.scheduler.add({ channelId, threadId, cron, task, once });
    if (!e) { await post(t('scheduleUnclear')); return; }
    // 취소 버튼(2026-08-01, UX): 등록 직후가 "아차, 잘못 걸었다"의 순간 — ID 타이핑 없이 한 번에.
    await post(t('scheduleCreated', e.id, e.cron, once), [{ label: t('cancelThisScheduleLabel'), send: `예약취소 ${e.id}` }]);
  }

  private formatSchedules(channelId: string): string {
    if (!this.scheduler) return t('scheduleNotReady');
    const list = this.scheduler.list(channelId);
    if (list.length === 0) return t('noSchedules');
    return list.map((e: ScheduleEntry, i: number) => t('scheduleListItem', i, e.id, e.cron, e.task.slice(0, 40), e.once)).join('\n');
  }

  // @Engram 상태 출력. 질문은 40자 잘라 표시(상대시간은 비범위 — 단순화).
  private formatStatus(tasks: TrackedTask[]): string {
    if (tasks.length === 0) return t('noTasks');
    const line = (tk: TrackedTask): string =>
      t('taskLine', tk.question.slice(0, 40), tk.team.join('·') || '-', tk.state === 'failed');
    const running = tasks.filter((tk) => tk.state === 'running');
    const finished = tasks.filter((tk) => tk.state !== 'running');
    const parts: string[] = [];
    if (running.length) parts.push(t('runningCount', running.length, running.map(line).join('\n')));
    if (finished.length) parts.push(t('recentlyDone', finished.map(line).join('\n')));
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
      // 요청 한정 채널 두뇌(스펙 §3.2). channelBrain 미주입이면 this.codeBrain 그대로(회귀 0).
      const brain = this.resolveMsgBrain(msg);
      if (!this.rag || !brain) return;
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
        outputDirective('autonomous', configuredLang()),
        `\n# Chat message\n${text}`,
        `\n# Wiki excerpts\n${hits.map((h) => `- [${h.slug}] ${h.text.slice(0, 200)}`).join('\n')}`,
        '\nOutput only this JSON: {"interject":true|false,"text":"one or two sentences"}',
      ].join('\n');
      const r = await brain.complete(prompt);
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
  // brain: 요청 한정 채널 두뇌(미지정=기존 codeBrain).
  private async classify(text: string, brain?: BrainProvider): Promise<{ kind: 'chat' | 'collaborate' | 'code' | 'schedule'; team: string[]; repoRef?: string; goal?: string; cron?: string; task?: string; once?: boolean }> {
    const useBrain = brain ?? this.codeBrain;
    if (!useBrain) return { kind: 'chat', team: [] };
    const roster = (this.registry?.all() ?? []).map((p) => `- ${p.name}: ${p.role}`).join('\n');
    const aliases = Object.keys(this.codeRepos().aliases);
    const prompt = [
      loadPrompt('triage', TRIAGE_DEFAULT),
      `\n# Available experts\n${roster || '(none)'}`,
      `\n# Code repos (alias)\n${aliases.join(', ') || '(none)'}`,
      `\n# User message\n${text}`,
      '\nOutput only this JSON: {"kind":"chat"|"collaborate"|"code"|"schedule","team":["name",...],"repo":"repo ref","goal":"the task","cron":"0 9 * * *","task":"the task","once":false}',
    ].join('\n');
    try {
      const r = await useBrain.complete(prompt);
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
    await prog(t('teamFormedCollab', personas.join(', ')));
    await Promise.all(
      personas.map((p) =>
        this.sem!.run(async () => {
          if (!budget.tryConsume()) return; // 예산 소진 → 스킵(턴 천장)
          try {
            const text = await this.specialist!.contribute(p, question, userId);
            await this.tasks!.contribute(session.id, p, text);
            await prog(t('opinionArrived', p));
          } catch (err) {
            this.logger.warn(`페르소나 기여 실패(스킵) ${p}: ${String(err)}`, 'Orchestrator');
            await prog(t('personaSkipped', p));
          }
        }),
      ),
    );
    await prog(t('synthesizingOpinions'));
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
      `\n# Goal\n${goal}`,
      '\nOutput only this JSON: {"tickets":[{"area":"directory/area","instruction":"the task"}]}',
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
  // brain: 요청 한정 채널 두뇌(스펙 §3.2, 미지정=기존 codeBrain).
  async proposeProject(targetPath: string, goal: string, brain?: BrainProvider): Promise<ProjectConfig> {
    const useBrain = brain ?? this.codeBrain;
    if (!this.projects || !useBrain || !this.fence) throw new Error('proposeProject 협력자 미주입');
    this.fence.assertWritable(targetPath); // denyPaths/writePaths 밖 거부(자기수정 차단 ③)
    const prompt = [
      'Estimate the acceptance criteria (verifiable items) for the goal below.',
      `\n# Goal\n${goal}\n# Target path\n${targetPath}`,
      '\nOutput only this JSON: {"acceptanceCriteria":["..."]}',
    ].join('\n');
    const r = await useBrain.complete(prompt);
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
  // opts.brain: 요청 한정 채널 두뇌(스펙 §3.2) — decompose·CodingSpecialist.work에 전달. 미지정=기존 codeBrain.
  // opts.permMode: 이 턴의 채널 권한 모드(코드 채널별) — 아래 쓰기 재검증과 CodingSpecialist.work의
  //   게이트(codeGuard/cmdGuard)까지 그대로 흘린다. 미지정=전역 설정 폴백(회귀 0).
  async codeRun(
    projectId: string,
    opts: {
      maxRounds?: number; stuckK?: number; onChunk?: (t: string) => void;
      // kind: 이 단계의 성격(재시도·실패) — 진행 카드의 마커가 여기서만 결정된다(렌더러 텍스트 매칭 금지).
      onProgress?: (m: string, kind?: StepKind) => void;
      channelId?: string; brain?: BrainProvider; permMode?: PermMode;
    } = {},
  ): Promise<{ status: 'SUCCESS' | 'STUCK' | 'STOPPED' | 'BUDGET'; sessionId: string; log: CodeRunLog }> {
    if (!this.projects || !this.gate || !this.codingGit || !this.coder || !this.reviewer || !this.sem || !this.codeBrain || !this.fence) {
      throw new Error('코딩 협력자가 주입되지 않음(Orchestrator.codeRun)');
    }
    // 진행 narrate(블랙박스 방지). CLI가 stdout으로 흘린다.
    const report = opts.onProgress ?? ((): void => {});
    // 완료 보고서 재료(2026-07-25) — 화면에 이미 보인 사실만 모은다(새 관측 없음).
    const log: CodeRunLog = { baseSha: null, landed: [], retries: [], rounds: 0 };
    const finish = async (
      session: { id: string },
      status: 'SUCCESS' | 'STUCK' | 'STOPPED' | 'BUDGET',
    ): Promise<{ status: 'SUCCESS' | 'STUCK' | 'STOPPED' | 'BUDGET'; sessionId: string; log: CodeRunLog }> =>
      ({ ...(await this.exit(session, status)), log });
    const project = await this.projects.get(projectId);
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`);
    if (!project.approved) throw new Error(`완성조건 미승인 — engram code 승인 먼저: ${projectId}`);

    // 심층 방어: codeRun 진입 시점에도 쓰기 권한 재검증(proposeProject 이후 설정 변경 대비).
    // 이번 턴의 권한 모드를 함께 넘긴다 — plan이면 여기서 막히고, bypass면 울타리 밖 타깃도 통과한다.
    this.fence.assertWritable(project.targetPath, opts.permMode);

    await this.codingGit.ensureBranch(project.targetPath, project.branch);
    // 변경 파일 계산 기준점 — 이 실행이 커밋하기 전의 HEAD. 못 구해도(레포 이상) 그냥 null로 두고
    // 진행한다(보고서에서 "바뀐 파일" 절이 빠질 뿐 — 코딩을 멈출 이유가 아니다).
    log.baseSha = await this.codingGit.head(project.targetPath);
    const session = await this.tasks!.createCoding({
      question: project.acceptanceCriteria.join(' / '), projectRef: projectId,
      criteriaTotal: project.acceptanceCriteria.length,
      ...(opts.channelId ? { channelId: opts.channelId } : {}),
    });
    await this.tasks!.transition(session.id, 'RUNNING');
    report(t('decomposing'));
    const brain = opts.brain ?? this.codeBrain;
    const initial = await this.decompose(project.acceptanceCriteria.join('\n'), brain);
    await this.tasks!.addTickets(session.id, initial);
    report(t('decomposeDone', initial.length));

    const stuck = new StuckDetector(opts.stuckK ?? 3);
    const maxRounds = opts.maxRounds ?? 100;
    let budgetSpent = 0;
    // 리뷰어 보완 상한(2026-08-01 실사고): fetch+rebase 잡일에 리뷰어가 라운드마다 "추가 작업 5개"를
    // 만들어 2분 반짜리 일이 12분+로 늘었다. 프롬프트("충족이면 승인")는 LLM이 안 지키면 그만 —
    // 구조로 자른다: 보완 기회 1회·추가 티켓 3개까지, 그 뒤 전 티켓 착지+게이트 초록이면 완료다.
    // 게이트(객관 검증)는 그대로다 — 상한은 리뷰어의 범위 불리기에만 건다.
    const MAX_REVIEW_EXTRA_ROUNDS = 1;
    const MAX_REVIEW_EXTRA_TICKETS = 3;
    let reviewExtraRounds = 0;

    for (let round = 0; round < maxRounds; round++) {
      if (this.runState !== 'running') return finish(session, 'STOPPED');
      log.rounds = round + 1;

      const fresh = await this.tasks!.get(session.id);
      const open = (fresh?.tickets ?? []).filter((t) => t.status !== 'SUCCESS');
      report(t('roundProgress', round, open.length));

      // 동시 코딩(공유 체크아웃, N=concurrency). Semaphore가 동시 호출 제한.
      await Promise.all(open.map((ticket) => this.sem!.run(async () => {
        if (this.runState !== 'running') return;
        try {
          report(t('codingTicket', ticket.area));
          await this.tasks!.updateTicket(session.id, ticket.id, { status: 'RUNNING', attempts: ticket.attempts + 1 });
          const summary = await this.coder!.work(this.pickPersona(project), ticket, project, opts.onChunk, opts.brain, opts.permMode);
          budgetSpent += 1; // ponytail: 호출 수 근사. 실토큰 회계는 후속(§14).
          report(t('gateRunning', ticket.area));
          const result = await this.gate!.run(project.targetPath, project.gate);
          if (result.pass) {
            await this.codingGit!.commitAll(project.targetPath, `engram: ${ticket.id} ${ticket.area}`);
            await this.tasks!.updateTicket(session.id, ticket.id, { status: 'SUCCESS', gate: { pass: true, output: summary } });
            await this.tasks!.contribute(session.id, ticket.id, summary);
            log.landed.push({ area: ticket.area, summary });
            report(t('ticketLanded', ticket.area));
          } else {
            await this.tasks!.updateTicket(session.id, ticket.id, { status: 'PENDING', gate: { pass: false, output: result.output } });
            const why = result.failed ?? t('failureFallback');
            log.retries.push({ area: ticket.area, attempt: ticket.attempts + 1, reason: why });
            // 게이트 빨강 = 이번 시도 실패(카드 마커 ✗). 다음 라운드에서 다시 시도한다.
            report(t('gateFailed', ticket.area, why), 'fail');
          }
        } catch (err) {
          this.logger.warn(`코딩 티켓 실패(재시도 대기) ${ticket.id}: ${String(err)}`, 'Orchestrator');
          // 실사고(2026-07-25): 여기가 로그로만 끝나 화면은 몇 분간 아무 말이 없었다("갑자기 완료된 것처럼
          // 나온다"). 실패·재시도도 진행 보고로 올린다 — 사유는 한 줄로 잘라 채팅이 스택트레이스로
          // 덮이지 않게 한다(전문은 여전히 로그에 있다).
          // 카드 마커 ↻(재시도) — 무엇이 왜 다시 도는지는 이 표식 하나로 정해진다.
          log.retries.push({ area: ticket.area, attempt: ticket.attempts + 1, reason: shortReason(err) });
          report(t('ticketFailedRetry', ticket.area, ticket.attempts + 1, shortReason(err)), 'retry');
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
        report(t('reviewingCriteria'));
        const review = await this.reviewer!.review(project.acceptanceCriteria, Object.values(after?.blackboard ?? {}).join('\n'));
        if (review.approved) { report(t('criteriaMet')); return finish(session, 'SUCCESS'); }
        if (reviewExtraRounds >= MAX_REVIEW_EXTRA_ROUNDS) {
          // 보완 기회 소진 + 전 티켓 착지·게이트 초록 = 완료로 처리(정직하게 사유 게시).
          report(t('reviewCapDone'));
          return finish(session, 'SUCCESS');
        }
        reviewExtraRounds++;
        const extras = review.extraTickets.slice(0, MAX_REVIEW_EXTRA_TICKETS);
        report(t('reviewerExtraTickets', extras.length));
        await this.tasks!.addTickets(session.id, extras.map((t, i) => ({ id: `tk_rev_${round}_${i}`, area: t.area, instruction: t.instruction })));
      }

      if (project.budget.tokens !== null && budgetSpent >= project.budget.tokens) { this.runState = 'paused'; return finish(session, 'BUDGET'); }
      // 방금 기록한 진전 값으로 stuck 관측(재조회 불필요). progressKey = landed:criteriaMet.
      if (stuck.observe(`${landed}:${criteriaMet}`)) { this.runState = 'paused'; return finish(session, 'STUCK'); }
    }
    return finish(session, 'STUCK');
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
      await this.tasks!.setResult(session.id, t('criteriaMetStored'));
      await this.tasks!.transition(session.id, 'SUCCESS');
      await this.tasks!.remove(session.id); // 진행상태 일회용 — 완료 시 삭제(findings는 위키 보존)
    } else {
      this.logger.warn(`코딩 세션 ${status}: ${session.id} — 사람 알림`, 'Orchestrator');
    }
    return { status, sessionId: session.id };
  }
}
