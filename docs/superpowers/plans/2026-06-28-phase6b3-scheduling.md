# Phase 6b-3-1 — `@Engram` 사용자 예약(스케줄) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@Engram 매일 9시에 X 해줘` → 예약을 영속 저장하고 그 시간마다 저장된 일을 자동 수행해 채널에 게시(재시작 생존). 예약 목록/취소 포함.

**Architecture:** `MessengerPort`에 채널ID 게시 `postToChannel`을 더하고, 영속 `ScheduleStore`(schedules.json) + plain `ScheduleService`(cron 등록·발사, main.ts 결선)를 둔다. 발사 시 저장된 자연어 task를 6b-1 `handleMention`으로 재주입해 채널에 게시. Orchestrator는 `schedule` 의도를 setter-주입된 `SchedulerPort`에 위임. 기존 `MeetingScheduler` 동적 cron 패턴 재사용.

**Tech Stack:** Node 22 · NestJS · TypeScript · jest(ts-jest) · `cron`(기존 dep) · `@nestjs/schedule`(기존)

## Global Constraints

- 새 의존성 0(`cron`·`@nestjs/schedule` 기존).
- 코어 중립성: `CoreMessage`·bridge·`codeRun`·`collaborate`·`MentionTracker` 무변경. 메신저는 DI 밖 유지(main.ts 결선).
- 상주 불사: 잘못된 cron→등록 안 함·안내. 발사의 handleMention은 6b-1 백그라운드 try/catch + `.catch` 로그. postToChannel 실패→로그. schedules.json 깨짐→빈. 부팅 register 개별 실패→그 엔트리만 스킵.
- 막다른 길 없음: scheduler 미주입(CLI/테스트)→예약 분기 안내 후 반환.
- `PinoLogger`는 `info()` 없음(log/warn/error).
- 재주입 task가 예약어를 품어도 6b3-1은 무시(ponytail 주석).
- 결정론 테스트: 실 네트워크/claude/cron타이머 금지. ScheduleService는 fake registry + job 생성 seam(`makeJob`)으로 실타이머 회피, `fire`는 직접 호출.

---

## File Structure

- 수정 `src/edge/messenger/messenger.port.ts` — `postToChannel` 시그니처.
- 수정 `src/edge/messenger/fake-messenger.ts` — 구현 + `channelPosts` 캡처.
- 수정 `src/edge/messenger/discord.adapter.ts` — 구현(채널 fetch→send, 스모크).
- 신규 `src/agent-layer/schedule-store.ts`(+spec) — `ScheduleEntry`·`SchedulerPort`·`ScheduleStore`(영속).
- 신규 `src/edge/schedule-service.ts`(+spec) — `ScheduleService`(SchedulerPort 구현, cron 등록·발사).
- 수정 `src/agent-layer/orchestrator.ts` — classify `schedule`·handleMention 예약 분기·`doSchedule`/`formatSchedules`·`setScheduler`.
- 신규 `src/agent-layer/orchestrator-schedule.spec.ts`.
- 수정 `src/main.ts` — ScheduleStore/Service 결선.
- 수정 `prompts/triage.md` — schedule 의도.

---

## Task 1: postToChannel 포트 메서드

**Files:**
- Modify: `src/edge/messenger/messenger.port.ts`, `src/edge/messenger/fake-messenger.ts`, `src/edge/messenger/discord.adapter.ts`
- Test: `src/edge/messenger/fake-messenger.spec.ts` (추가)

**Interfaces:**
- Produces: `MessengerPort.postToChannel(channelId: string, text: string, threadId?: string): Promise<void>`; `FakeMessenger.channelPosts: Array<{ channelId: string; threadId?: string; text: string }>`.

- [ ] **Step 1: Write the failing test**

