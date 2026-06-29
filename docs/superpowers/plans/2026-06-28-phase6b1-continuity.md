# Phase 6b-1 — `@Engram` 연속성(백그라운드 자율) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 멘션한 일을 백그라운드로 수행 — ack 즉시 반환·끝나면 스레드에 결과 게시·`@Engram 상태`로 진행/최근 조회·결과는 채널 대화로그에 적재.

**Architecture:** `handleMention`을 "답 return" → "`post(text)` 콜백" 모델로 바꾸고, collaborate는 detach해 백그라운드로 돌린다. 상태는 Orchestrator 내부 in-memory `MentionTracker`가 추적(TaskStore 무변경). 코어·CLI·main.ts·discord.adapter 무변경.

**Tech Stack:** Node 22 · NestJS · TypeScript · jest(ts-jest)

## Global Constraints

- 새 의존성 0.
- 코어 중립성: `src/edge/core-message.ts` 무변경. 작업 추적 키(threadKey)는 bridge가 계산, 지식 네임스페이스는 채널 유지(`userId = e.channelId`).
- 상주 불사: detached 백그라운드는 자체 try/catch(unhandled rejection 0), 실패 시 사과+`logger.warn`.
- 막다른 길 없음: classify 실패→chat, 빈 팀→`['Manager']`(6a 유지).
- `PinoLogger`는 `info()` 없음 — `log/warn/error`만 사용.
- TaskStore·`agent-layer.module.ts`·`main.ts` 무변경(트래커는 Orchestrator 내부 필드).
- 결정론 테스트: 실 네트워크/실 claude 금지. 백그라운드 완료는 `drainForTest()`로 관측(테스트 전용 훅).

---

## File Structure

- 신규 `src/agent-layer/mention-tracker.ts` — in-memory 스레드별 작업 추적(`MentionTracker`, `TrackedTask`).
- 신규 `src/agent-layer/mention-tracker.spec.ts`.
- 수정 `src/agent-layer/orchestrator.ts` — `handleMention` post 모델 + `launchCollaboration` + `formatStatus` + `tracker`/`inflight` 필드 + `drainForTest`.
- 수정 `src/agent-layer/orchestrator-handle-mention.spec.ts` — post 모델로 갱신.
- 수정 `src/edge/messenger/messenger-bridge.ts` — `MentionHandler` 시그니처 + post/threadKey 배선.
- 수정 `src/edge/messenger/messenger-bridge.spec.ts` — post/threadKey로 갱신.

---

## Task 1: MentionTracker (in-memory 상태 추적)

**Files:**
- Create: `src/agent-layer/mention-tracker.ts`
- Test: `src/agent-layer/mention-tracker.spec.ts`

**Interfaces:**
- Produces:
  - `type TrackedState = 'running' | 'done' | 'failed'`
  - `interface TrackedTask { id: string; question: string; team: string[]; state: TrackedState; startedAt: string; finishedAt?: string }`
  - `class MentionTracker { start(threadKey: string, t: { question: string; team: string[] }, now?: string): TrackedTask; finish(threadKey: string, id: string, state: 'done' | 'failed', now?: string): void; status(threadKey: string): TrackedTask[] }`

- [ ] **Step 1: Write the failing test**

`src/agent-layer/mention-tracker.spec.ts`:
```ts
import { MentionTracker } from './mention-tracker';

it('start하면 running으로 status에 노출', () => {
  const tr = new MentionTracker();
  tr.start('th1', { question: '비용 줄여줘', team: ['Manager'] });
  const s = tr.status('th1');
  expect(s).toHaveLength(1);
  expect(s[0].state).toBe('running');
  expect(s[0].team).toEqual(['Manager']);
});

it('finish하면 done/failed로 전이', () => {
  const tr = new MentionTracker();
  const t = tr.start('th1', { question: 'q', team: ['A'] });
  tr.finish('th1', t.id, 'done');
  expect(tr.status('th1')[0].state).toBe('done');
});

it('완료분은 최근 5개만 유지(running은 전부)', () => {
  const tr = new MentionTracker();
  for (let i = 0; i < 7; i++) { const t = tr.start('th1', { question: `q${i}`, team: [] }); tr.finish('th1', t.id, 'done'); }
  const running = tr.start('th1', { question: 'live', team: [] }); // running 1개
  const s = tr.status('th1');
  const done = s.filter((x) => x.state === 'done');
  expect(done).toHaveLength(5);          // 완료분 캡
  expect(s.some((x) => x.id === running.id && x.state === 'running')).toBe(true); // running 보존
});

it('스레드 격리', () => {
  const tr = new MentionTracker();
  tr.start('th1', { question: 'a', team: [] });
  expect(tr.status('th2')).toEqual([]);
});

it('status는 최신순(나중 것이 앞)', () => {
  const tr = new MentionTracker();
  tr.start('th1', { question: 'first', team: [] });
  tr.start('th1', { question: 'second', team: [] });
  expect(tr.status('th1')[0].question).toBe('second');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/agent-layer/mention-tracker.spec.ts`
