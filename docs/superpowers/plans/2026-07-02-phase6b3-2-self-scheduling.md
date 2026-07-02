# Phase 6b-3-2 자가 스케줄 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 코딩이 STUCK/BUDGET으로 끝나거나 협업이 예외로 실패하면 Engram이 스스로 1회(once) 재개 예약을 걸고(상한 2회, 무승인), 그 시각에 이어서 한다.

**Architecture:** 6b-3-1 예약 인프라(ScheduleStore/ScheduleService/SchedulerPort/once)에 **내부 명령 재주입** — 재개 예약의 task에 `resume <projectId> <attempt>` / `retry <attempt> <팀CSV> <질문>`을 넣고, 발사는 기존 `fire→handleMention` 경로 그대로, handleMention에 escape hatch 2개 추가. 딜레이 계산은 순수 함수 `resume-policy.ts`. `firingDepth` 가드는 `{ internal: true }` 옵션으로만 우회.

**Tech Stack:** NestJS/TypeScript, Jest. **새 dep 0.** 스펙: `docs/superpowers/specs/2026-07-02-phase6b3-2-self-scheduling-design.md`.

## Global Constraints

- 셸은 PowerShell(이 머신은 Bash 도구 깨짐). 테스트: `npx jest <파일경로> --silent`.
- 새 의존성 추가 금지.
- 사용자 노출 문구는 자연스러운 한국어(스펙의 문구 그대로).
- 커밋 프리픽스 `feat(phase6b3-2):` / `test(phase6b3-2):`. 공동 작업자(Co-Authored-By) 넣지 않음.
- 자동 재개 상한 = 2회(attempt 0→1→2, attempt≥2면 예약 대신 사람 호출).
- `STOPPED`(사용자 정지)·`SUCCESS`는 절대 재예약하지 않는다.
- Orchestrator 생성자 18인자 무변경. 테스트는 기존 `orc()` 헬퍼 패턴(18개 null/스텁) 재사용.
- PinoLogger엔 `info()` 없음 — `log/warn/error`만.

---

### Task 1: `resume-policy.ts` — 상태별 재개 시각 계산(순수 함수)

**Files:**
- Create: `src/agent-layer/resume-policy.ts`
- Test: `src/agent-layer/resume-policy.spec.ts`

**Interfaces:**
- Consumes: 없음(순수, `process.env`만).
- Produces: `type ResumeKind = 'STUCK' | 'BUDGET' | 'COLLAB'` · `function computeResume(kind: ResumeKind, now: Date): { cron: string; human: string }` — cron은 once용 5필드 `'분 시 일 월 *'`. Task 3·5가 import.

- [ ] **Step 1: Write the failing test**

`src/agent-layer/resume-policy.spec.ts`:

```ts
import { computeResume } from './resume-policy';

afterEach(() => {
  delete process.env.ENGRAM_RESUME_STUCK_MIN;
  delete process.env.ENGRAM_RESUME_COLLAB_MIN;
  delete process.env.ENGRAM_RESUME_BUDGET_HOUR;
});

it('STUCK: 60분 뒤 once cron(분 시 일 월 *)', () => {
  const r = computeResume('STUCK', new Date(2026, 6, 2, 13, 32)); // 2026-07-02 13:32
  expect(r.cron).toBe('32 14 2 7 *');
  expect(r.human).toBe('60분 뒤(14:32)');
});

it('COLLAB: 30분 뒤 — 자정 넘김이면 일/월 정확히 증가', () => {
  const r = computeResume('COLLAB', new Date(2026, 6, 2, 23, 45));
  expect(r.cron).toBe('15 0 3 7 *');
});

it('BUDGET: 오늘 9시가 지났으면 내일 9시', () => {
  const r = computeResume('BUDGET', new Date(2026, 6, 2, 10, 0));
  expect(r.cron).toBe('0 9 3 7 *');
  expect(r.human).toContain('내일');
});

it('BUDGET: 오늘 9시 전이면 오늘 9시', () => {
  const r = computeResume('BUDGET', new Date(2026, 6, 2, 3, 0));
  expect(r.cron).toBe('0 9 2 7 *');
  expect(r.human).toContain('오늘');
});

it('env 오버라이드: ENGRAM_RESUME_STUCK_MIN=5', () => {
  process.env.ENGRAM_RESUME_STUCK_MIN = '5';
  expect(computeResume('STUCK', new Date(2026, 6, 2, 13, 0)).cron).toBe('5 13 2 7 *');
});

it('비숫자/0 이하 env → 기본값 폴백', () => {
  process.env.ENGRAM_RESUME_STUCK_MIN = 'abc';
  expect(computeResume('STUCK', new Date(2026, 6, 2, 13, 0)).cron).toBe('0 14 2 7 *');
  process.env.ENGRAM_RESUME_COLLAB_MIN = '0';
  expect(computeResume('COLLAB', new Date(2026, 6, 2, 13, 0)).cron).toBe('30 13 2 7 *');
});

it('BUDGET 시 env 범위밖(25) → 기본 9시', () => {
  process.env.ENGRAM_RESUME_BUDGET_HOUR = '25';
  expect(computeResume('BUDGET', new Date(2026, 6, 2, 10, 0)).cron).toBe('0 9 3 7 *');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/agent-layer/resume-policy.spec.ts --silent`