`src/edge/messenger/fake-messenger.spec.ts` — 파일 끝에 추가(기존 테스트 유지):
```ts
it('postToChannel이 channelPosts에 캡처된다', async () => {
  const m = new FakeMessenger();
  await m.postToChannel('ch1', '안녕', 'th1');
  await m.postToChannel('ch2', '두번째');
  expect(m.channelPosts).toEqual([
    { channelId: 'ch1', threadId: 'th1', text: '안녕' },
    { channelId: 'ch2', threadId: undefined, text: '두번째' },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/edge/messenger/fake-messenger.spec.ts`
Expected: FAIL — `m.postToChannel is not a function` (또는 타입 에러).

- [ ] **Step 3: Add postToChannel to the port interface**

`src/edge/messenger/messenger.port.ts` — `MessengerPort`에 `reply` 다음 줄 추가:
```ts
export interface MessengerPort {
  onMention(handler: (e: MentionEvent) => Promise<void>): void;
  reply(target: ReplyTarget, text: string): Promise<void>;
  postToChannel(channelId: string, text: string, threadId?: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

- [ ] **Step 4: Implement in FakeMessenger**

`src/edge/messenger/fake-messenger.ts` — `replies` 필드 다음에 `channelPosts` 추가하고, `reply` 다음에 `postToChannel` 추가:
```ts
  readonly replies: Array<{ target: ReplyTarget; text: string }> = [];
  readonly channelPosts: Array<{ channelId: string; threadId?: string; text: string }> = [];
```
```ts
  async postToChannel(channelId: string, text: string, threadId?: string): Promise<void> {
    this.channelPosts.push({ channelId, threadId, text });
  }
```

- [ ] **Step 5: Implement in DiscordAdapter**

`src/edge/messenger/discord.adapter.ts` — `reply` 메서드 다음에 추가:
```ts
  // 채널 ID로 게시(영속 발사가 되쏠 경로, Phase 6b-3). 스레드 우선.
  // ponytail: 네트워크 글루, 스모크만.
  async postToChannel(channelId: string, text: string, threadId?: string): Promise<void> {
    const ch = await this.client.channels.fetch(threadId ?? channelId);
    if (ch && ch.isTextBased()) {
      await (ch as import('discord.js').TextChannel).send(text);
    }
  }
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx jest src/edge/messenger/fake-messenger.spec.ts`
Expected: PASS (기존 + 신규 postToChannel 테스트).
Run: `npx tsc --noEmit`
Expected: 0 errors(DiscordAdapter가 `postToChannel`을 구현하므로 `MessengerPort` 인터페이스 충족).

- [ ] **Step 7: Commit**

```bash
git add src/edge/messenger/messenger.port.ts src/edge/messenger/fake-messenger.ts src/edge/messenger/discord.adapter.ts src/edge/messenger/fake-messenger.spec.ts
git commit -m "feat(phase6b3): MessengerPort.postToChannel — 채널ID 게시(영속 발사용)"
```

---

## Task 2: ScheduleStore (영속 + 타입)

**Files:**
- Create: `src/agent-layer/schedule-store.ts`
- Test: `src/agent-layer/schedule-store.spec.ts`

**Interfaces:**
- Produces:
  - `interface ScheduleEntry { id: string; channelId: string; threadId?: string; cron: string; task: string; once?: boolean; createdAt: string }`
  - `interface SchedulerPort { add(input: { channelId: string; threadId?: string; cron: string; task: string; once?: boolean }): ScheduleEntry | null; list(channelId: string): ScheduleEntry[]; remove(id: string): boolean }`
  - `class ScheduleStore { load(): void; all(): ScheduleEntry[]; byChannel(channelId: string): ScheduleEntry[]; add(input: { channelId: string; threadId?: string; cron: string; task: string; once?: boolean }): ScheduleEntry; remove(id: string): boolean }`

- [ ] **Step 1: Write the failing test**

`src/agent-layer/schedule-store.spec.ts`:
```ts
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { ScheduleStore } from './schedule-store';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sched-')); }

