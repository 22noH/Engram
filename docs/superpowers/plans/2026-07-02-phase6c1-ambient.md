# Phase 6c-1 ambient(선제 제안) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Engram이 먼저 말 건다 — 매일 아침 채널별 인사이트 요약·결재 대기 알림 게시(기본 켬) + opt-in 채널에서 대화 관찰 끼어들기(💡).

**Architecture:** ① 조용한 출구 = `AmbientService`(plain, main.ts 결선, ScheduleService 패턴) — 매일 cron으로 채널 순회, `orchestrator.insight(channelId, 어제)` 생성·게시 + `proposals.listPending` 알림. ② 끼어들기 = `MessengerPort.onMessage?`(옵셔널) → bridge가 observe opt-in 채널만 `orchestrator.observe`로 → 비용 사다리(짧음→쿨다운→RAG→두뇌 1콜) 통과 시 💡 게시. 정책은 6c-2의 `channel-policy.ts` 재사용.

**Tech Stack:** NestJS/TypeScript, Jest, discord.js(기존). **새 dep 0.** 스펙: `docs/superpowers/specs/2026-07-02-phase6c-ambient-permissions-design.md` §5.4~§5.7. **선행: 6c-2 플랜(channel-policy.ts) 완료 후 실행.**

## Global Constraints

- 셸은 PowerShell(이 머신은 Bash 도구 깨짐). 테스트: `npx jest <파일경로> --silent`.
- 새 의존성 추가 금지. 커밋 프리픽스 `feat(phase6c1):`. 공동 작업자(Co-Authored-By) 넣지 않음.
- observe 비용 사다리 순서 고정: ①짧은 메시지(trim < 10자) ②채널 쿨다운(기본 30분, `ENGRAM_AMBIENT_COOLDOWN_MIN`, in-memory) ③RAG 무결과 ④두뇌 interject=false — 전부 무음 스킵.
- ambient cron 기본 `0 8 * * *`(`ENGRAM_AMBIENT_CRON`, resolveCron 재사용). 관찰 메시지는 ConversationStore에 적재하지 않는다.
- 게시 문구: 인사이트 `☀️ 어제 이 채널: <report>` · 결재 `📋 위키 결재 대기 N건 — 터미널에서 engram review로 승인해줘` · 끼어들기 `💡 <text>`.
- PinoLogger엔 `info()` 없음(log/warn/error만). 상주 불사: 채널별/단계별 try/catch.
- `@Optional() rag?: RagStore`처럼 TS `?`가 붙은 트레일링 파라미터만 추가 — 기존 18인자 `new Orchestrator(...)` 테스트가 그대로 컴파일돼야 한다.

---

### Task 1: 관찰 이벤트 통로 — `MessengerPort.onMessage` + Fake + Discord

**Files:**
- Modify: `src/edge/messenger/messenger.port.ts` (onMessage 옵셔널 메서드)
- Modify: `src/edge/messenger/fake-messenger.ts` (onMessage + emitMessage 헬퍼)
- Modify: `src/edge/messenger/discord.adapter.ts` (shouldObserveMessage 순수함수 + onMessage + messageCreate 분기)
- Test: `src/edge/messenger/fake-messenger.spec.ts` · `src/edge/messenger/discord.adapter.spec.ts` (각각 테스트 추가)

**Interfaces:**
- Consumes: 기존 `MentionEvent`(text/channelId/threadId?/authorId/target) · 기존 shouldHandleMessage.
- Produces: `MessengerPort.onMessage?(handler: (e: MentionEvent) => Promise<void>): void`(비멘션·비봇 일반 메시지) · `FakeMessenger.emitMessage(e)` · `shouldObserveMessage(authorIsBot: boolean, isMentioned: boolean): boolean`. Task 3(bridge)이 onMessage를 바인딩.

- [ ] **Step 1: Write the failing tests**

`src/edge/messenger/fake-messenger.spec.ts`에 추가:

```ts
it('onMessage/emitMessage: 관찰 메시지 왕복(6c-1)', async () => {
  const m = new FakeMessenger();
  const seen: string[] = [];
  m.onMessage(async (e) => { seen.push(`${e.channelId}:${e.text}`); });
  await m.emitMessage({ text: '일반 대화', channelId: 'c1', authorId: 'u1', target: null });
  expect(seen).toEqual(['c1:일반 대화']);
});

it('onMessage 핸들러 없이 emitMessage → 무해', async () => {
  const m = new FakeMessenger();
  await expect(m.emitMessage({ text: 'x', channelId: 'c1', authorId: 'u1', target: null })).resolves.toBeUndefined();
});
```

