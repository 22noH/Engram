# Phase 6a — Tag(`@Engram` 동료) 메신저 seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 메신저에서 `@Engram <일>`을 멘션하면 Engram이 chat/팀협업을 스스로 분류·로스터 선택해 수행하고 그 자리에 답하게 한다(첫 어댑터 Discord, 포트로 갈아끼움).

**Architecture:** Edge에 `MessengerPort` 포트 + Discord 어댑터를 추가하고, 상주(`main.ts`)가 멘션을 `Orchestrator.handleMention()`(triage 두뇌 1콜 → 기존 `route`/`collaborate` 디스패치)로 흘린 뒤 답을 메신저에 게시한다. 코어(`CoreMessage`)·CLI는 무변경.

**Tech Stack:** Node 22 · NestJS · TypeScript · jest(ts-jest) · discord.js(신규)

## Global Constraints

- 새 의존성은 `discord.js` 하나만 추가(메신저 게이트웨이 SDK — 직접 구현 비현실적, 로드맵 §11 명시 선택).
- 코어 중립성: `src/edge/core-message.ts`의 `CoreMessage`는 무변경. 채널 ID는 `userId` 네임스페이스로만 흐르고, 답신 경로(`ReplyTarget`)는 코어를 통과하지 않는다.
- 상주를 절대 죽이지 않는다: 모든 멘션 처리는 try/catch로 감싸고 실패 시 사과 메시지+로그.
- 분류 실패/팀 비정상은 막다른 길 없이 폴백(chat / `[Manager]`).
- 프롬프트는 `prompts/triage.md`로 외부화하되 내장 기본값 동봉(파일 없을 때 동작).
- 테스트는 기존 패턴 사용: `FakeBrain`/`FakeEmbedder`처럼 `FakeMessenger`, 단위테스트는 jest `it()` + 생성자 직접 주입.
- 결정론 유지: 테스트에서 실 네트워크/실 claude 호출 금지(Fake 사용). Discord 어댑터 네트워크 글루는 스모크만.

---

## File Structure

- 신규 `src/edge/messenger/messenger.port.ts` — `MentionEvent`·`ReplyTarget`·`MessengerPort`·`MessengerConfig` 타입.
- 신규 `src/edge/messenger/fake-messenger.ts` — 테스트용 더블(+`fake-messenger.spec.ts`).
- 신규 `src/edge/messenger/messenger-bridge.ts` — `bindMessenger(port, orchestrator, logger)` 결선 함수(+`messenger-bridge.spec.ts`).
- 신규 `src/edge/messenger/messenger.config.ts` — `loadMessengerConfig(configDir)`(+`messenger.config.spec.ts`).
- 신규 `src/edge/messenger/messenger.factory.ts` — `createMessenger(cfg)`(+`messenger.factory.spec.ts`).
- 신규 `src/edge/messenger/discord.adapter.ts` — discord.js 어댑터(스모크 `discord.adapter.spec.ts`).
- 신규 `prompts/triage.md` — triage 프롬프트.
- 수정 `src/agent-layer/orchestrator.ts` — `handleMention()`+`classify()` 추가, `PersonaRegistry` 옵셔널 주입.
- 신규 `src/agent-layer/orchestrator-handle-mention.spec.ts` — triage 단위테스트.
- 수정 `src/agent-layer/agent-layer.module.ts` — Orchestrator 팩토리에 `PersonaRegistry` 주입 추가.
- 수정 `src/main.ts` — 메신저 결선(설정 로드 → 팩토리 → bind → start).
- 수정 `package.json` — `discord.js` 의존성.

---

## Task 1: MessengerPort 타입 + FakeMessenger

**Files:**
- Create: `src/edge/messenger/messenger.port.ts`
- Create: `src/edge/messenger/fake-messenger.ts`
- Test: `src/edge/messenger/fake-messenger.spec.ts`