Expected: FAIL — `Cannot find module './mention-tracker'`.

- [ ] **Step 3: Write MentionTracker**

`src/agent-layer/mention-tracker.ts`:
```ts
// 멘션 작업의 in-memory 상태 추적(Phase 6b-1). @Engram 상태 조회용.
// TaskStore와 별개 — TaskStore엔 목록/스레드 질의 API가 없고 추가는 과함.
// ponytail: in-memory·재시작 시 소실. 영속 추적은 6b-3(자가 스케줄).
export type TrackedState = 'running' | 'done' | 'failed';

export interface TrackedTask {
  id: string;
  question: string;
  team: string[];
  state: TrackedState;
  startedAt: string;
  finishedAt?: string;
}

const RECENT_KEEP = 5; // 스레드당 완료분 보존 개수(running은 전부 보존)

export class MentionTracker {
  private seq = 0;
  private byThread = new Map<string, TrackedTask[]>();

  start(threadKey: string, t: { question: string; team: string[] }, now = new Date().toISOString()): TrackedTask {
    const task: TrackedTask = {
      id: `m${this.seq++}`, question: t.question, team: t.team, state: 'running', startedAt: now,
    };
    const list = this.byThread.get(threadKey) ?? [];
    list.push(task);
    this.byThread.set(threadKey, list);
    return task;
  }

  finish(threadKey: string, id: string, state: 'done' | 'failed', now = new Date().toISOString()): void {
    const list = this.byThread.get(threadKey);
    if (!list) return;
    const task = list.find((x) => x.id === id);
    if (!task) return;
    task.state = state;
    task.finishedAt = now;
    // running은 전부 보존, 완료분은 최근 RECENT_KEEP개만(삽입순서 유지).
    const running = list.filter((x) => x.state === 'running');
    const finished = list.filter((x) => x.state !== 'running').slice(-RECENT_KEEP);
    this.byThread.set(threadKey, [...running, ...finished]);
  }

  status(threadKey: string): TrackedTask[] {
    return [...(this.byThread.get(threadKey) ?? [])].reverse(); // 최신순
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/agent-layer/mention-tracker.spec.ts`
Expected: PASS (5 passing).

- [ ] **Step 5: Commit**

```bash
git add src/agent-layer/mention-tracker.ts src/agent-layer/mention-tracker.spec.ts
git commit -m "feat(phase6b1): MentionTracker — 스레드별 in-memory 작업 상태 추적"
```

---

## Task 2: Orchestrator.handleMention post 모델 + 백그라운드

**Files:**
- Modify: `src/agent-layer/orchestrator.ts`
- Test: `src/agent-layer/orchestrator-handle-mention.spec.ts` (전면 갱신)

**Interfaces:**
- Consumes: `MentionTracker`/`TrackedTask`(Task 1), 기존 `route`/`collaborate`/`classify`, `this.conversations.append(userId, { ts, question, answer, sources })`, `this.logger.warn`.
- Produces:
  - `handleMention(msg: CoreMessage, post: (text: string) => Promise<void>, threadKey?: string): Promise<void>`
  - private `launchCollaboration(question: string, team: string[], userId: string, threadKey: string, post: (text: string) => Promise<void>): void`
  - private `formatStatus(tasks: TrackedTask[]): string`
  - `drainForTest(): Promise<void>` (테스트 전용)

- [ ] **Step 1: Write the failing test (replace file contents)**