`src/edge/messenger/discord.adapter.spec.ts`에 추가:

```ts
import { shouldObserveMessage } from './discord.adapter'; // 파일 상단 기존 import에 병합

it('shouldObserveMessage: 봇 아님+멘션 아님만 true', () => {
  expect(shouldObserveMessage(false, false)).toBe(true);
  expect(shouldObserveMessage(true, false)).toBe(false);  // 봇
  expect(shouldObserveMessage(false, true)).toBe(false);  // 멘션(onMention 몫)
  expect(shouldObserveMessage(true, true)).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/edge/messenger/fake-messenger.spec.ts src/edge/messenger/discord.adapter.spec.ts --silent`
Expected: FAIL — `onMessage`/`emitMessage`/`shouldObserveMessage` 미존재(TS 컴파일 에러)

- [ ] **Step 3: Write minimal implementation**

`src/edge/messenger/messenger.port.ts` — MessengerPort에 메서드 추가(onMention 아래):

```ts
  // 관찰(6c-1): 멘션이 아닌 일반 메시지 수신 — 옵셔널(어댑터가 지원할 때만). 정책 필터는 bridge 몫.
  onMessage?(handler: (e: MentionEvent) => Promise<void>): void;
```

`src/edge/messenger/fake-messenger.ts` — 필드·메서드 추가:

```ts
  private msgHandler?: (e: MentionEvent) => Promise<void>;

  onMessage(handler: (e: MentionEvent) => Promise<void>): void {
    this.msgHandler = handler;
  }

  // 테스트 헬퍼: 관찰(비멘션) 메시지 1건 주입.
  async emitMessage(e: MentionEvent): Promise<void> {
    if (this.msgHandler) await this.msgHandler(e);
  }
```

`src/edge/messenger/discord.adapter.ts`:

(a) 순수함수 추가(shouldHandleMessage 아래):

```ts
/** 관찰(6c-1) 대상인지: 봇이 아니고 멘션도 아닌 일반 메시지. */
export function shouldObserveMessage(authorIsBot: boolean, isMentioned: boolean): boolean {
  return !authorIsBot && !isMentioned;
}
```

(b) 클래스에 필드·메서드 추가:

```ts
  private msgHandler?: (e: MentionEvent) => Promise<void>;

  onMessage(handler: (e: MentionEvent) => Promise<void>): void {
    this.msgHandler = handler;
  }
```

(c) start()의 messageCreate 콜백을 분기 확장(기존 멘션 처리 뒤 return 유지):

```ts
    this.client.on(Events.MessageCreate, async (m: Message) => {
      // @everyone / 역할핑 / 답글멘션은 제외하고, 직접 @Engram 유저멘션만 처리(§4.2②)
      const isMentioned = !!this.client.user && m.mentions.has(this.client.user, {
        ignoreEveryone: true,
        ignoreRoles: true,
        ignoreRepliedUser: true,
      });
      if (shouldHandleMessage(m.author.bot, isMentioned)) {
        const text = stripMentionTokens(m.content);
        if (this.handler) await this.handler({
          text, channelId: m.channelId, authorId: m.author.id, target: m as ReplyTarget,
        });
        return;
      }
      // 관찰(6c-1): 비멘션 일반 메시지. 어댑터는 정책을 모른다(필터는 bridge).
      // ponytail: 네트워크 글루, 스모크만.
      if (shouldObserveMessage(m.author.bot, isMentioned) && this.msgHandler) {
        await this.msgHandler({
          text: m.content.trim(), channelId: m.channelId, authorId: m.author.id, target: m as ReplyTarget,
        });
      }
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/edge/messenger/fake-messenger.spec.ts src/edge/messenger/discord.adapter.spec.ts src/edge/messenger/messenger-bridge.spec.ts --silent`
Expected: PASS 전부(onMessage는 옵셔널이라 기존 소비자 무파손)

- [ ] **Step 5: Commit**

```powershell
git add src/edge/messenger/messenger.port.ts src/edge/messenger/fake-messenger.ts src/edge/messenger/discord.adapter.ts src/edge/messenger/fake-messenger.spec.ts src/edge/messenger/discord.adapter.spec.ts
git commit -m "feat(phase6c1): MessengerPort.onMessage 옵셔널 — 비멘션 관찰 이벤트 통로(Fake·Discord)"
```