**Interfaces:**
- Produces:
  - `interface MentionEvent { text: string; channelId: string; threadId?: string; authorId: string; target: ReplyTarget }`
  - `type ReplyTarget = unknown` (어댑터별 불투명 핸들)
  - `interface MessengerPort { onMention(h: (e: MentionEvent) => Promise<void>): void; reply(target: ReplyTarget, text: string): Promise<void>; start(): Promise<void>; stop(): Promise<void> }`
  - `interface MessengerConfig { provider?: string; token?: string; engramName?: string }`
  - `class FakeMessenger implements MessengerPort` + 테스트 헬퍼 `emit(e: MentionEvent): Promise<void>`, 필드 `replies: Array<{ target: ReplyTarget; text: string }>`

- [ ] **Step 1: Write the failing test**

`src/edge/messenger/fake-messenger.spec.ts`:
```ts
import { FakeMessenger } from './fake-messenger';
import { MentionEvent } from './messenger.port';

it('emit가 등록된 핸들러를 부르고 reply가 캡처된다', async () => {
  const m = new FakeMessenger();
  m.onMention(async (e: MentionEvent) => { await m.reply(e.target, `echo:${e.text}`); });
  await m.emit({ text: '안녕', channelId: 'c1', authorId: 'u1', target: { ch: 'c1' } });
  expect(m.replies).toEqual([{ target: { ch: 'c1' }, text: 'echo:안녕' }]);
});

it('핸들러 미등록이면 emit는 조용히 통과', async () => {
  const m = new FakeMessenger();
  await expect(m.emit({ text: 'x', channelId: 'c', authorId: 'u', target: null })).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/edge/messenger/fake-messenger.spec.ts`
Expected: FAIL — `Cannot find module './fake-messenger'` / `./messenger.port`.

- [ ] **Step 3: Write the port types**

`src/edge/messenger/messenger.port.ts`:
```ts
// 앞단 중립 메신저 포트(설계 §9 / Phase 6a). 어댑터(Discord 등)가 구현하고,
// 코어는 채널 ID·답신 핸들 등 메신저 특유의 것을 모른다(CoreMessage 중립성 연장).

// 답신 경로 — 어댑터별 불투명 핸들. 코어를 통과하지 않고 어댑터↔bridge만 주고받는다.
export type ReplyTarget = unknown;

export interface MentionEvent {
  text: string;        // @Engram 멘션 토큰을 떼어낸 본문
  channelId: string;   // 방 식별자(맥락 네임스페이스로 쓰임)
  threadId?: string;   // 스레드(있으면)
  authorId: string;    // 보낸 사람
  target: ReplyTarget; // reply가 되돌려줄 핸들
}

export interface MessengerPort {
  onMention(handler: (e: MentionEvent) => Promise<void>): void;
  reply(target: ReplyTarget, text: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface MessengerConfig {
  provider?: string;   // 'discord' 등. 없으면 메신저 비활성.
  token?: string;      // 봇 토큰(env 우선).
  engramName?: string; // 표시 이름(기본 'Engram').
}
```

- [ ] **Step 4: Write the FakeMessenger**

`src/edge/messenger/fake-messenger.ts`:
```ts
import { MessengerPort, MentionEvent, ReplyTarget } from './messenger.port';

// 결정론적 가짜 메신저(FakeBrain/FakeEmbedder와 같은 역할). 멘션 주입·답 캡처용.
export class FakeMessenger implements MessengerPort {
  private handler?: (e: MentionEvent) => Promise<void>;
  readonly replies: Array<{ target: ReplyTarget; text: string }> = [];

  onMention(handler: (e: MentionEvent) => Promise<void>): void {
    this.handler = handler;
  }
  async reply(target: ReplyTarget, text: string): Promise<void> {
    this.replies.push({ target, text });
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  // 테스트 헬퍼: 멘션 1건 주입.
  async emit(e: MentionEvent): Promise<void> {
    if (this.handler) await this.handler(e);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/edge/messenger/fake-messenger.spec.ts`
Expected: PASS (2 passing).

- [ ] **Step 6: Commit**

