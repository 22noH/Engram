# Phase 10b — 복원력(EADDRINUSE 불사 · 로그 · restart-survival) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 상주가 죽지 않게 하고(포트 점유 시 채팅만 비활성), 로그가 실제로 남게 하고, 앱을 닫았다 켜도 진행 중이던 코딩 작업이 부팅 시 이어지게 한다.

**Architecture:** 세 갈래의 독립 수정. (1) SelfMessenger의 WebSocketServer에 `error` 리스너를 달아 EADDRINUSE가 프로세스를 죽이지 않게(근본원인: ws가 http 서버 error를 wss `error`로 재방출하는데 리스너가 없어 uncaught throw). (2) PinoLogger 파일 경로/flush 진단·수정. (3) restart-survival: 코딩 TaskRecord에 `channelId`를 영속하고, TaskStore에 `list()`를 추가하고, 부팅 시 RUNNING 코딩 레코드를 스캔해 기존 `resume <projectId>` hatch로 재주입(게이트·완성조건은 재실행 시 재평가, findings는 위키 보존).

**Tech Stack:** TypeScript, NestJS, ws, pino, Jest.

## Global Constraints

- 새 npm 의존성 0.
- restart-survival 범위 = **코딩 작업만**(장시간·중단 손실이 큰 유일 대상). 협업(collaborate)은 분 단위라 비범위 — ponytail 주석으로 천장 명시.
- 재개는 이미 **승인된(approved)** 프로젝트만(무승인 실행 금지 — 기존 `resume` hatch 불변).
- N=1 가정(전역 runState) 유지 — 동시 다중 코딩 재개는 비범위.
- 셸 PowerShell. 테스트: `npx jest <spec경로>`.

---

### Task 1: SelfMessenger — WebSocketServer error 격리(EADDRINUSE 크래시 차단)

**Files:**
- Modify: `src/edge/messenger/self.adapter.ts`
- Test: `src/edge/messenger/self.adapter.spec.ts`

**근본원인:** `new WebSocketServer({ server })`는 http 서버의 `error`를 wss의 `error` 이벤트로 재방출한다. 현재 `start()`는 http 서버의 `once('error', reject)`만 걸어(리슨 실패는 promise reject로 잡히지만) wss에는 `error` 리스너가 없다. 포트 점유 시 wss가 `error`를 방출하는데 리스너가 없으면 Node가 그 error를 **던져(uncaught)** 상주 전체가 죽는다. main.ts의 `try/catch`는 promise만 잡고 EventEmitter throw는 못 잡는다.

**Interfaces:**
- Consumes: 없음.
- Produces: `start()`가 wss `error`를 로거로 흡수 → 포트 점유 시 `start()` promise만 reject(main.ts가 잡아 채팅 비활성), 상주는 생존.

- [ ] **Step 1: 실패 테스트 작성** — `self.adapter.spec.ts`에 추가

```ts
it('포트가 이미 점유돼도 상주를 죽이지 않는다(두 번째 start는 reject만)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-'));
  const store = new ChatStore(dir);
  const logs: string[] = [];
  const log = { warn: (m: string) => logs.push(m) };
  const a = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1' }, store, { logger: log });
  await a.start();
  const port = a.addressPort();
  const b = new SelfMessenger({ enabled: true, port, bind: '127.0.0.1' }, store, { logger: log });
  // 두 번째는 EADDRINUSE로 reject 되어야 하고, uncaught로 프로세스를 죽이면 안 된다.
  await expect(b.start()).rejects.toBeDefined();
  await a.stop();
  await b.stop();
});
```