---

### Task 2: `Orchestrator.observe` — 비용 사다리 끼어들기 (+RagStore 주입·insight date 패스스루·prompts/ambient.md)

**Files:**
- Modify: `src/agent-layer/orchestrator.ts` (RagStore 19번째 @Optional + observe + insight(date?) + AMBIENT_DEFAULT)
- Modify: `src/agent-layer/agent-layer.module.ts` (Orchestrator 팩토리 inject 19번째 정합)
- Create: `prompts/ambient.md`
- Test: `src/agent-layer/orchestrator-observe.spec.ts` (신규)

**Interfaces:**
- Consumes: `RagStore.search(query: string, limit?: number, userId?: string): Promise<SearchResult[]>`(SearchResult: slug·title·text·score) · 기존 `parseJsonBlock`·`loadPrompt`·`this.codeBrain` · `InsightReporter.run(userId, date?)`.
- Produces: `async observe(msg: CoreMessage, post: (text: string) => Promise<void>): Promise<void>` · `insight(userId?: string, date?: string)` · `protected now(): number`(테스트 seam). Task 3(bridge)·Task 4(AmbientService)가 소비.

- [ ] **Step 1: Write the failing test**

`src/agent-layer/orchestrator-observe.spec.ts`:

```ts
import { Orchestrator } from './orchestrator';

const logger = { warn() {}, error() {}, log() {} } as any;

// 생성자 19인자: (reader..paths, rag). rag 주입이 이 스펙의 핵심.
function orc(brainJson: string, hits: Array<{ slug: string; title: string; text: string; score: number }>) {
  let brainCalls = 0;
  const brain = { complete: async () => { brainCalls++; return { text: brainJson, costUsd: 0, isError: false }; } } as any;
  let ragCalls = 0;
  const rag = { search: async () => { ragCalls++; return hits; } } as any;
  const conversations = { append: async () => {} } as any;
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
    brain, null as any, null as any, { all: () => [] } as any, null as any,
    rag,
  ) as any;
  return { o, counts: { get brain() { return brainCalls; }, get rag() { return ragCalls; } } };
}

const HIT = [{ slug: 'rag-notes', title: 'RAG 노트', text: '마이그레이션은 …', score: 0.03 }];

it('통과: RAG 적중+interject=true → 💡 게시', async () => {
  const { o } = orc('{"interject":true,"text":"위키 rag-notes에 정리돼 있어요"}', HIT);
  const posts: string[] = [];
  await o.observe({ text: 'LanceDB 마이그레이션 어떻게 했더라?', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(posts).toEqual(['💡 위키 rag-notes에 정리돼 있어요']);
});

it('짧은 메시지(<10자) → RAG조차 미호출', async () => {
  const { o, counts } = orc('{"interject":true,"text":"x"}', HIT);
  await o.observe({ text: 'ㅇㅋ', userId: 'c1' }, async () => {});
  expect(counts.rag).toBe(0);
});

it('쿨다운: 게시 직후 두 번째 관찰은 스킵', async () => {
  const { o } = orc('{"interject":true,"text":"참고하세요"}', HIT);
  const posts: string[] = [];
  const post = async (t: string) => { posts.push(t); };
  await o.observe({ text: '마이그레이션 질문입니다', userId: 'c1' }, post);
  await o.observe({ text: '마이그레이션 추가 질문입니다', userId: 'c1' }, post);
  expect(posts).toHaveLength(1);
});

it('쿨다운이 지나면 다시 게시(now seam)', async () => {
  const { o } = orc('{"interject":true,"text":"참고"}', HIT);
  let t = 1_000_000; o.now = () => t;
  const posts: string[] = [];
  await o.observe({ text: '마이그레이션 질문입니다', userId: 'c1' }, async (x: string) => { posts.push(x); });
  t += 31 * 60_000; // 31분 경과
  await o.observe({ text: '마이그레이션 재질문입니다', userId: 'c1' }, async (x: string) => { posts.push(x); });
  expect(posts).toHaveLength(2);
});

it('RAG 무결과 → 두뇌 미호출', async () => {
  const { o, counts } = orc('{"interject":true,"text":"x"}', []);
  await o.observe({ text: '위키에 없는 주제 이야기입니다', userId: 'c1' }, async () => {});
  expect(counts.brain).toBe(0);
});

it('interject=false → 게시 없음 + 쿨다운 미기록(다음 관찰이 다시 RAG 도달)', async () => {
  const { o, counts } = orc('{"interject":false,"text":""}', HIT);
  await o.observe({ text: '마이그레이션 질문입니다', userId: 'c1' }, async () => {});
  await o.observe({ text: '마이그레이션 재질문입니다', userId: 'c1' }, async () => {});
  expect(counts.rag).toBe(2);
});

it('두뇌 throw → 무음(게시 0, 예외 전파 없음)', async () => {
  const { o } = orc('irrelevant', HIT);
  o.codeBrain = { complete: async () => { throw new Error('boom'); } };
  const posts: string[] = [];
  await expect(o.observe({ text: '마이그레이션 질문입니다', userId: 'c1' }, async (t: string) => { posts.push(t); })).resolves.toBeUndefined();
  expect(posts).toHaveLength(0);
});

it('rag 미주입(18인자 구식) → 무음 no-op', async () => {
  const conversations = { append: async () => {} } as any;
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
  ) as any;
  await expect(o.observe({ text: '마이그레이션 질문입니다', userId: 'c1' }, async () => {})).resolves.toBeUndefined();
});

it('insight(userId, date) → reporter.run에 date 패스스루', async () => {
  const conversations = { append: async () => {} } as any;
  const seen: any = {};
  const reporter = { run: async (u: string, d?: string) => { seen.u = u; seen.d = d; return null; } } as any;
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
    null as any, null as any, reporter, null as any, null as any,
  );
  await o.insight('c1', '2026-07-01');
  expect(seen).toEqual({ u: 'c1', d: '2026-07-01' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/agent-layer/orchestrator-observe.spec.ts --silent`