```bash
git add src/edge/messenger/messenger.port.ts src/edge/messenger/fake-messenger.ts src/edge/messenger/fake-messenger.spec.ts
git commit -m "feat(phase6a): MessengerPort 타입 + FakeMessenger"
```

---

## Task 2: Orchestrator.handleMention (triage)

**Files:**
- Modify: `src/agent-layer/orchestrator.ts` (생성자에 `PersonaRegistry` 옵셔널 추가, `handleMention`/`classify` 추가)
- Create: `prompts/triage.md`
- Test: `src/agent-layer/orchestrator-handle-mention.spec.ts`

**Interfaces:**
- Consumes: 기존 `route(msg, onChunk?)`, `collaborate(question, personas[], userId, opts?)`, `loadPrompt(name, default)`, `parseJsonBlock<T>(text)`, `PersonaRegistry.all()`, `@Inject(BRAIN) codeBrain`.
- Produces:
  - `handleMention(msg: CoreMessage, onAck?: (t: string) => Promise<void>): Promise<string>`
  - private `classify(text: string): Promise<{ kind: 'chat' | 'collaborate'; team: string[] }>`

- [ ] **Step 1: Write the failing test**

`src/agent-layer/orchestrator-handle-mention.spec.ts`:
```ts
import { Orchestrator } from './orchestrator';

const logger = { warn() {}, error() {}, info() {} } as any;

// route/collaborate를 가짜로 덮어 어느 경로로 갔는지만 관측한다.
function orc(brainText: string, registryNames: string[] = ['Manager', 'Infra']) {
  const brain = { complete: async () => ({ text: brainText, costUsd: 0, isError: false }) } as any;
  const registry = { all: () => registryNames.map((name) => ({ name, role: 'r', brain: 'claude', tools: [], invocation: ['summon'], prompt: '' })) } as any;
  // 생성자: (reader, conversations, logger, ingester, tasks, specialist, synth, sem, projects, gate, codingGit, coder, reviewer, codeBrain, fence, reporter, registry)
  const o = new Orchestrator(
    null as any, null as any, logger, null as any,
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
    brain, null as any, null as any, registry,
  );
  return o;
}

it('분류 collaborate → collaborate(team)로 디스패치', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager","Infra"]}');
  const calls: any[] = [];
  (o as any).collaborate = async (q: string, team: string[]) => { calls.push({ q, team }); return '종합'; };
  const out = await o.handleMention({ text: '서버 비용 줄여줘', userId: 'c1' });
  expect(out).toBe('종합');
  expect(calls[0].team).toEqual(['Manager', 'Infra']);
});

it('분류 chat → route로 디스패치', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  (o as any).route = async () => '즉답';
  const out = await o.handleMention({ text: '엔그램이 뭐야?', userId: 'c1' });
  expect(out).toBe('즉답');
});

it('분류 응답이 깨지면 chat 폴백', async () => {
  const o = orc('이건 JSON이 아님');
  let routed = false;
  (o as any).route = async () => { routed = true; return 'r'; };
  await o.handleMention({ text: 'x', userId: 'c1' });
  expect(routed).toBe(true);
});

it('collaborate인데 team이 비면 [Manager] 폴백', async () => {
  const o = orc('{"kind":"collaborate","team":[]}');
  let used: string[] = [];
  (o as any).collaborate = async (_q: string, team: string[]) => { used = team; return 'x'; };
  await o.handleMention({ text: 'x', userId: 'c1' });
  expect(used).toEqual(['Manager']);
});

it('collaborate면 onAck로 처리중 메시지 1회', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager"]}');
  (o as any).collaborate = async () => '결과';
  const acks: string[] = [];
  await o.handleMention({ text: 'x', userId: 'c1' }, async (t) => { acks.push(t); });
  expect(acks.length).toBe(1);
});

it('escape hatch "team a,b 질문" → 분류 스킵·직접 collaborate', async () => {
  const o = orc('{"kind":"chat","team":[]}'); // 분류가 chat이어도 무시돼야 함
  const calls: any[] = [];
  (o as any).collaborate = async (q: string, team: string[]) => { calls.push({ q, team }); return 'x'; };
  await o.handleMention({ text: 'team Brand,Trend 런칭 전략?', userId: 'c1' });
  expect(calls[0]).toEqual({ q: '런칭 전략?', team: ['Brand', 'Trend'] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/agent-layer/orchestrator-handle-mention.spec.ts`