Expected: FAIL — `Cannot find module './resume-policy'`

- [ ] **Step 3: Write minimal implementation**

`src/agent-layer/resume-policy.ts`:

```ts
// 자가 재개 예약 시각 계산(6b-3-2). 순수 — now 주입, env는 호출 시점 해석(로컬 타임존).
export type ResumeKind = 'STUCK' | 'BUDGET' | 'COLLAB';

// 비숫자/범위밖 env는 기본값 폴백(Number.isFinite 가드 — Phase 1 백로그① 패턴).
function envMinutes(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

function envHour(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? Math.floor(n) : def;
}

function two(n: number): string { return String(n).padStart(2, '0'); }

// once용 5필드 cron('분 시 일 월 *')과 사람용 설명.
// STUCK=60분 뒤(ENGRAM_RESUME_STUCK_MIN) · COLLAB=30분 뒤(ENGRAM_RESUME_COLLAB_MIN) ·
// BUDGET=다음 9시(ENGRAM_RESUME_BUDGET_HOUR, 지났으면 내일).
export function computeResume(kind: ResumeKind, now: Date): { cron: string; human: string } {
  let at: Date;
  let human: string;
  if (kind === 'BUDGET') {
    const hour = envHour('ENGRAM_RESUME_BUDGET_HOUR', 9);
    at = new Date(now);
    at.setHours(hour, 0, 0, 0);
    if (at <= now) at.setDate(at.getDate() + 1);
    human = `${at.toDateString() === now.toDateString() ? '오늘' : '내일'} ${hour}시`;
  } else {
    const min = envMinutes(
      kind === 'STUCK' ? 'ENGRAM_RESUME_STUCK_MIN' : 'ENGRAM_RESUME_COLLAB_MIN',
      kind === 'STUCK' ? 60 : 30,
    );
    at = new Date(now.getTime() + min * 60_000);
    human = `${min}분 뒤(${two(at.getHours())}:${two(at.getMinutes())})`;
  }
  return { cron: `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`, human };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/agent-layer/resume-policy.spec.ts --silent`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```powershell
git add src/agent-layer/resume-policy.ts src/agent-layer/resume-policy.spec.ts
git commit -m "feat(phase6b3-2): resume-policy — 상태별(STUCK/BUDGET/COLLAB) 재개 시각→once cron 순수 계산"
```

---

### Task 2: `SchedulerPort.add` opts + `ScheduleService` internal 우회

**Files:**
- Modify: `src/agent-layer/schedule-store.ts` (SchedulerPort 인터페이스만 — ScheduleStore 클래스 무변경)
- Modify: `src/edge/schedule-service.ts` (add 시그니처·가드 조건)
- Test: `src/edge/schedule-service.spec.ts` (기존 파일에 2 테스트 추가)

**Interfaces:**
- Consumes: 기존 `ScheduleService.add`/`firingDepth`/`fire`.
- Produces: `SchedulerPort.add(input, opts?: { internal?: boolean }): ScheduleEntry | null` — `internal: true`면 발사 중에도 등록 허용. Task 3·5가 사용. (기존 1인자 호출·스텁은 구조적 타이핑으로 그대로 호환.)

- [ ] **Step 1: Write the failing test**

`src/edge/schedule-service.spec.ts` 끝에 추가:

```ts
it('발사 중에도 internal add는 통과(자가 재개 예약)', async () => {
  const store = tmpStore();
  let svc: any;
  let reAdd: any = 'notset';
  const orchestrator = { handleMention: async () => {
    reAdd = svc.add({ channelId: 'c1', cron: '0 9 * * *', task: 'resume p1 1', once: true }, { internal: true });
  } };
  svc = service(orchestrator, new FakeMessenger(), fakeRegistry(), store);
  const e = store.add({ channelId: 'c1', cron: '0 9 * * *', task: 'X' });
  svc.fire(e);
  await new Promise((r) => setImmediate(r));
  expect(reAdd).not.toBeNull();
});

it('internal이라도 잘못된 cron은 null(검증은 동일)', () => {
  const svc = service({}, new FakeMessenger(), fakeRegistry(), tmpStore());
  expect(svc.add({ channelId: 'c1', cron: 'BAD', task: 'X' }, { internal: true })).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/edge/schedule-service.spec.ts --silent`
Expected: FAIL — 신규 테스트 1번이 `expect(reAdd).not.toBeNull()`에서 실패(현재는 발사 중 전면 거부). 기존 8 테스트는 PASS 유지.

- [ ] **Step 3: Write minimal implementation**

`src/agent-layer/schedule-store.ts` — SchedulerPort의 add만 교체:

```ts
// Orchestrator가 보는 스케줄러 포트(구현=ScheduleService). add는 잘못된 cron이면 null.
// opts.internal=true는 자가 재개 예약(6b-3-2) 전용 — 발사 중 재예약 가드를 우회한다.
export interface SchedulerPort {
  add(
    input: { channelId: string; threadId?: string; cron: string; task: string; once?: boolean },
    opts?: { internal?: boolean },
  ): ScheduleEntry | null;
  list(channelId: string): ScheduleEntry[];
  remove(id: string): boolean;
}
```

`src/edge/schedule-service.ts` — add 시그니처·가드 조건 교체:

```ts
  add(
    input: { channelId: string; threadId?: string; cron: string; task: string; once?: boolean },
    opts?: { internal?: boolean },
  ): ScheduleEntry | null {
    // 발사 중 재예약 금지(재진입 자기복제 루프 차단). 자가 재개(internal)는 attempt 상한으로 유계라 허용.
    if (!opts?.internal && this.firingDepth > 0) return null;
    if (!this.validCron(input.cron)) return null;
    const e = this.store.add(input);
    try { this.register(e); }
    catch (err) { this.logger.warn(`예약 등록 실패 ${e.id}: ${String(err)}`, 'Schedule'); }
    return e;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/edge/schedule-service.spec.ts src/agent-layer/orchestrator-schedule.spec.ts --silent`
Expected: PASS 전부(신규 2 포함, 기존 회귀 0)

- [ ] **Step 5: Commit**

```powershell
git add src/agent-layer/schedule-store.ts src/edge/schedule-service.ts src/edge/schedule-service.spec.ts
git commit -m "feat(phase6b3-2): SchedulerPort.add opts.internal — 자가 재개 예약만 발사중 가드 우회"
```

---

### Task 3: `launchCoding` 재예약 분기 (STUCK/BUDGET → once 예약, 상한 2회)

**Files:**
- Modify: `src/agent-layer/orchestrator.ts` (launchCoding 시그니처 attempt 추가 + scheduleCodingResume 신설 + computeResume import)
- Test: `src/agent-layer/orchestrator-resume.spec.ts` (신규)

**Interfaces:**
- Consumes: Task 1 `computeResume(kind, now)` · Task 2 `scheduler.add(input, { internal: true })` · 기존 `this.scheduler`(SchedulerPort, setScheduler 주입) · 기존 codingResultMessage.
- Produces: `private launchCoding(projectId: string, targetPath: string, threadKey: string, post: (t: string) => Promise<void>, attempt = 0): void` — Task 4의 resume hatch가 attempt를 전달해 호출. 예약 task 형식 `resume <projectId> <attempt+1>`.

- [ ] **Step 1: Write the failing test**

`src/agent-layer/orchestrator-resume.spec.ts` (신규 — orchestrator-coding.spec의 orc 패턴):