`src/agent-layer/orchestrator-handle-mention.spec.ts` (파일 전체를 아래로 교체):
```ts
import { Orchestrator } from './orchestrator';

const logger = { warn() {}, error() {}, log() {} } as any;

// 생성자: (reader, conversations, logger, ingester, tasks, specialist, synth, sem,
//          projects, gate, codingGit, coder, reviewer, codeBrain, fence, reporter, registry)
function orc(brainText: string, registryNames: string[] = ['Manager', 'Infra']) {
  const brain = { complete: async () => ({ text: brainText, costUsd: 0, isError: false }) } as any;
  const registry = { all: () => registryNames.map((name) => ({ name, role: 'r', brain: 'claude', tools: [], invocation: ['summon'], prompt: '' })) } as any;
  const conversations = { append: async () => {} } as any; // launchCollaboration이 결과를 적재
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
    brain, null as any, null as any, registry,
  );
  return o;
}

it('분류 collaborate → ack 후 백그라운드 결과 post', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager","Infra"]}');
  (o as any).collaborate = async () => '종합';
  const posts: string[] = [];
  await o.handleMention({ text: '서버 비용 줄여줘', userId: 'c1' }, async (t) => { posts.push(t); });
  await (o as any).drainForTest();
  expect(posts[0]).toContain('알아볼게요');
  expect(posts).toContain('종합');
});

it('collaborate 팀이 ack 문구에 들어감', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager","Infra"]}');
  (o as any).collaborate = async () => 'x';
  const posts: string[] = [];
  await o.handleMention({ text: 'q', userId: 'c1' }, async (t) => { posts.push(t); });
  await (o as any).drainForTest();
  expect(posts[0]).toContain('Manager');
  expect(posts[0]).toContain('Infra');
});

it('분류 chat → 답을 post', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  (o as any).route = async () => '즉답';
  const posts: string[] = [];
  await o.handleMention({ text: '엔그램이 뭐야?', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts).toEqual(['즉답']);
});

it('분류 응답이 깨지면 chat 폴백', async () => {
  const o = orc('이건 JSON이 아님');
  let routed = false;
  (o as any).route = async () => { routed = true; return 'r'; };
  await o.handleMention({ text: 'x', userId: 'c1' }, async () => {});
  expect(routed).toBe(true);
});

it('collaborate인데 team이 비면 [Manager] 폴백', async () => {
  const o = orc('{"kind":"collaborate","team":[]}');
  let used: string[] = [];
  (o as any).collaborate = async (_q: string, team: string[]) => { used = team; return 'x'; };
  await o.handleMention({ text: 'x', userId: 'c1' }, async () => {});
  await (o as any).drainForTest();
  expect(used).toEqual(['Manager']);
});

it('escape hatch "team a,b 질문" → 백그라운드 collaborate', async () => {
  const o = orc('{"kind":"chat","team":[]}'); // 분류 chat이어도 무시
  const calls: any[] = [];
  (o as any).collaborate = async (q: string, team: string[]) => { calls.push({ q, team }); return 'x'; };
  await o.handleMention({ text: 'team Brand,Trend 런칭 전략?', userId: 'c1' }, async () => {});
  await (o as any).drainForTest();
  expect(calls[0]).toEqual({ q: '런칭 전략?', team: ['Brand', 'Trend'] });
});

it('escape hatch "ask 질문" → chat route', async () => {
  const o = orc('{"kind":"collaborate","team":["X"]}'); // 무시돼야
  (o as any).route = async (m: any) => `r:${m.text}`;
  const posts: string[] = [];
  await o.handleMention({ text: 'ask 엔그램이 뭐야', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts).toEqual(['r:엔그램이 뭐야']);
});

it('상태 → 진행 중 작업 보고', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager"]}');
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  (o as any).collaborate = async () => { await gate; return '결과'; };
  await o.handleMention({ text: '분석해줘', userId: 'c1' }, async () => {}); // 백그라운드 시작(미완)
  const statusPosts: string[] = [];
  await o.handleMention({ text: '상태', userId: 'c1' }, async (t) => { statusPosts.push(t); });
  expect(statusPosts[0]).toContain('진행 중');
  release();
  await (o as any).drainForTest();
});

it('상태 — 작업 없으면 안내', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  const posts: string[] = [];
  await o.handleMention({ text: 'status', userId: 'c9' }, async (t) => { posts.push(t); });
  expect(posts[0]).toContain('없어요');
});

it('백그라운드 실패 → 사과 post(상주 불사)', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager"]}');
  (o as any).collaborate = async () => { throw new Error('boom'); };
  const posts: string[] = [];
  await o.handleMention({ text: 'q', userId: 'c1' }, async (t) => { posts.push(t); });
  await (o as any).drainForTest();
  expect(posts.some((p) => p.includes('문제가 생겼어요'))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/agent-layer/orchestrator-handle-mention.spec.ts`