Expected: FAIL — `o.handleMention is not a function` (또는 생성자 인자 수 불일치 컴파일 에러).

- [ ] **Step 3: Add PersonaRegistry import + constructor param**

`src/agent-layer/orchestrator.ts` — import 추가(기존 import 블록 끝):
```ts
import { PersonaRegistry } from './persona-registry';
```

생성자 마지막 옵셔널 인자 추가(기존 `@Optional() private readonly reporter?: InsightReporter,` 바로 뒤):
```ts
    @Optional() private readonly registry?: PersonaRegistry,
```

- [ ] **Step 4: Add triage 프롬프트 기본값 상수**

`src/agent-layer/orchestrator.ts` — 파일 상단 상수 영역(`DECOMPOSE_DEFAULT` 근처)에 추가:
```ts
// prompts/triage.md 없을 때의 내장 기본값. JSON 계약은 classify()가 코드에서 덧붙인다.
const TRIAGE_DEFAULT = [
  '사용자 메시지가 (1) 단순 질문/잡담인지 "chat", (2) 여러 전문가가 머리를 맞대야 하는 일인지 "collaborate"인지 판정하라.',
  'collaborate면 아래 전문가 목록에서 이 일에 꼭 필요한 사람만 골라 team에 이름을 넣어라(없으면 빈 배열).',
  '확실치 않으면 chat을 택하라.',
].join('\n');
```

- [ ] **Step 5: Add handleMention + classify 메서드**

`src/agent-layer/orchestrator.ts` — `route()` 메서드 바로 뒤에 추가:
```ts
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
```

- [ ] **Step 6: Write triage.md prompt file**

`prompts/triage.md`:
```markdown
사용자 메시지가 (1) 단순 질문/잡담인지 "chat", (2) 여러 전문가가 머리를 맞대야 하는 일인지 "collaborate"인지 판정하라.

collaborate면 아래 전문가 목록에서 이 일에 꼭 필요한 사람만 골라 team에 이름을 넣어라(없으면 빈 배열).

판단 기준:
- 사실 질문·정의·간단한 확인 → chat.
- 전략·기획·다관점 검토·산출물 작성처럼 여러 영역이 얽히면 → collaborate.
- 확실치 않으면 chat.
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx jest src/agent-layer/orchestrator-handle-mention.spec.ts`
Expected: PASS (6 passing).

- [ ] **Step 8: Wire PersonaRegistry into Orchestrator factory**

`src/agent-layer/agent-layer.module.ts` — Orchestrator `useFactory` 인자 끝에 `registry` 추가, `new Orchestrator(...)` 마지막 인자로 전달, `inject` 배열 끝에 `PersonaRegistry` 추가:

useFactory 시그니처 끝(`reporter: InsightReporter,` 뒤):
```ts
        reporter: InsightReporter,
        registry: PersonaRegistry,
```
new Orchestrator 호출(`..., fence, reporter,` → ):
```ts
          projects, gate, codingGit, coder, reviewer, codeBrain, fence, reporter, registry,
```
inject 배열(`BRAIN, PermissionFence, InsightReporter,` 뒤):
```ts
        BRAIN, PermissionFence, InsightReporter, PersonaRegistry,
```

- [ ] **Step 9: Run full suite to verify wiring compiles + nothing broke**

Run: `npx jest src/agent-layer src/app.module.spec.ts`
Expected: PASS (기존 orchestrator/collaborate/coderun 스펙 포함 전부 통과 — 생성자 인자는 끝에 옵셔널 추가라 기존 위치 불변).