```ts
import { Orchestrator } from './orchestrator';

const logger = { warn() {}, error() {}, log() {} } as any;

// 생성자 18인자: (reader, conversations, logger, ingester, tasks, specialist, synth, sem,
//   projects, gate, codingGit, coder, reviewer, codeBrain, fence, reporter, registry, paths)
function orc(classifyJson: string) {
  const brain = { complete: async () => ({ text: classifyJson, costUsd: 0, isError: false }) } as any;
  const registry = { all: () => [] } as any;
  const conversations = { append: async () => {} } as any;
  const projects = {} as any;
  const fence = { assertWritable() {} } as any;
  return new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    projects, null as any, null as any, null as any, null as any,
    brain, fence, null as any, registry, null as any,
  );
}

// add(input, opts) 캡처 스텁
function fakeScheduler() {
  const adds: Array<{ input: any; opts: any }> = [];
  return {
    adds,
    add(input: any, opts?: any) { adds.push({ input, opts }); return { id: 'r1', ...input, createdAt: 't' }; },
    list() { return []; },
    remove() { return true; },
  };
}

// 승인까지 진행시키는 공통 준비(코딩 제안→승인). codeRun 결과만 바꿔가며 재사용.
async function approveWith(o: any, status: string, posts: string[]) {
  o.resolveRepoPaths = () => ['C:/repos/api'];
  o.proposeProject = async () => ({ id: 'p1', acceptanceCriteria: ['x'], gate: { test: false, build: false, typecheck: false } });
  o.approveProject = async () => {};
  o.codeRun = async () => ({ status, sessionId: 's1' });
  await o.handleMention({ text: 'api에 g', userId: 'c1' }, async () => {});
  await o.handleMention({ text: '승인', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.drainForTest();
}

it('STUCK → once 재개예약(internal, resume p1 1) + ⏸ 게시', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await approveWith(o as any, 'STUCK', posts);
  expect(sch.adds).toHaveLength(1);
  expect(sch.adds[0].input).toMatchObject({ channelId: 'c1', task: 'resume p1 1', once: true });
  expect(sch.adds[0].opts).toEqual({ internal: true });
  const msg = posts.find((p) => p.includes('⏸'));
  expect(msg).toContain('재개 1/2');
  expect(msg).toContain('예약취소 r1');
});

it('BUDGET → 재개예약(사유 문구=예산)', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await approveWith(o as any, 'BUDGET', posts);
  expect(sch.adds[0].input.task).toBe('resume p1 1');
  expect(posts.find((p) => p.includes('⏸'))).toContain('예산');
});

it('SUCCESS → 재예약 없음', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await approveWith(o as any, 'SUCCESS', posts);
  expect(sch.adds).toHaveLength(0);
});

it('STOPPED(사용자 정지) → 재예약 없음, 기존 ⚠️', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await approveWith(o as any, 'STOPPED', posts);
  expect(sch.adds).toHaveLength(0);
  expect(posts.some((p) => p.includes('⚠️'))).toBe(true);
});

it('scheduler 미주입 STUCK → 기존 ⚠️ 메시지로 강등', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  const posts: string[] = [];
  await approveWith(o as any, 'STUCK', posts);
  expect(posts.some((p) => p.includes('⚠️'))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/agent-layer/orchestrator-resume.spec.ts --silent`
Expected: FAIL — STUCK/BUDGET 테스트에서 `sch.adds`가 비어 있음(현재는 재예약 분기 없음). SUCCESS/STOPPED/미주입 3개는 PASS일 수 있음(정상).

- [ ] **Step 3: Write minimal implementation**

`src/agent-layer/orchestrator.ts`:

(a) import 추가(기존 schedule-store import 근처):

```ts
import { computeResume } from './resume-policy';
```

(b) `launchCoding` 시그니처에 `attempt = 0` 추가, codeRun 결과 처리에 분기 삽입 — 기존 본문에서 바뀌는 부분만:

```ts
  private launchCoding(projectId: string, targetPath: string, threadKey: string, post: (text: string) => Promise<void>, attempt = 0): void {
    const t = this.tracker.start(threadKey, { question: `코딩: ${targetPath}`, team: ['Coder'] });
    const work: Promise<void> = (async (): Promise<void> => {
      try {
        await post('자율 코딩 시작할게요. 진행은 여기 올릴게요.');
        const r = await this.codeRun(projectId, { onProgress: (m) => { void post(`· ${m}`); } });
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
```

(c) 신규 private 메서드(launchCoding 아래):