it('add가 id·createdAt 부여하고 all에 노출', () => {
  const s = new ScheduleStore(tmp());
  const e = s.add({ channelId: 'c1', cron: '0 9 * * *', task: 'X' });
  expect(e.id).toBeTruthy();
  expect(e.createdAt).toBeTruthy();
  expect(s.all()).toHaveLength(1);
});

it('byChannel이 채널로 필터', () => {
  const s = new ScheduleStore(tmp());
  s.add({ channelId: 'c1', cron: '0 9 * * *', task: 'A' });
  s.add({ channelId: 'c2', cron: '0 9 * * *', task: 'B' });
  expect(s.byChannel('c1').map((e) => e.task)).toEqual(['A']);
});

it('remove가 삭제하고 결과 반환', () => {
  const s = new ScheduleStore(tmp());
  const e = s.add({ channelId: 'c1', cron: '0 9 * * *', task: 'X' });
  expect(s.remove(e.id)).toBe(true);
  expect(s.remove('nope')).toBe(false);
  expect(s.all()).toHaveLength(0);
});

it('영속: add 후 새 인스턴스 load하면 남아있음', () => {
  const dir = tmp();
  new ScheduleStore(dir).add({ channelId: 'c1', cron: '0 9 * * *', task: 'X' });
  const s2 = new ScheduleStore(dir); s2.load();
  expect(s2.all()).toHaveLength(1);
});

it('깨진 파일 → 빈', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'schedules.json'), '{not json');
  const s = new ScheduleStore(dir); s.load();
  expect(s.all()).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/agent-layer/schedule-store.spec.ts`
Expected: FAIL — `Cannot find module './schedule-store'`.

- [ ] **Step 3: Write schedule-store.ts**

`src/agent-layer/schedule-store.ts`:
```ts
import * as fs from 'fs';
import * as path from 'path';

// 예약 엔트리(Phase 6b-3). schedules.json에 영속.
export interface ScheduleEntry {
  id: string;
  channelId: string;
  threadId?: string;
  cron: string;       // 표준 5필드
  task: string;       // 발사 시 재주입할 자연어 지시
  once?: boolean;     // true면 1회 발사 후 자기 삭제
  createdAt: string;
}

// Orchestrator가 보는 스케줄러 포트(구현=ScheduleService). add는 잘못된 cron이면 null.
export interface SchedulerPort {
  add(input: { channelId: string; threadId?: string; cron: string; task: string; once?: boolean }): ScheduleEntry | null;
  list(channelId: string): ScheduleEntry[];
  remove(id: string): boolean;
}

// runtime/config/schedules.json 영속(meeting-config 패턴). 쓰기마다 저장.
export class ScheduleStore {
  private entries: ScheduleEntry[] = [];
  private seq = 0;
  constructor(private readonly configDir: string) {}

  private file(): string { return path.join(this.configDir, 'schedules.json'); }