- [ ] **Step 10: Commit**

```bash
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator-handle-mention.spec.ts src/agent-layer/agent-layer.module.ts prompts/triage.md
git commit -m "feat(phase6a): Orchestrator.handleMention triage(chat/collaborate 분류·로스터·폴백)"
```

---

## Task 3: messenger-bridge (멘션 → handleMention → reply 결선)

**Files:**
- Create: `src/edge/messenger/messenger-bridge.ts`
- Test: `src/edge/messenger/messenger-bridge.spec.ts`

**Interfaces:**
- Consumes: `MessengerPort`(Task 1), `CoreMessage`, Orchestrator의 `handleMention(msg, onAck?)`(Task 2 — 여기선 구조적 타입만 사용).
- Produces: `bindMessenger(port: MessengerPort, orchestrator: MentionHandler, logger: { warn(msg: string, ctx?: string): void }): void`
  - `interface MentionHandler { handleMention(msg: CoreMessage, onAck?: (t: string) => Promise<void>): Promise<string> }`

- [ ] **Step 1: Write the failing test**

`src/edge/messenger/messenger-bridge.spec.ts`:
```ts
import { FakeMessenger } from './fake-messenger';
import { bindMessenger } from './messenger-bridge';

const logger = { warn() {} } as any;

it('멘션 → handleMention 결과를 그 target에 reply', async () => {
  const m = new FakeMessenger();
  const orch = { handleMention: async (msg: any) => `답:${msg.text}@${msg.userId}` };
  bindMessenger(m, orch as any, logger);
  await m.emit({ text: '안녕', channelId: 'c1', authorId: 'u1', target: 'T1' });
  expect(m.replies).toEqual([{ target: 'T1', text: '답:안녕@c1' }]);
});

it('handleMention의 onAck도 같은 target으로 reply', async () => {
  const m = new FakeMessenger();
  const orch = { handleMention: async (_msg: any, onAck?: any) => { await onAck?.('알아볼게요'); return '결과'; } };
  bindMessenger(m, orch as any, logger);
  await m.emit({ text: 'x', channelId: 'c1', authorId: 'u1', target: 'T1' });
  expect(m.replies.map((r) => r.text)).toEqual(['알아볼게요', '결과']);
});

it('handleMention이 던지면 사과 메시지 + 로그(상주 안 죽음)', async () => {
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
Expected: FAIL — `Cannot find module './messenger-bridge'`.

- [ ] **Step 3: Write bindMessenger**

`src/edge/messenger/messenger-bridge.ts`:
```ts
import { MessengerPort } from './messenger.port';
import { CoreMessage } from '../core-message';

// Orchestrator를 구조적 타입으로만 의존(순환 import 회피·테스트 용이).
export interface MentionHandler {
  handleMention(msg: CoreMessage, onAck?: (t: string) => Promise<void>): Promise<string>;
}