Expected: FAIL — `observe` 미존재(TS 에러) 또는 19번째 인자 초과

- [ ] **Step 3: Write minimal implementation**

(a) `src/agent-layer/orchestrator.ts` import 추가:

```ts
import { RagStore } from '../knowledge-core/rag/rag-store';
```

(b) 생성자 19번째(끝에, TS `?` 필수 — 기존 18인자 호출 호환):

```ts
    @Optional() private readonly rag?: RagStore,
```

(c) `insight`에 date 패스스루(기존 메서드 교체):

```ts
  // 일일 인사이트 생성(설계 §5.4). date 생략=오늘(기존), 지정=그 날(ambient가 어제를 넘김).
  insight(userId: string = DEFAULT_USER, date?: string): Promise<DayInsight | null> {
    if (!this.reporter) throw new Error('InsightReporter 미주입(Orchestrator)');
    return this.reporter.run(userId, date);
  }
```

(d) 내장 기본 프롬프트 상수(TRIAGE_DEFAULT 근처):

```ts
// prompts/ambient.md 없을 때의 내장 기본값. JSON 계약은 observe()가 코드에서 덧붙인다.
const AMBIENT_DEFAULT = [
  '대화 메시지와 위키 발췌가 주어진다. 위키 정보가 이 대화에 실질적으로 도움이 될 때만 끼어들어라.',
  '확실하지 않으면 끼어들지 마라 — interject=false가 기본값이다.',
  '끼어들 땐 한두 문장으로 요점만, 근거 위키 페이지(slug)를 함께 밝혀라.',
].join('\n');
```

(e) observe 메서드 + 쿨다운 필드 + now seam(formatStatus 근처에 추가):

```ts
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
      const last = this.observeCooldown.get(msg.userId) ?? 0;
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
```

(f) `src/agent-layer/agent-layer.module.ts` — Orchestrator provider의 useFactory 파라미터·inject 배열 끝에 `RagStore`를 19번째로 추가(6b-2에서 PathResolver를 18번째로 추가한 것과 동일한 수술 — 파일을 열어 기존 18개 나열을 보고 같은 자리 규칙으로 붙인다. RagStore는 KnowledgeCoreModule이 export하며 같은 모듈의 ReaderAgent가 이미 주입받고 있어 토큰 해석 가능). 팩토리 파라미터가 옵셔널 취급이 되도록 기존 @Optional 협력자들과 같은 방식(모듈이 `useFactory`+`inject`면 inject 배열에 `{ token: RagStore, optional: true }` 패턴이 기존에 쓰였는지 확인해 그대로 따른다).

(g) `prompts/ambient.md` 생성(내장 기본값과 동일 내용):