Expected: FAIL — 타입/런타임 에러(`handleMention`이 아직 onAck 모델, `drainForTest` 없음).

- [ ] **Step 3: Add imports + fields**

`src/agent-layer/orchestrator.ts` — import 블록에 추가(`PersonaRegistry` import 옆):
```ts
import { MentionTracker, TrackedTask } from './mention-tracker';
```

클래스 본문 시작(생성자 위 또는 첫 필드 자리)에 필드 추가. `@Injectable() export class Orchestrator {` 바로 다음 줄에:
```ts
  // 멘션 작업 상태(in-memory) + 백그라운드 inflight(테스트 drain용). ponytail: 재시작 소실은 6b-3.
  private readonly tracker = new MentionTracker();
  private readonly inflight: Promise<void>[] = [];
```

- [ ] **Step 4: Replace handleMention with the post-callback model**

`src/agent-layer/orchestrator.ts` — 기존 `handleMention`(현재 `async handleMention(msg, onAck?) → Promise<string>` 블록, 주석 2줄 포함 `route()` 다음~`classify` 앞)을 통째로 아래로 교체. `classify`는 그대로 둔다.

기존(삭제 대상):
```ts
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

    const decision = await this.classify(trimmed);
    if (decision.kind === 'collaborate') {
      const team = decision.team.length ? decision.team : ['Manager'];
      if (onAck) await onAck('알아볼게요');
      return this.collaborate(msg.text, team, msg.userId);
    }
    return this.route(msg);
  }
```

교체(신규):
```ts
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
    // escape hatch(접근 C): 명시 명령은 분류를 건너뛰고 직접 실행.
    if (trimmed.startsWith('team ')) {
      const rest = trimmed.slice('team '.length);
      const sp = rest.indexOf(' ');
      const names = (sp < 0 ? rest : rest.slice(0, sp)).split(',').map((s) => s.trim()).filter(Boolean);
      const q = sp < 0 ? '' : rest.slice(sp + 1);
      const team = names.length ? names : ['Manager'];
      await post(`팀 구성: ${team.join('·')} — 알아볼게요`);
      this.launchCollaboration(q, team, msg.userId, threadKey, post);
      return;
    }
    if (trimmed.startsWith('ask ')) {
      await post(await this.route({ text: trimmed.slice('ask '.length), userId: msg.userId }));
      return;
    }

    const decision = await this.classify(trimmed);
    if (decision.kind === 'collaborate') {
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
  ): void {
    const t = this.tracker.start(threadKey, { question, team });
    const work = (async (): Promise<void> => {
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
        try { await post('작업 중 문제가 생겼어요 🙏'); } catch { /* post도 실패하면 포기 */ }
      }
    })();
    this.inflight.push(work);
  }

  // @Engram 상태 출력. 질문은 40자 잘라 표시(상대시간은 비범위 — 단순화).
  private formatStatus(tasks: TrackedTask[]): string {
    if (tasks.length === 0) return '지금 진행 중이거나 최근 완료한 작업이 없어요.';
    const line = (t: TrackedTask): string => `  - "${t.question.slice(0, 40)}" (팀: ${t.team.join('·') || '-'})`;
    const running = tasks.filter((t) => t.state === 'running');
    const finished = tasks.filter((t) => t.state !== 'running');
    const parts: string[] = [];
    if (running.length) parts.push(`진행 중 ${running.length}건:\n${running.map(line).join('\n')}`);
    if (finished.length) parts.push(`최근 완료:\n${finished.map(line).join('\n')}`);
    return parts.join('\n');
  }

  // 테스트 전용: detach된 백그라운드 작업이 끝날 때까지 대기. ponytail: 테스트 훅(운영 무관).
  async drainForTest(): Promise<void> {
    await Promise.all(this.inflight);
  }
```