// 멘션을 handleMention으로 흘리고 답을 그 자리에 게시. 실패해도 상주를 죽이지 않는다.
export function bindMessenger(
  port: MessengerPort,
  orchestrator: MentionHandler,
  logger: { warn(msg: string, ctx?: string): void },
): void {
  port.onMention(async (e) => {
    try {
      const answer = await orchestrator.handleMention(
        { text: e.text, userId: e.channelId },          // 채널 ID = 맥락 네임스페이스(멀티플레이어)
        (ack) => port.reply(e.target, ack),             // 처리 중 메시지(선택)
      );
      await port.reply(e.target, answer);               // 최종 결과
    } catch (err) {
      logger.warn(`멘션 처리 실패: ${String(err)}`, 'Messenger');
      try { await port.reply(e.target, '지금 처리가 안 되네요 🙏'); } catch { /* reply도 실패하면 포기 */ }
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/edge/messenger/messenger-bridge.spec.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add src/edge/messenger/messenger-bridge.ts src/edge/messenger/messenger-bridge.spec.ts
git commit -m "feat(phase6a): messenger-bridge — 멘션→handleMention→reply 결선(에러 격리)"
```

---

## Task 4: messenger 설정 로더 + 팩토리

**Files:**
- Create: `src/edge/messenger/messenger.config.ts`
- Create: `src/edge/messenger/messenger.factory.ts`
- Test: `src/edge/messenger/messenger.config.spec.ts`
- Test: `src/edge/messenger/messenger.factory.spec.ts`

**Interfaces:**
- Consumes: `MessengerConfig`(Task 1), `MessengerPort`(Task 1).
- Produces:
  - `loadMessengerConfig(configDir: string): MessengerConfig` (env `ENGRAM_DISCORD_TOKEN`가 파일 token보다 우선)
  - `createMessenger(cfg: MessengerConfig): MessengerPort | null` (provider 없음 → null, 미지원 → throw)

- [ ] **Step 1: Write the failing test (config)**

`src/edge/messenger/messenger.config.spec.ts`:
```ts
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { loadMessengerConfig } from './messenger.config';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-msg-')); }

it('파일 없으면 빈 설정', () => {
  expect(loadMessengerConfig(tmp())).toEqual({ token: undefined });
});

it('messenger.json을 읽는다', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'messenger.json'), JSON.stringify({ provider: 'discord', token: 'file-tok' }));
  expect(loadMessengerConfig(dir)).toEqual({ provider: 'discord', token: 'file-tok' });
});

it('env ENGRAM_DISCORD_TOKEN이 파일 token보다 우선', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'messenger.json'), JSON.stringify({ provider: 'discord', token: 'file-tok' }));
  const prev = process.env.ENGRAM_DISCORD_TOKEN;
  process.env.ENGRAM_DISCORD_TOKEN = 'env-tok';
  try { expect(loadMessengerConfig(dir).token).toBe('env-tok'); }
  finally { if (prev === undefined) delete process.env.ENGRAM_DISCORD_TOKEN; else process.env.ENGRAM_DISCORD_TOKEN = prev; }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/edge/messenger/messenger.config.spec.ts`
Expected: FAIL — `Cannot find module './messenger.config'`.

- [ ] **Step 3: Write loadMessengerConfig**

`src/edge/messenger/messenger.config.ts`:
```ts
import * as fs from 'fs';
import * as path from 'path';
import { MessengerConfig } from './messenger.port';

// runtime/config/messenger.json 로드. 파일 없거나 깨지면 빈 설정(메신저 비활성).
// 비밀(token)은 env ENGRAM_DISCORD_TOKEN을 우선 — 파일에 토큰을 안 박아도 되게.
export function loadMessengerConfig(configDir: string): MessengerConfig {
  let cfg: MessengerConfig = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(configDir, 'messenger.json'), 'utf8')) as MessengerConfig;
  } catch {
    cfg = {};
  }
  return { ...cfg, token: process.env.ENGRAM_DISCORD_TOKEN ?? cfg.token };
}
```

- [ ] **Step 4: Run config test to verify it passes**

Run: `npx jest src/edge/messenger/messenger.config.spec.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Write the failing test (factory)**

`src/edge/messenger/messenger.factory.spec.ts`:
```ts
import { createMessenger } from './messenger.factory';

it('provider 없으면 null(메신저 비활성)', () => {
  expect(createMessenger({})).toBeNull();
});

it('discord인데 token 없으면 null', () => {
  expect(createMessenger({ provider: 'discord' })).toBeNull();
});

it('미지원 provider는 throw', () => {
  expect(() => createMessenger({ provider: 'icq', token: 't' })).toThrow(/지원하지 않는/);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx jest src/edge/messenger/messenger.factory.spec.ts`
Expected: FAIL — `Cannot find module './messenger.factory'`.

- [ ] **Step 7: Write createMessenger**