```ts
  // 자가 재개 예약(6b-3-2). 성공 시 ⏸ 안내 게시까지 하고 true, 실패(미주입·add null)면 false → 기존 메시지 강등.
  // channelId=threadKey: Discord에서 스레드는 자체 channelId라 threadKey가 곧 게시 대상(6b-1 수렴).
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/agent-layer/orchestrator-resume.spec.ts src/agent-layer/orchestrator-coding.spec.ts --silent`
Expected: PASS 전부 — 특히 기존 orchestrator-coding.spec의 `codeRun STUCK → 경고 메시지`(scheduler 미주입이라 ⚠️ 강등 경로)가 그대로 초록.

- [ ] **Step 5: Commit**

```powershell
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator-resume.spec.ts
git commit -m "feat(phase6b3-2): launchCoding 자가 재개예약 — STUCK/BUDGET→once(resume) 상한2회, 미주입은 기존 메시지 강등"
```

---

### Task 4: `resume <projectId> [attempt]` escape hatch

**Files:**
- Modify: `src/agent-layer/orchestrator.ts` (handleMention hatch + resumeCoding 신설)
- Test: `src/agent-layer/orchestrator-resume.spec.ts` (테스트 추가)

**Interfaces:**
- Consumes: Task 3 `launchCoding(..., attempt)` · 기존 `this.projects.get(id)`(ProjectConfig: `{ id, targetPath, approved, ... }`) · 기존 `setRunState('running')`.
- Produces: handleMention이 `resume <projectId> [attempt]` 텍스트(예약 발사 재주입 또는 사용자 직접 입력)를 받으면 무승인 재개. 예약 task 형식과 짝.

- [ ] **Step 1: Write the failing test**

`src/agent-layer/orchestrator-resume.spec.ts`에 추가:

```ts
it('resume hatch: 승인된 프로젝트 → runState 복원 + launchCoding(attempt 전달)', async () => {
  const o = orc('{"kind":"chat","team":[]}') as any;
  o.projects = { get: async (id: string) => ({ id, targetPath: 'C:/repos/api', approved: true }) };
  const seen: any = {};
  o.launchCoding = (projectId: string, targetPath: string, _tk: string, _post: any, attempt: number) => {
    seen.projectId = projectId; seen.targetPath = targetPath; seen.attempt = attempt;
  };
  o.setRunState('paused'); // STUCK이 남긴 상태 재현
  const posts: string[] = [];
  await o.handleMention({ text: 'resume p1 1', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(o.getRunState()).toBe('running');
  expect(seen).toEqual({ projectId: 'p1', targetPath: 'C:/repos/api', attempt: 1 });
  expect(posts[0]).toContain('이어서');
});

it('resume hatch: 프로젝트 없음 → 안내', async () => {
  const o = orc('{"kind":"chat","team":[]}') as any;
  o.projects = { get: async () => null };
  const posts: string[] = [];
  await o.handleMention({ text: 'resume nope 1', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(posts[0]).toContain('못 찾');
});

it('resume hatch: 미승인 프로젝트 → 안내', async () => {
  const o = orc('{"kind":"chat","team":[]}') as any;
  o.projects = { get: async () => ({ id: 'p1', targetPath: 'C:/x', approved: false }) };
  const posts: string[] = [];
  await o.handleMention({ text: 'resume p1', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(posts[0]).toContain('승인되지 않');
});

it('resume hatch: attempt 비숫자/생략 → 0', async () => {
  const o = orc('{"kind":"chat","team":[]}') as any;
  o.projects = { get: async () => ({ id: 'p1', targetPath: 'C:/x', approved: true }) };
  const seen: any = {};
  o.launchCoding = (_p: string, _t: string, _tk: string, _post: any, attempt: number) => { seen.attempt = attempt; };
  await o.handleMention({ text: 'resume p1', userId: 'c1' }, async () => {});
  expect(seen.attempt).toBe(0);
});

it('재개 상한: resume attempt 2로 또 STUCK → 재예약 없음 + 사람 호출', async () => {
  const o = orc('{"kind":"chat","team":[]}') as any;
  o.projects = { get: async () => ({ id: 'p1', targetPath: 'C:/repos/api', approved: true }) };
  o.codeRun = async () => ({ status: 'STUCK', sessionId: 's1' }); // launchCoding은 실물 사용
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await o.handleMention({ text: 'resume p1 2', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.drainForTest();
  expect(sch.adds).toHaveLength(0);
  expect(posts.some((p) => p.includes('사람이 봐야'))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/agent-layer/orchestrator-resume.spec.ts --silent`