- [ ] **Step 5: Run handleMention tests to verify they pass**

Run: `npx jest src/agent-layer/orchestrator-handle-mention.spec.ts`
Expected: PASS (10 passing).

- [ ] **Step 6: Run agent-layer regression + typecheck**

Run: `npx jest src/agent-layer`
Expected: PASS (기존 orchestrator/collaborate/coderun 스펙 포함 — `handleMention`은 messenger 전용이라 다른 경로 무영향).
Run: `npx tsc --noEmit`
Expected: 0 errors. **단, `src/edge/messenger/messenger-bridge.ts`의 `MentionHandler.handleMention` 시그니처가 아직 옛 모델이라 bridge가 타입 에러를 낼 수 있다 — 그건 Task 3에서 고친다.** 만약 tsc가 bridge 때문에만 빨갛다면 이 태스크는 OK로 보고, Task 3 후 전체 tsc 0을 확인한다. (orchestrator 자체 컴파일은 깨끗해야 함.)

- [ ] **Step 7: Commit**

```bash
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator-handle-mention.spec.ts
git commit -m "feat(phase6b1): handleMention post 콜백 모델 + 백그라운드 collaborate + 상태"
```

---

## Task 3: bridge — post/threadKey 배선

**Files:**
- Modify: `src/edge/messenger/messenger-bridge.ts`
- Test: `src/edge/messenger/messenger-bridge.spec.ts` (갱신)

**Interfaces:**
- Consumes: `MessengerPort`(6a), `CoreMessage`, Orchestrator의 새 `handleMention(msg, post, threadKey?)`(Task 2, 구조적 타입).
- Produces: `MentionHandler { handleMention(msg: CoreMessage, post: (text: string) => Promise<void>, threadKey?: string): Promise<void> }`, `bindMessenger(port, orchestrator, logger)`.

- [ ] **Step 1: Write the failing test (replace file contents)**

`src/edge/messenger/messenger-bridge.spec.ts` (파일 전체 교체):
```ts
import { FakeMessenger } from './fake-messenger';
import { bindMessenger } from './messenger-bridge';

const logger = { warn() {} } as any;

it('멘션 → handleMention에 {text,userId=channelId}·post·threadKey 전달', async () => {
  const m = new FakeMessenger();
  const seen: any = {};
  const orch = { handleMention: async (msg: any, post: any, threadKey: any) => { seen.msg = msg; seen.threadKey = threadKey; await post('답'); } };
  bindMessenger(m, orch as any, logger);
  await m.emit({ text: '안녕', channelId: 'c1', threadId: 't1', authorId: 'u1', target: 'T1' });
  expect(seen.msg).toEqual({ text: '안녕', userId: 'c1' });
  expect(seen.threadKey).toBe('t1');
  expect(m.replies).toEqual([{ target: 'T1', text: '답' }]);
});

it('threadId 없으면 channelId가 threadKey', async () => {
  const m = new FakeMessenger();
  let tk: any;
  const orch = { handleMention: async (_m: any, _p: any, threadKey: any) => { tk = threadKey; } };
  bindMessenger(m, orch as any, logger);
  await m.emit({ text: 'x', channelId: 'c1', authorId: 'u1', target: 'T' });
  expect(tk).toBe('c1');
});

it('post는 그 target으로 reply(여러 번 게시 가능)', async () => {
  const m = new FakeMessenger();
  const orch = { handleMention: async (_m: any, post: any) => { await post('알아볼게요'); await post('결과'); } };
  bindMessenger(m, orch as any, logger);
  await m.emit({ text: 'x', channelId: 'c1', authorId: 'u1', target: 'T1' });
  expect(m.replies.map((r) => r.text)).toEqual(['알아볼게요', '결과']);
});

it('handleMention이 던지면 사과 + 로그(상주 불사)', async () => {
  const m = new FakeMessenger();
  const warns: string[] = [];
  const orch = { handleMention: async () => { throw new Error('boom'); } };
  bindMessenger(m, orch as any, { warn: (msg: string) => warns.push(msg) } as any);
  await m.emit({ text: 'x', channelId: 'c1', authorId: 'u1', target: 'T1' });
  expect(m.replies[0].text).toContain('처리가 안 되네요');
  expect(warns.length).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/edge/messenger/messenger-bridge.spec.ts`