`src/edge/messenger/messenger.factory.ts`:
```ts
import { MessengerPort, MessengerConfig } from './messenger.port';

// messenger.json provider → 어댑터(brain.factory/supervisor.factory와 동일 패턴).
// provider 없음 → null(비활성). discord이나 token 없음 → null. 미지원 → throw.
// 새 메신저 추가 = case 1개 + 어댑터 파일 1개. 코어 무변경.
export function createMessenger(cfg: MessengerConfig): MessengerPort | null {
  if (!cfg.provider) return null;
  switch (cfg.provider) {
    case 'discord': {
      if (!cfg.token) return null;
      const { DiscordAdapter } = require('./discord.adapter'); // 지연 로드: discord.js 미사용 시 안 끌어옴
      return new DiscordAdapter(cfg);
    }
    default:
      throw new Error(`지원하지 않는 messenger provider: ${cfg.provider}`);
  }
}
```

- [ ] **Step 8: Run factory test to verify it passes**

Run: `npx jest src/edge/messenger/messenger.factory.spec.ts`
Expected: PASS (3 passing — discord+token 분기는 Task 5 어댑터/스모크가 커버).

- [ ] **Step 9: Commit**

```bash
git add src/edge/messenger/messenger.config.ts src/edge/messenger/messenger.config.spec.ts src/edge/messenger/messenger.factory.ts src/edge/messenger/messenger.factory.spec.ts
git commit -m "feat(phase6a): messenger 설정 로더 + 팩토리(provider 스위치·갈아끼움 seam)"
```

---

## Task 5: Discord 어댑터 + 상주 결선

**Files:**
- Modify: `package.json` (`discord.js` 의존성)
- Create: `src/edge/messenger/discord.adapter.ts`
- Test: `src/edge/messenger/discord.adapter.spec.ts` (스모크)
- Modify: `src/main.ts` (결선)

**Interfaces:**
- Consumes: `MessengerPort`·`MentionEvent`·`MessengerConfig`(Task 1), `createMessenger`/`loadMessengerConfig`(Task 4), `bindMessenger`(Task 3), `Orchestrator`(Task 2), `PathResolver`, `PinoLogger`, `discord.js`.
- Produces: `class DiscordAdapter implements MessengerPort`.

- [ ] **Step 1: Add discord.js dependency**

Run: `npm install discord.js`
Expected: `package.json` dependencies에 `discord.js` 추가, 설치 성공.

- [ ] **Step 2: Write the smoke test**

`src/edge/messenger/discord.adapter.spec.ts`:
```ts
import { DiscordAdapter } from './discord.adapter';

// 네트워크 글루라 단위테스트 불가 — 생성·핸들러 등록이 throw 없이 되는지 스모크만.
it('생성과 onMention 등록이 throw 없이 된다(로그인 없음)', () => {
  const a = new DiscordAdapter({ provider: 'discord', token: 'x' });
  expect(() => a.onMention(async () => {})).not.toThrow();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/edge/messenger/discord.adapter.spec.ts`
Expected: FAIL — `Cannot find module './discord.adapter'`.

- [ ] **Step 4: Write DiscordAdapter**

`src/edge/messenger/discord.adapter.ts`:
```ts
import { Client, GatewayIntentBits, Events, Message } from 'discord.js';
import { MessengerPort, MentionEvent, ReplyTarget, MessengerConfig } from './messenger.port';

// Discord 어댑터(설계 §9 / Phase 6a). 생성자는 연결하지 않음 — login은 start()에서.
// ponytail: 네트워크 글루, 스모크만. 로직(필터·@제거)은 최소로 둔다.
export class DiscordAdapter implements MessengerPort {
  private readonly client: Client;
  private handler?: (e: MentionEvent) => Promise<void>;

  constructor(private readonly cfg: MessengerConfig) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });
  }

  onMention(handler: (e: MentionEvent) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.client.on(Events.MessageCreate, async (m: Message) => {
      if (m.author.bot) return;                                   // 봇/자기 자신 무시
      if (!this.client.user || !m.mentions.has(this.client.user)) return; // @Engram 멘션만
      const text = m.content.replace(/<@!?\d+>/g, '').trim();     // 멘션 토큰 제거
      if (this.handler) await this.handler({
        text, channelId: m.channelId, authorId: m.author.id, target: m as ReplyTarget,
      });
    });
    await this.client.login(this.cfg.token);
  }

  async reply(target: ReplyTarget, text: string): Promise<void> {
    await (target as Message).reply(text);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }
}
```