> 이 테스트는 uncaught throw 시 Jest가 프로세스 크래시로 실패한다(회귀 감지). `unhandledRejection`이 아닌 EventEmitter throw라 현재 코드는 여기서 죽는다.

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts -t "포트가 이미 점유"`
Expected: FAIL (uncaught error / 프로세스 이상 종료).

- [ ] **Step 3: 구현** — `self.adapter.ts` `start()`의 wss 생성 직후에 error 리스너 추가:

```ts
this.wss = new WebSocketServer({ server: this.server });
// ws는 http 서버의 error를 wss 'error'로 재방출한다. 리스너가 없으면 Node가 throw해 상주가 죽는다
// (특히 EADDRINUSE). 여기서 흡수 → start()의 promise reject만 남고 상주는 생존(채팅만 비활성).
this.wss.on('error', (err) => {
  this.opts.logger.warn(`웹소켓 서버 오류(채팅 비활성 가능): ${String(err)}`, 'SelfChat');
});
this.wss.on('connection', (ws) => {
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: PASS(전체).

- [ ] **Step 5: 커밋**

```bash
git add src/edge/messenger/self.adapter.ts src/edge/messenger/self.adapter.spec.ts
git commit -m "fix(phase10b): SelfMessenger wss error 격리 — 포트 점유 시 상주 불사(채팅만 비활성)"
```

---

### Task 2: 상주 로그 미기록 진단·수정

**Files:**
- Read: `src/pal/logger.ts`
- Modify: (진단 결과에 따라) `src/pal/logger.ts` 또는 배선부
- Test: `src/pal/logger.spec.ts`

**증상(메모리):** 설치앱 상주가 `%APPDATA%\engram\logs\engram.log`에 안 남기는 정황(마지막 줄이 계속 진단 pid).

- [ ] **Step 1: 진단(코드 조사)**

확인 항목:
1. `PinoLogger`가 쓰는 파일 경로가 `PathResolver.getDataDir()`/`logs/engram.log`와 일치하는가? (desktop main.ts는 `ENGRAM_DATA_DIR`를 자식 env로 주입 — PathResolver가 이 env를 읽는지 확인.)
2. pino 대상이 `sync: true`인가? utilityProcess(stdio:'ignore')에서 비동기 flush가 종료 시 유실될 수 있음.
3. 상주가 실제로 그 경로에 쓰기 권한이 있는가(폴더 생성 여부)?
4. **좀비 상주 가능성**: 부팅 시 켜진 옛 상주가 파일을 물고 있고, 새 상주는 EADDRINUSE로 밀렸던 것(Task 1이 이걸 완화). Task 1 적용 후 재현되는지 재확인.

`src/pal/logger.ts`와 `src/pal/path-resolver.ts`(getDataDir/getLogs 경로), `src/main.ts` 부팅 로그 호출을 읽어 경로가 일관되는지 대조.

- [ ] **Step 2: 실패/회귀 테스트 작성** — 원인에 맞춰. 예: 경로가 env를 안 따르는 경우

```ts
it('PinoLogger가 ENGRAM_DATA_DIR 하위 logs/engram.log에 쓴다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-log-'));
  const logger = makeLoggerFor(dir); // logger.ts의 팩토리/생성자에 맞춰 조립
  logger.log('hello-engram', 'Test');
  await new Promise((r) => setTimeout(r, 50)); // sync면 불필요
  const text = fs.readFileSync(path.join(dir, 'logs', 'engram.log'), 'utf8');
  expect(text).toContain('hello-engram');
});
```

> 조립 방식은 `logger.spec.ts` 기존 테스트를 따른다. 이미 이 동작을 커버하고 통과 중이면(경로가 옳으면) 원인은 **좀비 상주**이므로 Task 2는 "Task 1으로 해소됨"으로 마무리하고 아래 Step 3~4를 문서 커밋으로 대체.

- [ ] **Step 3: 수정(원인별)**

- 경로 불일치면: logger가 `PathResolver`(env 반영)를 통해 경로를 얻도록 배선 수정.
- flush 유실이면: pino 대상 `sync: true` 확인/설정.
- 좀비 상주면: 코드 변경 없음 — Task 1이 새 상주의 EADDRINUSE 생존을 보장하고, 옛 상주는 `restartChild`/watchdog으로 교체됨. 이 경우 README/메모리에 "설치본 상주 종료 후 재설치" 절차만 확인.

- [ ] **Step 4: 통과 확인 + 커밋**

Run: `npx jest src/pal/logger.spec.ts`

```bash
git add src/pal/logger.ts src/pal/logger.spec.ts   # (수정이 있었다면)
git commit -m "fix(phase10b): 상주 로그 경로/flush 정합(또는 좀비 상주 원인 확인)"
```

> 진단 결과가 "코드 무죄(좀비 상주)"면 커밋은 스펙/메모리 갱신만. 그 경우 이 태스크는 코드 변경 없이 종료.

---

### Task 3: TaskStore — list() + 코딩 레코드에 channelId 영속

**Files:**
- Modify: `src/knowledge-core/task-store.ts`
- Test: `src/knowledge-core/task-store.spec.ts`

**Interfaces:**
- Consumes: 없음.
- Produces:
  - `TaskRecord`에 `channelId?: string`.
  - `createCoding(input)`가 `channelId?: string`를 받아 저장.
  - `list(): Promise<TaskRecord[]>` — stateDir의 `*.json`을 읽어 유효 레코드만 반환(손상/비레코드 skip).

- [ ] **Step 1: 실패 테스트 작성** — `task-store.spec.ts`에 추가

```ts
it('createCoding이 channelId를 저장하고 list가 반환한다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskstore-'));
  const store = new TaskStore(dir, new KeyedLock());
  const rec = await store.createCoding({ question: 'q', projectRef: 'p1', criteriaTotal: 2, channelId: 'chan-1' });
  expect(rec.channelId).toBe('chan-1');
  const all = await store.list();
  expect(all.some((r) => r.id === rec.id && r.channelId === 'chan-1')).toBe(true);
});

it('list는 손상 파일을 건너뛴다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskstore-'));
  const store = new TaskStore(dir, new KeyedLock());
  await store.createCoding({ question: 'q', projectRef: 'p1', criteriaTotal: 1 });
  fs.writeFileSync(path.join(dir, 'junk.json'), '{ not json');
  const all = await store.list();
  expect(all.length).toBe(1);
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/knowledge-core/task-store.spec.ts`
Expected: FAIL (`channelId` 미저장 / `list` 없음).

- [ ] **Step 3: 구현** — `task-store.ts`

`TaskRecord`에 필드 추가:

```ts
export interface TaskRecord {
  // ... 기존 ...
  progress?: TaskProgress;
  channelId?: string; // Phase 10b: 재시작 재개 시 진행을 게시할 채널(코딩 작업).
}
```

`createCoding` 시그니처·본문 수정:

```ts
async createCoding(input: { question: string; projectRef: string; criteriaTotal: number; channelId?: string }): Promise<TaskRecord> {
  const now = new Date().toISOString();
  const id = `task_${now.replace(/[:.]/g, '-')}_${(this.seq++).toString(36)}_code`;
  const rec: TaskRecord = {
    id, kind: 'coding', status: 'PENDING', question: input.question,
    assignees: [], blackboard: {}, result: null, createdAt: now, updatedAt: now,
    projectRef: input.projectRef, tickets: [],
    progress: { landed: 0, criteriaMet: 0, criteriaTotal: input.criteriaTotal },
    ...(input.channelId ? { channelId: input.channelId } : {}),
  };
  await this.lock.run(rec.id, () => this.write(rec));
  return rec;
}
```

`remove` 아래에 `list` 추가:

```ts
// 전체 레코드 스캔(재시작 재개용). 손상/비레코드 파일은 skip.
async list(): Promise<TaskRecord[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(this.stateDir);
  } catch {
    return []; // 디렉토리 없음 = 작업 없음
  }
  const out: TaskRecord[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const raw = await fs.promises.readFile(path.join(this.stateDir, n), 'utf8');
      const rec = JSON.parse(raw) as TaskRecord;
      if (rec && typeof rec.id === 'string' && typeof rec.status === 'string') out.push(rec);
    } catch { /* 손상 skip */ }
  }
  return out;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/knowledge-core/task-store.spec.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/knowledge-core/task-store.ts src/knowledge-core/task-store.spec.ts
git commit -m "feat(phase10b): TaskStore.list() + 코딩 레코드 channelId 영속(재시작 재개 토대)"
```

---

### Task 4: Orchestrator — codeRun이 channelId 저장 + 부팅 재개 진입점

**Files:**
- Modify: `src/agent-layer/orchestrator.ts`
- Test: `src/agent-layer/orchestrator-resume.spec.ts` (또는 새 `orchestrator-restart.spec.ts`)

**Interfaces:**
- Consumes: `TaskStore.list`/`createCoding(channelId)` (Task 3), 기존 `handleMention`·`resume` hatch.
- Produces:
  - `codeRun(projectId, opts)` opts에 `channelId?: string` — `createCoding`에 전달.
  - `launchCoding`이 `threadKey`를 `codeRun`의 `channelId`로 넘김.
  - `resumeInterrupted(post: (channelId: string, text: string) => Promise<void>): Promise<number>` — RUNNING 코딩 레코드를 스캔해 각각 `resume <projectRef>`를 그 channelId로 재주입, 처리한 스테일 레코드 제거. 재개한 개수 반환.

- [ ] **Step 1: 실패 테스트 작성** — 새 `src/agent-layer/orchestrator-restart.spec.ts`

```ts
it('resumeInterrupted가 RUNNING 코딩 레코드를 채널로 재개하고 스테일 레코드를 지운다', async () => {
  const orch = makeOrchestrator(); // projects(approved p1)+tasks 주입
  // RUNNING 코딩 레코드 하나 심기
  const rec = await tasks.createCoding({ question: 'q', projectRef: 'p1', criteriaTotal: 1, channelId: 'chan-1' });
  await tasks.transition(rec.id, 'RUNNING');
  const spyHandle = jest.spyOn(orch, 'handleMention').mockResolvedValue(undefined);
  const spyRemove = jest.spyOn(tasks, 'remove');
  const posts: Array<[string, string]> = [];
  const n = await orch.resumeInterrupted(async (ch, t) => { posts.push([ch, t]); });
  expect(n).toBe(1);
  expect(spyHandle).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'resume p1', userId: 'chan-1' }),
    expect.any(Function),
    'chan-1',
  );
  expect(spyRemove).toHaveBeenCalledWith(rec.id);
});

it('channelId 없는 레코드는 재개하지 않는다(게시 대상 불명)', async () => {
  const orch = makeOrchestrator();
  const rec = await tasks.createCoding({ question: 'q', projectRef: 'p1', criteriaTotal: 1 });
  await tasks.transition(rec.id, 'RUNNING');
  const n = await orch.resumeInterrupted(async () => {});
  expect(n).toBe(0);
});

it('RUNNING이 아니거나 코딩이 아닌 레코드는 무시', async () => {
  const orch = makeOrchestrator();
  await tasks.createCoding({ question: 'q', projectRef: 'p1', criteriaTotal: 1, channelId: 'c' }); // PENDING
  const n = await orch.resumeInterrupted(async () => {});
  expect(n).toBe(0);
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/agent-layer/orchestrator-restart.spec.ts`
Expected: FAIL (`resumeInterrupted` 없음).

- [ ] **Step 3: 구현** — `orchestrator.ts`

`codeRun` opts 타입에 `channelId?` 추가하고 `createCoding` 호출에 전달:

```ts
async codeRun(
  projectId: string,
  opts: { maxRounds?: number; stuckK?: number; onChunk?: (t: string) => void; onProgress?: (m: string) => void; channelId?: string } = {},
): Promise<{ status: 'SUCCESS' | 'STUCK' | 'STOPPED' | 'BUDGET'; sessionId: string }> {
  // ...
  const session = await this.tasks!.createCoding({
    question: project.acceptanceCriteria.join(' / '), projectRef: projectId,
    criteriaTotal: project.acceptanceCriteria.length,
    ...(opts.channelId ? { channelId: opts.channelId } : {}),
  });
```

`launchCoding`이 threadKey를 channelId로 넘기게(codeRun 호출부):

```ts
const r = await this.codeRun(projectId, { channelId: threadKey, onProgress: (m) => { void post(`· ${m}`); } });
```

새 메서드 추가(예: `resumeCoding` 근처):

```ts
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
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/agent-layer/orchestrator-restart.spec.ts src/agent-layer/orchestrator-coderun.spec.ts`
Expected: PASS(coderun 회귀 없음).

- [ ] **Step 5: 커밋**

```bash
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator-restart.spec.ts
git commit -m "feat(phase10b): codeRun channelId 영속 + resumeInterrupted 부팅 재개 진입점"
```

---

### Task 5: 상주 부팅에서 재개 배선(main.ts)

**Files:**
- Modify: `src/main.ts`
- Test: 없음(부트스트랩 결선 — Task 4가 로직을 커버, 수동 스모크).

**Interfaces:**
- Consumes: `orchestrator.resumeInterrupted`(Task 4), `poster.postToChannel`(기존 ChannelPoster/MessengerHub).
- Produces: 메신저 기동 직후 중단된 코딩 작업을 채널로 재개.

- [ ] **Step 1: 구현** — `main.ts` `bootstrap()`에서 `poster` 구성 이후(스케줄러 start 근처)에 추가:

```ts
// 재시작 생존(Phase 10b): 중단된 코딩 작업을 부팅 시 이어서. 게시는 poster(재시작 후엔 라이브 reply 핸들 없음).
// 실패는 상주를 죽이지 않는다.
try {
  const resumed = await orchestrator.resumeInterrupted((channelId, text) => poster.postToChannel(channelId, text));
  if (resumed > 0) logger.log(`중단된 코딩 ${resumed}건 재개`, 'Restart');
} catch (e) {
  logger.warn(`재시작 재개 실패: ${String(e)}`, 'Restart');
}
```

> 위치: `poster`가 정의된 뒤(라인 64~65 이후), `scheduler.start()` 전후 어디든. `ports.length === 0`이면 `poster`가 없으니(early return 위) 이 블록은 메신저가 하나라도 있을 때만 실행됨 — 재개 게시 대상이 있어야 의미 있음. OK.

- [ ] **Step 2: 빌드 확인**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 에러 없음.

- [ ] **Step 3: 수동 스모크(선택, 실 claude 필요)**

1. Code 채널에서 오래 걸릴 코딩 위임 → 승인 → 진행 중(RUNNING) 상태 확인(`runtime/state/*_code.json`에 `channelId` 있는지).
2. 상주 종료(트레이 종료) → 재시작.
3. 부팅 로그에 `중단된 코딩 N건 재개` + 해당 채널에 `▶ 이어서 할게요` 게시 확인.

- [ ] **Step 4: 커밋**

```bash
git add src/main.ts
git commit -m "feat(phase10b): 상주 부팅 시 중단된 코딩 작업 재개 배선(poster 게시)"
```

---

## Self-Review

- **스펙 커버리지(§백엔드 잔여 버그)**: "restart-survival"(Task 3·4·5) / "상주 EADDRINUSE 크래시"(Task 1) / "상주 로그 미기록 의심"(Task 2). ⟶ 전부 태스크 있음.
- **범위 결정(설계 공백 해소)**: 스펙은 "부팅 시 RUNNING 재개"만 명시하고 *어디로 게시할지*를 정하지 않았다. 이 플랜은 **코딩 레코드에 channelId를 영속**(Task 3)하고 **poster로 게시**(Task 5)해 해소한다. 협업 재개는 비범위(분 단위, 손실 작음) — Task 4 주석에 명시.
- **타입 일관성**: `channelId?: string`(TaskRecord·createCoding·codeRun opts)·`list(): Promise<TaskRecord[]>`·`resumeInterrupted(post)` 시그니처가 Task 3→4→5 동일. 재개는 기존 `resume <projectId>` hatch를 재사용(중복 로직 0).
- **플레이스홀더 스캔**: 각 코드 스텝 실코드. `makeOrchestrator`/`tasks` 테스트 조립은 "기존 spec 관례를 따르라" 명시(orchestrator-resume.spec.ts·orchestrator-coderun.spec.ts 참고).
- **주의(N=1)**: `resume` hatch가 전역 `setRunState('running')`을 부른다 — 동시 여러 코딩이 있으면 pause된 다른 작업까지 풀 수 있음(기존 알려진 천장, orchestrator.ts:409 주석). N=1 전제 유지.

## Execution Handoff

플랜 완료·저장: `docs/superpowers/plans/2026-07-04-phase10b-resilience.md`. Task 1(EADDRINUSE)은 독립·고효과라 먼저 착수 권장. 실행은 subagent-driven-development 권장.