```markdown
대화 메시지와 위키 발췌가 주어진다. 위키 정보가 이 대화에 실질적으로 도움이 될 때만 끼어들어라.
확실하지 않으면 끼어들지 마라 — interject=false가 기본값이다.
끼어들 땐 한두 문장으로 요점만, 근거 위키 페이지(slug)를 함께 밝혀라.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/agent-layer/orchestrator-observe.spec.ts src/agent-layer/agent-layer.module.spec.ts src/app.module.spec.ts --silent`
Expected: PASS 전부(모듈 DI 19/19 정합 포함)

- [ ] **Step 5: Commit**

```powershell
git add src/agent-layer/orchestrator.ts src/agent-layer/agent-layer.module.ts src/agent-layer/orchestrator-observe.spec.ts prompts/ambient.md
git commit -m "feat(phase6c1): Orchestrator.observe — 비용사다리(짧음·쿨다운·RAG·두뇌) 끼어들기 + insight date 패스스루"
```

---

### Task 3: bridge observe 바인딩(정책 필터)

**Files:**
- Modify: `src/edge/messenger/messenger-bridge.ts` (MentionHandler.observe 옵셔널 + bindMessenger policy 파라미터 + onMessage 바인딩)
- Test: `src/edge/messenger/messenger-bridge.spec.ts` (테스트 추가)

**Interfaces:**
- Consumes: Task 1 `port.onMessage?` · Task 2 `orchestrator.observe` · 6c-2 `ChannelPolicy`/`allows`.
- Produces: `bindMessenger(port, orchestrator, logger, policy?: ChannelPolicy)` — policy 생략 시 observe 미바인딩(기존 호출 호환). Task 4(main.ts)가 policy를 넘긴다.

- [ ] **Step 1: Write the failing test**

`src/edge/messenger/messenger-bridge.spec.ts`에 추가:

```ts
// 기존 import에 병합: FakeMessenger·bindMessenger는 이미 있음.
const OBS_POLICY = { channels: { obs: { observe: true } } } as any; // obs 채널만 opt-in

it('observe opt-in 채널의 일반 메시지 → orchestrator.observe(postToChannel 경유)', async () => {
  const port = new FakeMessenger();
  const seen: string[] = [];
  const orchestrator = {
    handleMention: async () => {},
    observe: async (msg: any, post: any) => { seen.push(msg.userId + ':' + msg.text); await post('💡 힌트'); },
  };
  bindMessenger(port, orchestrator as any, { warn() {} } as any, OBS_POLICY);
  await port.emitMessage({ text: '일반 대화', channelId: 'obs', authorId: 'u1', target: null });
  expect(seen).toEqual(['obs:일반 대화']);
  expect(port.channelPosts).toEqual([{ channelId: 'obs', threadId: undefined, text: '💡 힌트' }]);
});

it('opt-in 아닌 채널 → observe 미호출', async () => {
  const port = new FakeMessenger();
  let called = false;
  const orchestrator = { handleMention: async () => {}, observe: async () => { called = true; } };
  bindMessenger(port, orchestrator as any, { warn() {} } as any, OBS_POLICY);
  await port.emitMessage({ text: '일반 대화', channelId: 'other', authorId: 'u1', target: null });
  expect(called).toBe(false);
});

it('policy 미전달(기존 호출) → onMessage 미바인딩·무파손', async () => {
  const port = new FakeMessenger();
  let called = false;
  const orchestrator = { handleMention: async () => {}, observe: async () => { called = true; } };
  bindMessenger(port, orchestrator as any, { warn() {} } as any);
  await port.emitMessage({ text: '일반 대화', channelId: 'obs', authorId: 'u1', target: null });
  expect(called).toBe(false);
});

it('observe가 throw해도 상주 불사(warn 로그)', async () => {
  const port = new FakeMessenger();
  const warns: string[] = [];
  const orchestrator = { handleMention: async () => {}, observe: async () => { throw new Error('boom'); } };
  bindMessenger(port, orchestrator as any, { warn(m: string) { warns.push(m); } } as any, OBS_POLICY);
  await port.emitMessage({ text: '일반 대화', channelId: 'obs', authorId: 'u1', target: null });
  expect(warns.length).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/edge/messenger/messenger-bridge.spec.ts --silent`
Expected: FAIL — bindMessenger가 4번째 인자를 모르거나 observe 미바인딩

- [ ] **Step 3: Write minimal implementation**

`src/edge/messenger/messenger-bridge.ts` 전체 교체:

```ts
import { MessengerPort } from './messenger.port';
import { CoreMessage } from '../core-message';
import { ChannelPolicy, allows } from '../../agent-layer/channel-policy';

// Orchestrator를 구조적 타입으로만 의존(순환 import 회피·테스트 용이).
export interface MentionHandler {
  handleMention(
    msg: CoreMessage,
    post: (text: string) => Promise<void>,
    threadKey?: string,
  ): Promise<void>;
  // 관찰 끼어들기(6c-1) — 옵셔널(구식 스텁 호환).
  observe?(msg: CoreMessage, post: (text: string) => Promise<void>): Promise<void>;
}

// 멘션을 handleMention으로 흘린다. handleMention이 post로 직접 게시(ack·진행·결과·상태).
// 실패해도 상주를 죽이지 않는다. policy가 있으면 observe opt-in 채널의 일반 메시지도 observe로 흘린다.
export function bindMessenger(
  port: MessengerPort,
  orchestrator: MentionHandler,
  logger: { warn(msg: string, ctx?: string): void },
  policy?: ChannelPolicy,
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

  // 관찰(6c-1): 포트·정책·observe 셋 다 있을 때만 바인딩. opt-in 채널만 통과.
  if (port.onMessage && orchestrator.observe && policy) {
    port.onMessage(async (e) => {
      if (!allows(policy, e.channelId, 'observe')) return;
      try {
        await orchestrator.observe!(
          { text: e.text, userId: e.channelId },
          (text) => port.postToChannel(e.channelId, text, e.threadId),
        );
      } catch (err) {
        logger.warn(`관찰 처리 실패: ${String(err)}`, 'Messenger');
      }
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/edge/messenger/messenger-bridge.spec.ts --silent`
Expected: PASS 전부(기존 멘션 테스트 회귀 0)

- [ ] **Step 5: Commit**

```powershell
git add src/edge/messenger/messenger-bridge.ts src/edge/messenger/messenger-bridge.spec.ts
git commit -m "feat(phase6c1): bridge observe 바인딩 — opt-in 채널의 일반 메시지만 observe로(정책 필터)"
```

---

### Task 4: `AmbientService`(조용한 출구) + main.ts 결선

**Files:**
- Create: `src/edge/ambient-service.ts`
- Modify: `src/main.ts` (policy 로드·bindMessenger에 전달·AmbientService 결선)
- Test: `src/edge/ambient-service.spec.ts` (신규)

**Interfaces:**
- Consumes: Task 2 `orchestrator.insight(userId, date?)` · `MessengerPort.postToChannel` · `SchedulerRegistry` · `ProposalStore.listPending(userId?)` · 6c-2 `ChannelPolicy`/`allows` · `resolveCron`(edge/digest.scheduler export) · `DEFAULT_USER`.
- Produces: `class AmbientService { start(): void; tick(): Promise<void> }` — main.ts 전용, DI 밖 plain.

- [ ] **Step 1: Write the failing test**

`src/edge/ambient-service.spec.ts`:

```ts
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { AmbientService } from './ambient-service';
import { FakeMessenger } from './messenger/fake-messenger';
import { DEFAULT_USER } from '../pal/path-resolver';

const logger = { warn() {}, log() {} } as any;
const OPEN = { channels: {} } as any; // 기본값 = ambient 허용

// 채널 디렉토리 셋업: state/conversations/{channelId}/
function tmpRoot(...channels: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-amb-'));
  for (const c of channels) fs.mkdirSync(path.join(root, c), { recursive: true });
  return root;
}

function svc(opts: {
  root: string;
  insight?: (u: string, d?: string) => Promise<any>;
  pending?: (u?: string) => Promise<any[]>;
  policy?: any;
}) {
  const port = new FakeMessenger();
  const calls: Array<[string, string?]> = [];
  const orchestrator = { insight: async (u: string, d?: string) => { calls.push([u, d]); return opts.insight ? opts.insight(u, d) : null; } };
  const proposals = { listPending: opts.pending ?? (async () => []) } as any;
  const registry = { addCronJob() {}, deleteCronJob() {} } as any;
  const s = new AmbientService(orchestrator as any, port, registry, proposals, opts.policy ?? OPEN, opts.root, logger) as any;
  s.yesterday = () => '2026-07-01';
  s.makeJob = () => ({ start() {}, stop() {} });
  return { s, port, calls };
}

it('인사이트 있는 채널만 ☀️ 게시(어제 날짜로 호출)', async () => {
  const root = tmpRoot('c1', 'c2');
  const { s, port, calls } = svc({
    root,
    insight: async (u) => (u === 'c1' ? { date: '2026-07-01', report: '어제는 RAG 얘기가 많았어요' } : null),
  });
  await s.tick();
  expect(calls).toEqual(expect.arrayContaining([['c1', '2026-07-01'], ['c2', '2026-07-01']]));
  const suns = port.channelPosts.filter((p) => p.text.startsWith('☀️'));
  expect(suns).toEqual([{ channelId: 'c1', threadId: undefined, text: '☀️ 어제 이 채널: 어제는 RAG 얘기가 많았어요' }]);
});

it('결재 대기>0 채널만 📋 게시', async () => {
  const root = tmpRoot('c1', 'c2');
  const { s, port } = svc({ root, pending: async (u) => (u === 'c2' ? [{}, {}, {}] : []) });
  await s.tick();
  const notes = port.channelPosts.filter((p) => p.text.startsWith('📋'));
  expect(notes).toEqual([{ channelId: 'c2', threadId: undefined, text: '📋 위키 결재 대기 3건 — 터미널에서 engram review로 승인해줘' }]);
});

it('ambient=false 채널은 스킵(insight 미호출)', async () => {
  const root = tmpRoot('c1');
  const { s, port, calls } = svc({ root, policy: { channels: { c1: { ambient: false } } } });
  await s.tick();
  expect(calls).toHaveLength(0);
  expect(port.channelPosts).toHaveLength(0);
});

it('DEFAULT_USER 디렉토리는 채널이 아님(제외)', async () => {
  const root = tmpRoot(DEFAULT_USER, 'c1');
  const { s, calls } = svc({ root });
  await s.tick();
  expect(calls.map(([u]) => u)).toEqual(['c1']);
});

it('한 채널이 throw해도 나머지 진행(상주 불사)', async () => {
  const root = tmpRoot('bad', 'good');
  const { s, calls } = svc({
    root,
    insight: async (u) => { if (u === 'bad') throw new Error('boom'); return null; },
  });
  await expect(s.tick()).resolves.toBeUndefined();
  expect(calls.map(([u]) => u).sort()).toEqual(['bad', 'good']);
});

it('conversations 루트 없음 → 무동작 no-throw', async () => {
  const { s, port } = svc({ root: path.join(os.tmpdir(), 'engram-amb-none-여기없음') });
  await expect(s.tick()).resolves.toBeUndefined();
  expect(port.channelPosts).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/edge/ambient-service.spec.ts --silent`
Expected: FAIL — `Cannot find module './ambient-service'`

- [ ] **Step 3: Write minimal implementation**

`src/edge/ambient-service.ts`:

```ts
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import * as fs from 'fs';
import { MessengerPort } from './messenger/messenger.port';
import { ChannelPolicy, allows } from '../agent-layer/channel-policy';
import { ProposalStore } from '../knowledge-core/proposal-store';
import { resolveCron } from './digest.scheduler';
import { DEFAULT_USER } from '../pal/path-resolver';

// 인사이트 실행자(Orchestrator 구조적 타입 — 순환 회피).
interface InsightRunner {
  insight(userId: string, date?: string): Promise<{ date: string; report: string } | null>;
}

// ambient 조용한 출구(6c-1, plain — main.ts 결선): 매일 아침 채널마다
// ① 어제 인사이트 생성·요약 게시 ② 위키 결재 대기 알림. 채널별 실패 격리(상주 불사).
// 인사이트 생성은 reporter가 대화 없으면 null(두뇌 미호출)이라 사전 파일검사 불요.
export class AmbientService {
  constructor(
    private readonly orchestrator: InsightRunner,
    private readonly port: MessengerPort,
    private readonly registry: SchedulerRegistry,
    private readonly proposals: ProposalStore,
    private readonly policy: ChannelPolicy,
    private readonly conversationsRoot: string, // {data}/state/conversations
    private readonly logger: { warn(msg: string, ctx?: string): void },
  ) {}

  start(): void {
    const cron = resolveCron(process.env.ENGRAM_AMBIENT_CRON, '0 8 * * *');
    const job = this.makeJob(cron, () => { void this.tick(); });
    this.registry.addCronJob('ambient', job as unknown as CronJob);
    job.start();
  }

  async tick(): Promise<void> {
    for (const channelId of this.channels()) {
      if (!allows(this.policy, channelId, 'ambient')) continue;
      try {
        const ins = await this.orchestrator.insight(channelId, this.yesterday());
        if (ins?.report) await this.port.postToChannel(channelId, `☀️ 어제 이 채널: ${ins.report}`);
        const pending = await this.proposals.listPending(channelId);
        if (pending.length > 0) {
          await this.port.postToChannel(channelId, `📋 위키 결재 대기 ${pending.length}건 — 터미널에서 engram review로 승인해줘`);
        }
      } catch (err) {
        this.logger.warn(`ambient 실패(스킵) ${channelId}: ${String(err)}`, 'Ambient');
      }
    }
  }

  // 채널 목록 = 대화 디렉토리명(userId=channelId). CLI 사용자(DEFAULT_USER)는 채널이 아님.
  private channels(): string[] {
    try {
      return fs.readdirSync(this.conversationsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name).filter((n) => n !== DEFAULT_USER);
    } catch {
      return []; // 루트 없음 = 대화 이력 없음
    }
  }

  // 테스트 seam(결정적 날짜·실 타이머 회피).
  protected yesterday(): string {
    return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  }
  protected makeJob(cron: string, onTick: () => void): { start(): void; stop(): void } {
    return new CronJob(cron, onTick) as unknown as { start(): void; stop(): void };
  }
}
```