  load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      this.entries = Array.isArray(parsed) ? (parsed as ScheduleEntry[]) : [];
    } catch {
      this.entries = [];
    }
  }

  all(): ScheduleEntry[] { return [...this.entries]; }

  byChannel(channelId: string): ScheduleEntry[] {
    return this.entries.filter((e) => e.channelId === channelId);
  }

  add(input: { channelId: string; threadId?: string; cron: string; task: string; once?: boolean }): ScheduleEntry {
    const entry: ScheduleEntry = { id: this.newId(), createdAt: new Date().toISOString(), ...input };
    this.entries.push(entry);
    this.save();
    return entry;
  }

  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    const removed = this.entries.length < before;
    if (removed) this.save();
    return removed;
  }

  // 프로세스 내 단조 id + 타임스탬프(재현·충돌회피). Math.random 미사용.
  private newId(): string {
    return `s${Date.now().toString(36)}${(this.seq++).toString(36)}`;
  }

  private save(): void {
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(this.file(), JSON.stringify(this.entries, null, 2));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/agent-layer/schedule-store.spec.ts`
Expected: PASS (5 passing).

- [ ] **Step 5: Commit**

```bash
git add src/agent-layer/schedule-store.ts src/agent-layer/schedule-store.spec.ts
git commit -m "feat(phase6b3): ScheduleStore — 예약 영속(schedules.json) + SchedulerPort 타입"
```

---

## Task 3: ScheduleService (cron 등록·발사)

**Files:**
- Create: `src/edge/schedule-service.ts`
- Test: `src/edge/schedule-service.spec.ts`

**Interfaces:**
- Consumes: `ScheduleStore`/`ScheduleEntry`/`SchedulerPort`(Task 2), `MessengerPort`(Task 1, `postToChannel`), `SchedulerRegistry`(@nestjs/schedule), `CronJob`/`CronTime`(cron).
- Produces: `class ScheduleService implements SchedulerPort` + `start(): void`, `fire(e: ScheduleEntry): void`, protected `makeJob(cron, onTick)`.

- [ ] **Step 1: Write the failing test**

`src/edge/schedule-service.spec.ts`:
```ts
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { ScheduleService } from './schedule-service';
import { ScheduleStore } from '../agent-layer/schedule-store';
import { FakeMessenger } from './messenger/fake-messenger';

function tmpStore(): ScheduleStore { return new ScheduleStore(fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ss-'))); }
const logger = { warn() {} } as any;
// 실 cron 타이머를 피하려고 makeJob을 no-op으로 덮은 서비스.
function service(orchestrator: any, port: any, registry: any, store: ScheduleStore) {
  const svc = new ScheduleService(orchestrator, port, registry, store, logger);
  (svc as any).makeJob = () => ({ start() {}, stop() {} });
  return svc;
}
function fakeRegistry() {
  const added: string[] = []; const deleted: string[] = [];
  return { added, deleted, addCronJob: (n: string) => added.push(n), deleteCronJob: (n: string) => deleted.push(n) };
}

it('add: 잘못된 cron → null(저장 안 함)', () => {
  const store = tmpStore();
  const svc = service({}, new FakeMessenger(), fakeRegistry(), store);
  expect(svc.add({ channelId: 'c1', cron: 'not a cron', task: 'X' })).toBeNull();
  expect(store.all()).toHaveLength(0);
});

it('add: 유효 cron → 저장 + registry 등록', () => {
  const store = tmpStore();
  const reg = fakeRegistry();
  const svc = service({}, new FakeMessenger(), reg, store);
  const e = svc.add({ channelId: 'c1', cron: '0 9 * * *', task: 'X' });
  expect(e).not.toBeNull();
  expect(store.all()).toHaveLength(1);
  expect(reg.added).toEqual([`sched-${e!.id}`]);
});

it('fire: 저장된 task를 handleMention으로 재주입 → post가 채널로', async () => {
  const store = tmpStore();
  const port = new FakeMessenger();
  const orchestrator = { handleMention: async (_msg: any, post: any) => { await post('결과'); } };
  const svc = service(orchestrator, port, fakeRegistry(), store);
  const e = store.add({ channelId: 'c1', threadId: 't1', cron: '0 9 * * *', task: '서버비 정리' });
  svc.fire(e);
  await new Promise((r) => setImmediate(r)); // detached handleMention flush
  expect(port.channelPosts).toEqual([{ channelId: 'c1', threadId: 't1', text: '결과' }]);
});

it('fire once: 발사 후 remove(store + registry)', async () => {
  const store = tmpStore();
  const reg = fakeRegistry();
  const orchestrator = { handleMention: async () => {} };
  const svc = service(orchestrator, new FakeMessenger(), reg, store);
  const e = store.add({ channelId: 'c1', cron: '0 9 * * *', task: 'X', once: true });
  svc.fire(e);
  await new Promise((r) => setImmediate(r));
  expect(store.all()).toHaveLength(0);
  expect(reg.deleted).toEqual([`sched-${e.id}`]);
});

it('remove: registry.deleteCronJob + store.remove', () => {
  const store = tmpStore();
  const reg = fakeRegistry();
  const svc = service({}, new FakeMessenger(), reg, store);
  const e = store.add({ channelId: 'c1', cron: '0 9 * * *', task: 'X' });
  expect(svc.remove(e.id)).toBe(true);
  expect(reg.deleted).toEqual([`sched-${e.id}`]);
});

it('start: 저장된 예약을 로드·등록', () => {
  const store = tmpStore();
  store.add({ channelId: 'c1', cron: '0 9 * * *', task: 'A' });
  store.add({ channelId: 'c2', cron: '0 10 * * *', task: 'B' });
  const reg = fakeRegistry();
  const svc = service({}, new FakeMessenger(), reg, store);
  svc.start();
  expect(reg.added).toHaveLength(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/edge/schedule-service.spec.ts`
Expected: FAIL — `Cannot find module './schedule-service'`.

- [ ] **Step 3: Write schedule-service.ts**

`src/edge/schedule-service.ts`:
```ts
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob, CronTime } from 'cron';
import { MessengerPort } from './messenger/messenger.port';
import { ScheduleStore, ScheduleEntry, SchedulerPort } from '../agent-layer/schedule-store';

// Orchestrator를 구조적 타입으로만 의존(순환 회피).
interface MentionRunner {
  handleMention(
    msg: { text: string; userId: string },
    post: (t: string) => Promise<void>,
    threadKey?: string,
  ): Promise<void>;
}

// 예약 런타임(Phase 6b-3, plain — main.ts 결선). cron 등록·발사·영속을 담당하고
// SchedulerPort로 Orchestrator에 노출. 발사는 저장된 task를 handleMention 재주입 → 채널 게시.
export class ScheduleService implements SchedulerPort {
  constructor(
    private readonly orchestrator: MentionRunner,
    private readonly port: MessengerPort,
    private readonly registry: SchedulerRegistry,
    private readonly store: ScheduleStore,
    private readonly logger: { warn(msg: string, ctx?: string): void },
  ) {}

  // 부팅: 저장된 예약을 로드·등록(개별 실패는 스킵).
  start(): void {
    this.store.load();
    for (const e of this.store.all()) {
      try { this.register(e); }
      catch (err) { this.logger.warn(`예약 등록 실패(스킵) ${e.id}: ${String(err)}`, 'Schedule'); }
    }
  }

  add(input: { channelId: string; threadId?: string; cron: string; task: string; once?: boolean }): ScheduleEntry | null {
    if (!this.validCron(input.cron)) return null;
    const e = this.store.add(input);
    try { this.register(e); }
    catch (err) { this.logger.warn(`예약 등록 실패 ${e.id}: ${String(err)}`, 'Schedule'); }
    return e;
  }

  list(channelId: string): ScheduleEntry[] { return this.store.byChannel(channelId); }

  remove(id: string): boolean {
    try { this.registry.deleteCronJob(`sched-${id}`); } catch { /* 없으면 무시 */ }
    return this.store.remove(id);
  }

  // 발사: 저장된 task를 재주입, 채널에 게시. once면 발사 후 삭제.
  // ponytail: 재주입=완전자율(협업/코딩 뭐든). 매일 협업이면 매일 토큰 — 비용은 사용자 cron 책임.
  fire(e: ScheduleEntry): void {
    void this.orchestrator
      .handleMention(
        { text: e.task, userId: e.channelId },
        (t) => this.port.postToChannel(e.channelId, t, e.threadId),
        e.threadId ?? e.channelId,
      )
      .catch((err) => this.logger.warn(`예약 실행 실패 ${e.id}: ${String(err)}`, 'Schedule'));
    if (e.once) this.remove(e.id);
  }

  private validCron(expr: string): boolean {
    try { new CronTime(expr); return true; } catch { return false; }
  }

  private register(e: ScheduleEntry): void {
    const job = this.makeJob(e.cron, () => this.fire(e));
    this.registry.addCronJob(`sched-${e.id}`, job as unknown as CronJob);
    job.start();
  }

  // 테스트에서 실 타이머를 피하려 job 생성을 seam으로 분리.
  protected makeJob(cron: string, onTick: () => void): { start(): void; stop(): void } {
    return new CronJob(cron, onTick) as unknown as { start(): void; stop(): void };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/edge/schedule-service.spec.ts`
Expected: PASS (6 passing).

- [ ] **Step 5: Commit**

```bash
git add src/edge/schedule-service.ts src/edge/schedule-service.spec.ts
git commit -m "feat(phase6b3): ScheduleService — cron 등록·발사(task 재주입→채널 게시)·once"
```

---

## Task 4: Orchestrator 예약 분기 + main 결선 + triage

**Files:**
- Modify: `src/agent-layer/orchestrator.ts`, `src/main.ts`, `prompts/triage.md`
- Test: `src/agent-layer/orchestrator-schedule.spec.ts`

**Interfaces:**
- Consumes: `SchedulerPort`/`ScheduleEntry`(Task 2), `ScheduleStore`(Task 2), `ScheduleService`(Task 3), `SchedulerRegistry`(@nestjs/schedule).
- Produces: classify가 `schedule` 종류(`cron?`,`task?`,`once?`) 반환. `Orchestrator.setScheduler(s: SchedulerPort)`. handleMention이 예약/목록/취소 처리.

- [ ] **Step 1: Write the failing test**

`src/agent-layer/orchestrator-schedule.spec.ts`:
```ts
import { Orchestrator } from './orchestrator';

const logger = { warn() {}, error() {}, log() {} } as any;

function orc(classifyJson: string) {
  const brain = { complete: async () => ({ text: classifyJson, costUsd: 0, isError: false }) } as any;
  const registry = { all: () => [] } as any;
  const conversations = { append: async () => {} } as any;
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
    brain, null as any, null as any, registry, null as any,
  );
  return o;
}

// 스텁 스케줄러
function fakeScheduler() {
  const calls: any = { add: [], list: [], remove: [] };
  return {
    calls,
    add(input: any) { calls.add.push(input); return input.cron === 'BAD' ? null : { id: 'x1', cron: input.cron, task: input.task, once: input.once, channelId: input.channelId, createdAt: 't' }; },
    list(channelId: string) { calls.list.push(channelId); return [{ id: 'x1', cron: '0 9 * * *', task: '서버비', channelId, createdAt: 't' }]; },
    remove(id: string) { calls.remove.push(id); return id === 'x1'; },
  };
}

it('classify schedule → scheduler.add 호출 + 확인 게시', async () => {
  const o = orc('{"kind":"schedule","cron":"0 9 * * *","task":"서버비 정리"}');
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await o.handleMention({ text: '매일 9시에 서버비 정리해줘', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(sch.calls.add[0]).toMatchObject({ channelId: 'c1', cron: '0 9 * * *', task: '서버비 정리' });
  expect(posts[0]).toContain('예약했어요');
});

it('add가 null(잘못된 cron) → 되묻기', async () => {
  const o = orc('{"kind":"schedule","cron":"BAD","task":"X"}');
  o.setScheduler(fakeScheduler() as any);
  const posts: string[] = [];
  await o.handleMention({ text: '언젠가 X', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts[0]).toContain('언제인지');
});

it('예약목록 → list 집계 게시', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  o.setScheduler(fakeScheduler() as any);
  const posts: string[] = [];
  await o.handleMention({ text: '예약목록', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts[0]).toContain('서버비');
  expect(posts[0]).toContain('#x1');
});

it('예약취소 <id> → remove 호출', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await o.handleMention({ text: '예약취소 x1', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(sch.calls.remove).toEqual(['x1']);
  expect(posts[0]).toContain('취소');
});

it('escape hatch "schedule <cron> <task>" → add', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  await o.handleMention({ text: 'schedule 0 9 * * * 서버비 정리', userId: 'c1' }, async () => {});
  expect(sch.calls.add[0]).toMatchObject({ cron: '0 9 * * *', task: '서버비 정리' });
});

it('scheduler 미주입 → 안내', async () => {
  const o = orc('{"kind":"schedule","cron":"0 9 * * *","task":"X"}');
  const posts: string[] = [];
  await o.handleMention({ text: '매일 9시 X', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts[0]).toContain('준비되지 않');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/agent-layer/orchestrator-schedule.spec.ts`
Expected: FAIL — `setScheduler`/schedule 분기 미존재.

- [ ] **Step 3: Add import + scheduler field + setScheduler**

`src/agent-layer/orchestrator.ts` — import 블록 끝(`./coderepos` import 옆)에 추가:
```ts
import { SchedulerPort, ScheduleEntry } from './schedule-store';
```
클래스 필드(기존 `pending`/`codeReposCache` 옆)에 추가:
```ts
  // 예약(스케줄) 포트 — main.ts에서 setter 주입(메신저처럼 DI 밖). 6b-3.
  private scheduler?: SchedulerPort;
```
public 메서드 추가(`setScheduler` — 예: `route()` 위나 클래스 상단 아무 곳, 다른 메서드와 나란히):
```ts
  setScheduler(scheduler: SchedulerPort): void {
    this.scheduler = scheduler;
  }
```

- [ ] **Step 4: Extend classify for schedule**

`src/agent-layer/orchestrator.ts` — `TRIAGE_DEFAULT` 배열에 줄 추가('확실치 않으면 chat' 앞):
```ts
  '(4) 정해진 시간/주기에 무언가를 하라는 예약이면 "schedule" — cron에 5필드 cron(예: 매일 9시=0 9 * * *), task에 할 일, 반복 아니고 한 번이면 once=true를 넣어라.',
```

기존 `classify` 메서드를 다음으로 교체(반환에 schedule + cron/task/once 추가):
```ts
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
```

- [ ] **Step 5: Add schedule branches to handleMention**

`src/agent-layer/orchestrator.ts` — handleMention에서, 코딩 pending 블록과 `code ` escape hatch 다음, `team ` escape hatch 앞에 삽입:
```ts
    // 예약(스케줄) 관리 명령
    if (trimmed === '예약목록' || trimmed === 'schedules') {
      await post(this.formatSchedules(msg.userId));
      return;
    }
    if (trimmed.startsWith('예약취소 ') || trimmed.startsWith('schedule cancel ')) {
      const id = (trimmed.startsWith('예약취소 ') ? trimmed.slice('예약취소 '.length) : trimmed.slice('schedule cancel '.length)).trim();
      const ok = this.scheduler?.remove(id) ?? false;
      await post(ok ? '취소했어요.' : '그 예약을 못 찾았어요.');
      return;
    }
    if (trimmed.startsWith('schedule ')) {
      const rest = trimmed.slice('schedule '.length).trim();
      const parts = rest.split(' ').filter(Boolean);
      const cron = parts.slice(0, 5).join(' ');
      const task = parts.slice(5).join(' ');
      await this.doSchedule(cron, task, false, msg.userId, threadKey, post);
      return;
    }
```

그리고 handleMention의 classify 분기에 schedule 처리 추가 — 기존 `if (decision.kind === 'code') { ... }` 블록 다음에:
```ts
    if (decision.kind === 'schedule') {
      await this.doSchedule(decision.cron ?? '', decision.task ?? '', decision.once ?? false, msg.userId, threadKey, post);
      return;
    }
```

- [ ] **Step 6: Add doSchedule + formatSchedules helpers**

`src/agent-layer/orchestrator.ts` — 코딩 헬퍼(`codingResultMessage`) 다음에 추가:
```ts
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
```

- [ ] **Step 7: Run schedule tests + regression + typecheck**

Run: `npx jest src/agent-layer/orchestrator-schedule.spec.ts`
Expected: PASS (6 passing).
Run: `npx jest src/agent-layer/orchestrator-handle-mention.spec.ts src/agent-layer/orchestrator-coding.spec.ts`
Expected: PASS (기존 handle-mention 11 + coding 9 — classify union 넓힘만이라 무영향).
Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 8: Wire into main.ts + triage.md**

`prompts/triage.md` — 파일 끝에 추가:
```markdown

- 정해진 시간/주기에 하라는 예약이면 → "schedule". cron에 5필드 cron(매일 9시=`0 9 * * *`), task에 할 일, 한 번뿐이면 once=true.
```

`src/main.ts` — import 추가:
```ts
import { SchedulerRegistry } from '@nestjs/schedule';
import { ScheduleStore } from './agent-layer/schedule-store';
import { ScheduleService } from './edge/schedule-service';
```
`if (port) { ... }` 블록을 다음으로 교체:
```ts
  if (port) {
    const orchestrator = app.get(Orchestrator);
    bindMessenger(port, orchestrator, logger);
    const store = new ScheduleStore(paths.getConfigDir());
    const scheduler = new ScheduleService(orchestrator, port, app.get(SchedulerRegistry), store, logger);
    orchestrator.setScheduler(scheduler);
    scheduler.start();
    await port.start();
    logger.log(`메신저 가동: ${cfg.provider}`, 'Messenger');
  }
```

- [ ] **Step 9: Full suite + typecheck**

Run: `npx jest --runInBand`
Expected: 전체 PASS(신규 schedule-store 5 + schedule-service 6 + orchestrator-schedule 6 포함). (병렬 시 wiki-engine publishPage 타임아웃은 `--runInBand`로 회피.)
Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 10: Commit**

```bash
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator-schedule.spec.ts src/main.ts prompts/triage.md
git commit -m "feat(phase6b3): Orchestrator 예약 분기 + main 결선 — classify schedule·예약목록/취소·doSchedule"
```

---

## Self-Review

**Spec coverage (스펙 §4 ↔ 태스크):**
- §4.2 postToChannel → Task 1. §4.3 ScheduleStore → Task 2. §4.4 SchedulerPort → Task 2. §4.5 ScheduleService(start/register/fire/add/remove/list/once) → Task 3. §4.6 Orchestrator(classify schedule·예약목록/취소·doSchedule·setScheduler) → Task 4. §4.7 main 결선 → Task 4 Step 8. §4.8 흐름 → Task 3+4. §4.9 오류처리 → Task 2(깨짐→빈)·Task 3(cron검증·발사 catch·부팅 스킵)·Task 4(미주입 안내). §4.10 테스트 → 각 spec. §4.11 영향파일 전부 매핑.
- 비범위(자가스케줄·run-state) 미구현 확인. ✅

**Placeholder scan:** "TBD/적절히" 없음. 모든 코드 스텝 실제 코드. ✅

**Type consistency:** `postToChannel(channelId, text, threadId?)` — Task 1 port/fake/discord·Task 3 fire 사용 일치. `ScheduleEntry`·`SchedulerPort{add/list/remove}`·`ScheduleStore{load/all/byChannel/add/remove}` — Task 2 정의·Task 3·4 사용 동일. `ScheduleService.fire/start/makeJob` — Task 3 정의·테스트 일치. classify 반환 union(+schedule,cron,task,once)·`setScheduler`·`doSchedule`·`formatSchedules` — Task 4 정의·테스트 일치. 생성자 18인자(paths 유지) — schedule 테스트 orc가 18인자 구성. ✅

**알아둘 점:** ScheduleService.makeJob seam은 테스트가 실 cron 타이머를 피하려는 것(운영은 실 CronJob). main.ts는 unit 대상 아님 — Task 4 Step 9 전체 스위트+tsc+app 부팅으로 커버. 태스크 순서 1→2→3→4.