Expected: FAIL — 신규 4개가 실패(`resume ...`이 hatch 없이 classify(chat)로 흘러 posts가 기대와 다름)

- [ ] **Step 3: Write minimal implementation**

`src/agent-layer/orchestrator.ts` — handleMention의 `schedule ` hatch 블록 바로 다음에 삽입:

```ts
    // 자가 재개(6b-3-2): 예약 발사 재주입용 내부 명령(사용자 직접 입력도 동작 — 승인된 프로젝트 재실행뿐).
    if (trimmed.startsWith('resume ')) {
      const parts = trimmed.slice('resume '.length).trim().split(/\s+/);
      const attempt = /^\d+$/.test(parts[1] ?? '') ? parseInt(parts[1], 10) : 0;
      await this.resumeCoding(parts[0] ?? '', attempt, threadKey, post);
      return;
    }
```

신규 private 메서드(scheduleCodingResume 아래):

```ts
  // 예약된 코딩 재개 실행: 존재·승인 확인 → runState 복원(STUCK이 남긴 paused) → 백그라운드 재실행.
  private async resumeCoding(projectId: string, attempt: number, threadKey: string, post: (text: string) => Promise<void>): Promise<void> {
    if (!this.projects) { await post('코딩 기능이 준비되지 않았어요.'); return; }
    const project = await this.projects.get(projectId);
    if (!project) { await post('그 프로젝트를 못 찾았어요.'); return; }
    if (!project.approved) { await post('승인되지 않은 프로젝트예요.'); return; }
    this.setRunState('running');
    await post(`▶ 이어서 할게요: ${project.targetPath} (재개 ${attempt}/2)`);
    this.launchCoding(projectId, project.targetPath, threadKey, post, attempt);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/agent-layer/orchestrator-resume.spec.ts src/agent-layer/orchestrator-handle-mention.spec.ts src/agent-layer/orchestrator-coding.spec.ts src/agent-layer/orchestrator-schedule.spec.ts --silent`
Expected: PASS 전부(hatch 순서 변경으로 인한 회귀 0)

- [ ] **Step 5: Commit**

```powershell
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator-resume.spec.ts
git commit -m "feat(phase6b3-2): resume hatch — 예약 발사가 승인된 프로젝트를 무승인 재개(runState 복원)"
```

---

### Task 5: 협업 실패 재시도 — `launchCollaboration` attempt + `retry` hatch

**Files:**
- Modify: `src/agent-layer/orchestrator.ts` (launchCollaboration catch 분기 + scheduleCollabRetry 신설 + retry hatch)
- Test: `src/agent-layer/orchestrator-resume.spec.ts` (테스트 추가)

**Interfaces:**
- Consumes: Task 1 `computeResume('COLLAB', now)` · Task 2 `scheduler.add(input, { internal: true })` · 기존 `this.collaborate`.
- Produces: `private launchCollaboration(question, team, userId, threadKey, post, attempt = 0): void` · handleMention `retry <attempt> <팀CSV> <질문>` hatch(형식 불일치면 일반 흐름으로 통과). 예약 task 형식 `retry <attempt+1> <팀CSV> <질문>`.

- [ ] **Step 1: Write the failing test**

`src/agent-layer/orchestrator-resume.spec.ts`에 추가:

```ts
it('협업 실패 → once 재시도예약(retry 1 <팀> <질문>) + ⏸ 게시', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager"]}') as any;
  o.collaborate = async () => { throw new Error('boom'); };
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await o.handleMention({ text: '서버비 정리해줘', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.drainForTest();
  expect(sch.adds).toHaveLength(1);
  expect(sch.adds[0].input).toMatchObject({ channelId: 'c1', task: 'retry 1 Manager 서버비 정리해줘', once: true });
  expect(sch.adds[0].opts).toEqual({ internal: true });
  const msg = posts.find((p) => p.includes('⏸'));
  expect(msg).toContain('재시도 1/2');
});

it('retry hatch: 파싱 → launchCollaboration(팀·attempt 전달)', async () => {
  const o = orc('{"kind":"chat","team":[]}') as any;
  const seen: any = {};
  o.launchCollaboration = (q: string, team: string[], _u: string, _tk: string, _post: any, attempt: number) => {
    seen.q = q; seen.team = team; seen.attempt = attempt;
  };
  await o.handleMention({ text: 'retry 1 Manager,Dev 서버비 정리해줘', userId: 'c1' }, async () => {});
  expect(seen).toEqual({ q: '서버비 정리해줘', team: ['Manager', 'Dev'], attempt: 1 });
});

it('retry 상한: attempt 2로 또 실패 → 재예약 없음 + 사람 호출', async () => {
  const o = orc('{"kind":"chat","team":[]}') as any;
  o.collaborate = async () => { throw new Error('boom'); };
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await o.handleMention({ text: 'retry 2 Manager 서버비 정리해줘', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.drainForTest();
  expect(sch.adds).toHaveLength(0);
  expect(posts.some((p) => p.includes('사람이 봐야'))).toBe(true);
});

it('retry 형식 불일치(attempt 비숫자) → hatch 미적용, 일반 흐름(chat)', async () => {
  const o = orc('{"kind":"chat","team":[]}') as any;
  o.route = async () => '네';
  const posts: string[] = [];
  await o.handleMention({ text: 'retry me later', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(posts).toEqual(['네']);
});

it('scheduler 미주입 협업 실패 → 기존 실패 메시지(회귀)', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager"]}') as any;
  o.collaborate = async () => { throw new Error('boom'); };
  const posts: string[] = [];
  await o.handleMention({ text: '서버비 정리해줘', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.drainForTest();
  expect(posts.some((p) => p.includes('문제가 생겼어요'))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/agent-layer/orchestrator-resume.spec.ts --silent`
Expected: FAIL — 재시도예약·retry hatch·상한 3개 실패(현재 catch는 재예약 없음, hatch 없음). 형식 불일치·미주입 회귀 2개는 PASS일 수 있음.

- [ ] **Step 3: Write minimal implementation**

`src/agent-layer/orchestrator.ts`:

(a) `launchCollaboration` 시그니처에 `attempt = 0` 추가, catch 분기 교체:

```ts
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
        const result = await this.collaborate(question, team, userId);
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
```

(b) 신규 private 메서드(resumeCoding 아래):

```ts
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
```

(c) handleMention의 `resume ` hatch 바로 다음에 retry hatch 삽입:

```ts
    // 협업 재시도 재주입(6b-3-2). 형식: retry <attempt> <팀CSV> <질문> — 불일치면 일반 흐름으로.
    if (trimmed.startsWith('retry ')) {
      const m = trimmed.match(/^retry (\d+) (\S+) ([\s\S]+)$/);
      if (m) {
        const attempt = parseInt(m[1], 10);
        const team = m[2].split(',').map((s) => s.trim()).filter(Boolean);
        await post(`팀 구성: ${team.join('·')} — 다시 해볼게요 (재시도 ${attempt}/2)`);
        this.launchCollaboration(m[3], team.length ? team : ['Manager'], msg.userId, threadKey, post, attempt);
        return;
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/agent-layer/orchestrator-resume.spec.ts src/agent-layer/orchestrator-handle-mention.spec.ts --silent`
Expected: PASS 전부(기존 협업 실패 메시지 테스트 포함 회귀 0)

- [ ] **Step 5: Commit**

```powershell
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator-resume.spec.ts
git commit -m "feat(phase6b3-2): 협업 실패 자가 재시도 — once(retry) 예약·retry hatch·상한2회"
```

---

### Task 6: 전체 검증(통합)

**Files:**
- 없음(검증만). 실패 시 해당 태스크로 돌아가 수정.

**Interfaces:**
- Consumes: Task 1~5 전부.
- Produces: 전체 스위트 초록 + 타입 클린 + 빌드 클린.

- [ ] **Step 1: 전체 테스트**

Run: `npm test -- --silent`
Expected: 0 fail (기존 378 pass + 신규 ~23, 2 skip은 opt-in 임베더)

- [ ] **Step 2: 타입체크·빌드**

Run: `npx tsc --noEmit; npm run build`
Expected: 에러 0

- [ ] **Step 3: 잔여 확인**

`git status --short`로 미커밋 잔여물 없는지 확인(스펙·플랜 문서는 이미 커밋됨). 남은 게 있으면 해당 태스크 커밋에 포함했어야 할 파일인지 점검 후 커밋.