- [ ] **Step 5: Run smoke test to verify it passes**

Run: `npx jest src/edge/messenger/discord.adapter.spec.ts`
Expected: PASS (1 passing).

- [ ] **Step 6: Wire into resident (main.ts)**

`src/main.ts` 전체를 교체:
```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Orchestrator } from './agent-layer/orchestrator';
import { PathResolver } from './pal/path-resolver';
import { PinoLogger } from './pal/logger';
import { loadMessengerConfig } from './edge/messenger/messenger.config';
import { createMessenger } from './edge/messenger/messenger.factory';
import { bindMessenger } from './edge/messenger/messenger-bridge';

// 상주 부트스트랩(설계 §9.2). 스케줄러(@Cron)는 모듈 그래프로 자동 가동.
// Phase 6a: messenger.json provider가 있으면 메신저 어댑터를 띄워 @Engram 멘션을 받는다.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  await app.init();

  const paths = app.get(PathResolver);
  const logger = app.get(PinoLogger);
  const cfg = loadMessengerConfig(paths.getConfigDir());
  let port = null;
  try {
    port = createMessenger(cfg);
  } catch (e) {
    logger.warn(`메신저 설정 오류(비활성): ${String(e)}`, 'Messenger');
  }
  if (port) {
    bindMessenger(port, app.get(Orchestrator), logger);
    await port.start();
    logger.info(`메신저 가동: ${cfg.provider}`, 'Messenger');
  }
}

void bootstrap();
```

- [ ] **Step 7: Verify the whole suite + typecheck**

Run: `npx jest && npx tsc --noEmit`
Expected: 전체 PASS, 타입 에러 0. (main.ts는 스모크 대상 아님 — 결선 로직은 Task 3/4 단위테스트가 커버.)

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/edge/messenger/discord.adapter.ts src/edge/messenger/discord.adapter.spec.ts src/main.ts
git commit -m "feat(phase6a): Discord 어댑터 + 상주 결선(@Engram 멘션 수신·게시)"
```

---

## Self-Review

**Spec coverage (스펙 §4 ↔ 태스크):**
- §4.2① MessengerPort → Task 1. §4.2② Discord 어댑터 → Task 5. §4.2③ handleMention triage → Task 2.
- §4.3 흐름(어댑터→bridge→handleMention→reply) → Task 3 + Task 5 main.ts.
- §4.4 멀티플레이어(userId=channelId) → Task 3 bindMessenger. escape hatch → Task 2.
- §4.5 상주 결선 → Task 5 Step 6. §4.6 오류 처리 → Task 2(분류 폴백)·Task 3(핸들러 try/catch).
- §4.7 설정 → Task 4 loadMessengerConfig. §4.8 테스트 → 각 태스크 spec + FakeMessenger(Task 1). §4.9 갈아끼움 → Task 4 factory.
- §6 영향파일 전부 태스크에 매핑됨. 누락 없음.

**Placeholder scan:** "TBD/TODO/적절히" 없음. 모든 코드 스텝에 실제 코드 포함. ✅

**Type consistency:** `handleMention(msg, onAck?)`·`classify(): {kind,team}`·`MentionEvent{text,channelId,threadId?,authorId,target}`·`bindMessenger(port,orchestrator,logger)`·`createMessenger(cfg): MessengerPort|null`·`loadMessengerConfig(dir): MessengerConfig` — Task 1~5 전반 동일 시그니처 사용 확인. Orchestrator 생성자 끝 옵셔널 추가라 기존 위치 불변(Task 2 Step 9가 회귀 확인). ✅