Expected: FAIL — 옛 bridge가 `handleMention` 반환값을 post하려 해 `seen.threadKey`/post 호출 기대와 어긋남(또는 타입 에러).

- [ ] **Step 3: Rewrite bridge to post/threadKey model**

`src/edge/messenger/messenger-bridge.ts` (파일 전체 교체):
```ts
import { MessengerPort } from './messenger.port';
import { CoreMessage } from '../core-message';

// Orchestrator를 구조적 타입으로만 의존(순환 import 회피·테스트 용이).
export interface MentionHandler {
  handleMention(
    msg: CoreMessage,
    post: (text: string) => Promise<void>,
    threadKey?: string,
  ): Promise<void>;
}

// 멘션을 handleMention으로 흘린다. handleMention이 post로 직접 게시(ack·진행·결과·상태).
// 실패해도 상주를 죽이지 않는다.
export function bindMessenger(
  port: MessengerPort,
  orchestrator: MentionHandler,
  logger: { warn(msg: string, ctx?: string): void },
): void {
  port.onMention(async (e) => {
    const post = (text: string): Promise<void> => port.reply(e.target, text);
    const threadKey = e.threadId ?? e.channelId; // 스레드 우선, 없으면 채널
    try {
      // 지식 네임스페이스는 채널 유지(userId=channelId, 멀티플레이어).
      await orchestrator.handleMention({ text: e.text, userId: e.channelId }, post, threadKey);
    } catch (err) {
      logger.warn(`멘션 처리 실패: ${String(err)}`, 'Messenger');
      try { await post('지금 처리가 안 되네요 🙏'); } catch { /* post도 실패하면 포기 */ }
    }
  });
}
```

- [ ] **Step 4: Run bridge tests to verify they pass**

Run: `npx jest src/edge/messenger/messenger-bridge.spec.ts`
Expected: PASS (4 passing).

- [ ] **Step 5: Full suite + typecheck**

Run: `npx jest --runInBand`
Expected: 전체 PASS(신규 + 기존). (병렬 시 wiki-engine publishPage가 부하로 가끔 타임아웃 — `--runInBand`로 회피. 의심되면 `npx jest src/knowledge-core/wiki/wiki-engine.spec.ts` 단독 16/16 확인.)
Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/edge/messenger/messenger-bridge.ts src/edge/messenger/messenger-bridge.spec.ts
git commit -m "feat(phase6b1): bridge post/threadKey 모델 — handleMention 직접 게시"
```

---

## Self-Review

**Spec coverage (스펙 §4 ↔ 태스크):**
- §4.2 MentionTracker → Task 1. §4.3 handleMention post 모델 + launchCollaboration → Task 2. §4.4 formatStatus → Task 2(상대시간은 단순화로 생략 — 스펙 §4.4 "3분 전"은 비채택, 질문+팀만 표시). §4.5 bridge post/threadKey → Task 3. §4.6 흐름 → Task 2+3. §4.7 오류처리 → Task 2(백그라운드 try/catch)·Task 3(핸들러 try/catch). §4.8 테스트 → 각 스펙 + drainForTest(Task 2). §4.9 영향파일 — 트래커는 Orchestrator 내부 필드(스펙은 "module 주입" 언급했으나 내부 필드가 더 게으름: module·생성자·기존 위치 테스트 무영향 = 개선 deviation).
- 비범위(코딩·자가스케줄·영속·라이브개입) 미구현 확인. ✅

**Placeholder scan:** "TBD/적절히" 없음. 모든 코드 스텝 실제 코드 포함. ✅

**Type consistency:** `handleMention(msg, post, threadKey?)` → Task 2 정의·Task 3 MentionHandler·테스트 전부 일치. `MentionTracker.start/finish/status`·`TrackedTask`·`drainForTest()`·`launchCollaboration` 시그니처 Task 1·2·테스트 동일. 생성자 인자(conversations 2번째) 테스트 반영. ✅

**알아둘 점:** Task 2 단독에선 bridge가 옛 시그니처라 전체 tsc가 빨갈 수 있음(Step 6에 명시). Task 3까지 끝나야 전체 tsc 0. 태스크 순서(1→2→3) 준수 필요.