`src/main.ts` — import 추가 후 `if (port) {` 블록을 다음으로 교체:

```ts
import { loadChannelPolicy } from './agent-layer/channel-policy';
import { AmbientService } from './edge/ambient-service';
import { ProposalStore } from './knowledge-core/proposal-store';
import * as path from 'path';
```

```ts
  if (port) {
    const orchestrator = app.get(Orchestrator);
    const policy = loadChannelPolicy(paths.getConfigDir());
    bindMessenger(port, orchestrator, logger, policy);
    const store = new ScheduleStore(paths.getConfigDir());
    const scheduler = new ScheduleService(orchestrator, port, app.get(SchedulerRegistry), store, logger);
    orchestrator.setScheduler(scheduler);
    scheduler.start();
    const ambient = new AmbientService(
      orchestrator, port, app.get(SchedulerRegistry), app.get(ProposalStore), policy,
      path.join(paths.getDataDir(), 'state', 'conversations'), logger,
    );
    ambient.start();
    await port.start();
    logger.log(`메신저 가동: ${cfg.provider}`, 'Messenger');
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/edge/ambient-service.spec.ts --silent; npx tsc --noEmit`
Expected: PASS 전부 + tsc 에러 0(main.ts 결선 타입 포함)

- [ ] **Step 5: Commit**

```powershell
git add src/edge/ambient-service.ts src/edge/ambient-service.spec.ts src/main.ts
git commit -m "feat(phase6c1): AmbientService — 매일 채널별 인사이트 요약·결재 대기 알림 게시 + main 결선"
```

---

### Task 5: 전체 검증 + README 안내

**Files:**
- Modify: `README.md` (채널 설정·ambient 안내 — 운영 섹션에 추가)

- [ ] **Step 1: 전체 테스트**

Run: `npm test -- --silent`
Expected: 0 fail (2 skip은 opt-in 임베더)

- [ ] **Step 2: 타입체크·빌드**

Run: `npx tsc --noEmit; npm run build`
Expected: 에러 0

- [ ] **Step 3: README 안내 추가**

README.md의 운영/설정 안내 부근에 추가:

```markdown
### 채널 설정 (`runtime/config/channels.json`, Phase 6c)

채널별로 능력을 잠그거나 관찰을 켠다. 없으면 전부 기본값(명령 허용, 끼어들기 꺼짐).

```json
{ "채널ID": { "coding": false, "observe": true } }
```

- `coding`/`schedule`/`collaborate`: 기본 `true` — `false`면 그 채널에서 해당 명령 차단.
- `ambient`: 기본 `true` — 매일 아침(기본 8시, `ENGRAM_AMBIENT_CRON`) 인사이트 요약·위키 결재 대기 알림 게시.
- `observe`: 기본 `false` — `true`면 일반 대화를 관찰해 위키에 관련 정보가 있을 때 💡로 끼어든다(채널당 기본 30분 쿨다운, `ENGRAM_AMBIENT_COOLDOWN_MIN`).

변경은 재시작 시 반영된다.
```

- [ ] **Step 4: Commit**

```powershell
git add README.md
git commit -m "docs(phase6c1): README — channels.json·ambient 설정 안내"
```
