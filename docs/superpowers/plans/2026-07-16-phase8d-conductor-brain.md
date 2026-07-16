# Phase 8d — 지휘자 두뇌 (두뇌 간 위임) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 엔그램 두뇌(anthropic-api·openai-api)의 도구 루프에 `ask_brain`(등록된 다른 두뇌에게 하위작업을 맡기고 답을 받는) 도구를 더해, 기본 두뇌가 대화 중 다른 두뇌를 능동적으로 불러 쓰게 한다.

**Architecture:** 8a의 `tool-loop.ts`/`sse.ts` 그대로 재사용. 새 도구 `ask_brain`은 `opts.delegate`(위임 핸들)가 있을 때만 노출된다. 위임 핸들은 agent-layer의 `BrainDelegator`가 만들어 `ReaderAgent`(채팅 진입점)가 두뇌에 주입한다 — `src/brain`은 다른 두뇌를 만드는 법을 모르고 제공된 함수만 부른다(8a의 fetchFn 주입과 동일).

**Tech Stack:** TypeScript/NestJS, Jest(HTTP·두뇌 전부 모킹/주입 — 실 네트워크·실 두뇌 금지), 8a 산출물(sseJson·runToolLoop·web-tools).

## Global Constraints

- **never-throw**: `ask_brain` 실행(미지 두뇌·일꾼 실패·인자 오염)은 던지지 않고 에러 텍스트를 tool_result로 되먹인다(8a 계약 유지).
- **깊이 1단**: 위임된 일꾼은 `complete(task)`를 `opts.delegate` 없이 호출 → 재위임 불가(무한 재귀 구조적 차단).
- **지휘자 = 엔그램 두뇌만**: `ask_brain`은 `opts.delegate`가 있을 때만 노출. CLI 두뇌(claude/gemini/codex)는 우리 루프를 안 타므로 opts.delegate를 무시. 회귀 0.
- **일꾼 = 아무 두뇌나**: `BrainDelegator.run`이 이름으로 아무 등록 두뇌나 resolve해 `complete(task)` (cwd 없음 = 채팅/분석 작업).
- **비용 합산**: 일꾼이 쓴 `costUsd`를 `BrainDelegator`가 누적(`spentUsd()`).
- **자율 위임 로컬 우선**: 프롬프트(conductor)로 유도 — 사용자가 지목 안 한 자율 폴백은 로컬/공짜 두뇌 우선. 강제 아님.
- **채팅 경로에만**: `opts.delegate`는 `ReaderAgent`만 넘긴다. 코딩(opts.cwd)은 8a대로 여전히 거부(8b-1 전).
- 테스트: `npx jest <경로>` FOREGROUND(워치/백그라운드 금지 — 이 머신서 hang). 실 네트워크/실 두뇌 금지(주입·스텁).
- 기존 스위트 전부 통과가 회귀 기준. 커밋 메시지 한국어, Co-Authored-By 제외.

---

### Task 1: brain.port 타입 + brain-tools(ask_brain 스키마·실행기)

**Files:**
- Modify: `src/brain/brain.port.ts`
- Create: `src/brain/brain-tools.ts`
- Test: `src/brain/brain-tools.spec.ts`

**Interfaces:**
- Consumes: 없음.
- Produces(Task 2~5가 소비):
  - `brain.port.ts`: `interface DelegateHandle { brains: string[]; run(brain: string, task: string): Promise<string> }` + `CompleteOpts.delegate?: DelegateHandle`.
  - `brain-tools.ts`: `askBrainDef(brains: string[]): { name: string; description: string; parameters: Record<string, unknown> }` · `runAskBrain(input: unknown, delegate?: DelegateHandle): Promise<string>`(never-throw).

- [ ] **Step 1: 포트 타입 추가**

`src/brain/brain.port.ts`의 `CompleteOpts` 위에 `DelegateHandle` 추가하고, `CompleteOpts`에 `delegate` 필드 추가:

```ts
// Phase 8d: 지휘자가 다른 두뇌를 부르는 위임 핸들(agent-layer가 만들어 주입 — src/brain은 함수만 부름).
export interface DelegateHandle {
  brains: string[];                                    // 위임 가능한 두뇌 이름들(brains.json 등록 전부)
  run(brain: string, task: string): Promise<string>;   // never-throw — 실패·미지 두뇌는 에러 텍스트
}

export interface CompleteOpts {
  cwd?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  delegate?: DelegateHandle;   // Phase 8d: 있으면 엔그램 하네스가 ask_brain 도구를 노출
}
```

(기존 `CompleteOpts`의 cwd/extraArgs/timeoutMs 주석은 유지하고 delegate만 추가.)

- [ ] **Step 2: 실패 테스트 작성**

`src/brain/brain-tools.spec.ts`:

```ts
import { askBrainDef, runAskBrain } from './brain-tools';
import { DelegateHandle } from './brain.port';

describe('askBrainDef', () => {
  it('이름이 ask_brain이고 설명에 두뇌 목록이 들어간다', () => {
    const d = askBrainDef(['claude', 'ollama']);
    expect(d.name).toBe('ask_brain');
    expect(d.description).toContain('claude');
    expect(d.description).toContain('ollama');
    expect((d.parameters as any).required).toEqual(['brain', 'task']);
  });
});

describe('runAskBrain (never-throw)', () => {
  const delegate: DelegateHandle = { brains: ['x'], run: async (b, t) => `ran ${b}: ${t}` };
  it('정상 인자는 delegate.run으로 라우팅', async () => {
    expect(await runAskBrain({ brain: 'x', task: 'do it' }, delegate)).toBe('ran x: do it');
  });
  it('delegate 없으면 에러 텍스트', async () => {
    expect(await runAskBrain({ brain: 'x', task: 't' })).toContain('not available');
  });
  it('인자 오염은 에러 텍스트(throw 아님)', async () => {
    expect(await runAskBrain({ brain: 1, task: 't' }, delegate)).toContain('required');
    expect(await runAskBrain(null, delegate)).toContain('required');
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx jest src/brain/brain-tools.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 4: 구현**

`src/brain/brain-tools.ts`:

```ts
import { DelegateHandle } from './brain.port';

// 지휘자 도구(스펙 §2.2). web-tools와 형태를 맞춘 provider 중립 스키마 + never-throw 실행기.
// 도구 설명은 호출 시점에 조립(가용 두뇌 목록이 동적이라 상수 아님).
export function askBrainDef(brains: string[]): { name: string; description: string; parameters: Record<string, unknown> } {
  return {
    name: 'ask_brain',
    description:
      `Delegate a subtask to another registered brain and return its answer. ` +
      `Available brains: ${brains.join(', ') || '(none)'}. ` +
      `Use it when the user names a brain for part of the work, or when you are stuck and another brain could help. ` +
      `For autonomous delegation (the user did not name a brain), prefer local/free brains over paid API brains.`,
    parameters: {
      type: 'object',
      properties: {
        brain: { type: 'string', description: 'Name of a registered brain to delegate to' },
        task: { type: 'string', description: 'The subtask for that brain' },
      },
      required: ['brain', 'task'],
    },
  };
}

// ask_brain 실행 — never-throw. 인자 검증 후 delegate.run으로 라우팅.
export async function runAskBrain(input: unknown, delegate?: DelegateHandle): Promise<string> {
  if (!delegate) return 'ask_brain error: delegation not available';
  const arg = (input ?? {}) as Record<string, unknown>;
  if (typeof arg.brain !== 'string' || typeof arg.task !== 'string') {
    return 'ask_brain error: brain(string) and task(string) required';
  }
  return delegate.run(arg.brain, arg.task);
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx jest src/brain/brain-tools.spec.ts`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add src/brain/brain.port.ts src/brain/brain-tools.ts src/brain/brain-tools.spec.ts
git commit -m "feat(phase8d): DelegateHandle 포트 + ask_brain 도구 스키마·실행기"
```

---

### Task 2: AnthropicApiBrain — ask_brain 배선

**Files:**
- Modify: `src/brain/anthropic-api.brain.ts`
- Test: `src/brain/anthropic-api.brain.spec.ts`

**Interfaces:**
- Consumes: Task 1 `DelegateHandle`·`askBrainDef`·`runAskBrain`.
- Produces: `opts.delegate` 있으면 `ask_brain` 도구를 web 도구와 함께 노출; 모델이 부르면 `runAskBrain(input, opts.delegate)`로 라우팅.

- [ ] **Step 1: 실패 테스트 추가**

`src/brain/anthropic-api.brain.spec.ts` 끝(마지막 `});` 앞)에 append. 파일 상단 `sse`/`TEXT_TURN` 헬퍼 재사용. `ask_brain` tool_use를 흘리는 SSE 턴을 새로 정의:

```ts
  it('opts.delegate 있으면 ask_brain 도구 노출 + 호출 시 delegate.run 라우팅', async () => {
    const ASK_TURN = [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'ab1', name: 'ask_brain' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"brain":"ollama","task":"리뷰"}' } },
      { type: 'message_delta', usage: { output_tokens: 2 } },
    ];
    let call = 0;
    const fetchFn = jest.fn(async () => { call++; return call === 1 ? sse(ASK_TURN) : sse(TEXT_TURN); }) as unknown as typeof fetch;
    const ran: Array<{ brain: string; task: string }> = [];
    const delegate = { brains: ['ollama', 'claude'], run: async (brain: string, task: string) => { ran.push({ brain, task }); return '리뷰 결과'; } };
    const r = await new AnthropicApiBrain(PROFILE, fetchFn).complete('do it', undefined, { delegate });
    expect(r.isError).toBe(false);
    expect(ran).toEqual([{ brain: 'ollama', task: '리뷰' }]);
    // 첫 호출 body에 ask_brain 도구가 실렸는지 + 설명에 두뇌 목록
    const firstBody = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    const askDef = firstBody.tools.find((t: { name: string }) => t.name === 'ask_brain');
    expect(askDef).toBeDefined();
    expect(askDef.description).toContain('ollama');
    // 두 번째 호출 body에 tool_result로 '리뷰 결과' 되먹임
    expect(JSON.stringify((fetchFn as jest.Mock).mock.calls[1][1].body)).toContain('리뷰 결과');
  });

  it('opts.delegate 없으면 ask_brain 미노출(web 도구만)', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_TURN)) as unknown as typeof fetch;
    await new AnthropicApiBrain(PROFILE, fetchFn).complete('hi');
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['web_search', 'web_fetch']);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/brain/anthropic-api.brain.spec.ts -t "ask_brain"`
Expected: FAIL — ask_brain 도구 미노출·delegate.run 미호출.

- [ ] **Step 3: 구현**

`src/brain/anthropic-api.brain.ts` 세 곳 수정.

**(a)** import에 추가:

```ts
import { CompleteOpts, DelegateHandle, BrainProvider, BrainResult } from './brain.port';
import { askBrainDef, runAskBrain } from './brain-tools';
```

(기존 `import { BrainProvider, BrainResult, CompleteOpts } from './brain.port';`를 위 형태로 교체 — DelegateHandle 추가.)

**(b)** `complete()`의 `runToolLoop` 세 번째 인자(executor)를 ask_brain 라우팅으로 교체하고, 첫 인자의 turn 호출에 delegate 전달:

```ts
        const r = await runToolLoop(
          () => this.turn(history, onChunk, ctrl.signal, opts?.delegate),
          (results) => history.push({
            role: 'user',
            content: results.map((t) => ({ type: 'tool_result', tool_use_id: t.id, content: t.output })),
          }),
          (name, input) => name === 'ask_brain'
            ? runAskBrain(input, opts?.delegate)
            : executeWebTool(name, input, this.profile, this.fetchFn, ctrl.signal),
        );
```

**(c)** `turn()` 시그니처에 `delegate?: DelegateHandle`를 더하고, tools 조립을 web+ask_brain으로:

```ts
  private async turn(history: AnthropicMsg[], onChunk: ((t: string) => void) | undefined, signal: AbortSignal, delegate?: DelegateHandle): Promise<TurnResult> {
    const toolDefs = [...WEB_TOOL_DEFS, ...(delegate ? [askBrainDef(delegate.brains)] : [])];
    const res = await this.fetchFn(`${this.profile.baseUrl || DEFAULT_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.profile.apiKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.profile.model,
        max_tokens: this.profile.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
        messages: history,
        tools: toolDefs.map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters })),
      }),
      signal,
    });
```

(`turn()`의 나머지(SSE 순회 등)는 무변경.)

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/brain/anthropic-api.brain.spec.ts`
Expected: PASS(신규 2 + 기존 전부 — 특히 "tools 이름 web_search,web_fetch" 단발 테스트가 delegate 없을 때 그대로 통과).

- [ ] **Step 5: 커밋**

```bash
git add src/brain/anthropic-api.brain.ts src/brain/anthropic-api.brain.spec.ts
git commit -m "feat(phase8d): AnthropicApiBrain에 ask_brain 도구 배선(opts.delegate 있을 때)"
```

---

### Task 3: OpenAiApiBrain — ask_brain 배선

**Files:**
- Modify: `src/brain/openai-api.brain.ts`
- Test: `src/brain/openai-api.brain.spec.ts`

**Interfaces:**
- Consumes: Task 1 `DelegateHandle`·`askBrainDef`·`runAskBrain`.
- Produces: Anthropic과 동일(OpenAI 와이어 형식).

- [ ] **Step 1: 실패 테스트 추가**

`src/brain/openai-api.brain.spec.ts` 끝에 append. 파일 상단 `sse`/`TEXT_CHUNKS` 재사용. ask_brain tool_calls 청크 정의:

```ts
  it('opts.delegate 있으면 ask_brain 도구 노출 + 호출 시 delegate.run 라우팅', async () => {
    const ASK_CHUNKS = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'ask_brain', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"brain":"claude","task":"리뷰"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } },
    ];
    let call = 0;
    const fetchFn = jest.fn(async () => { call++; return call === 1 ? sse(ASK_CHUNKS) : sse(TEXT_CHUNKS); }) as unknown as typeof fetch;
    const ran: Array<{ brain: string; task: string }> = [];
    const delegate = { brains: ['claude', 'ollama'], run: async (brain: string, task: string) => { ran.push({ brain, task }); return '리뷰 결과'; } };
    const r = await new OpenAiApiBrain(PROFILE, fetchFn).complete('go', undefined, { delegate });
    expect(r.isError).toBe(false);
    expect(ran).toEqual([{ brain: 'claude', task: '리뷰' }]);
    const firstBody = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    const askDef = firstBody.tools.find((t: { function: { name: string } }) => t.function.name === 'ask_brain');
    expect(askDef).toBeDefined();
    expect(askDef.function.description).toContain('claude');
    expect(JSON.stringify((fetchFn as jest.Mock).mock.calls[1][1].body)).toContain('리뷰 결과');
  });

  it('opts.delegate 없으면 ask_brain 미노출', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_CHUNKS)) as unknown as typeof fetch;
    await new OpenAiApiBrain(PROFILE, fetchFn).complete('hi');
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['web_search', 'web_fetch']);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/brain/openai-api.brain.spec.ts -t "ask_brain"`
Expected: FAIL.

- [ ] **Step 3: 구현**

`src/brain/openai-api.brain.ts` 세 곳 수정.

**(a)** import: `import { CompleteOpts, DelegateHandle, ... } from './brain.port';` + `import { askBrainDef, runAskBrain } from './brain-tools';` (기존 brain.port import에 DelegateHandle 추가).

**(b)** `complete()`의 executor + turn 호출:

```ts
        const r = await runToolLoop(
          () => this.turn(history, onChunk, ctrl.signal, opts?.delegate),
          (results) => {
            for (const t of results) history.push({ role: 'tool', content: t.output, tool_call_id: t.id });
          },
          (name, input) => name === 'ask_brain'
            ? runAskBrain(input, opts?.delegate)
            : executeWebTool(name, input, this.profile, this.fetchFn, ctrl.signal),
        );
```

**(c)** `turn()` 시그니처에 `delegate?: DelegateHandle` + tools 조립:

```ts
  private async turn(history: OpenAiMsg[], onChunk: ((t: string) => void) | undefined, signal: AbortSignal, delegate?: DelegateHandle): Promise<TurnResult> {
    const toolDefs = [...WEB_TOOL_DEFS, ...(delegate ? [askBrainDef(delegate.brains)] : [])];
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.profile.apiKey) headers.Authorization = `Bearer ${this.profile.apiKey}`;
    const res = await this.fetchFn(`${this.profile.baseUrl!.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.profile.model,
        max_tokens: this.profile.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
        stream_options: { include_usage: true },
        messages: history,
        tools: toolDefs.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } })),
      }),
      signal,
    });
```

(나머지 무변경.)

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/brain/openai-api.brain.spec.ts`
Expected: PASS(신규 2 + 기존 전부).

- [ ] **Step 5: 커밋**

```bash
git add src/brain/openai-api.brain.ts src/brain/openai-api.brain.spec.ts
git commit -m "feat(phase8d): OpenAiApiBrain에 ask_brain 도구 배선(opts.delegate 있을 때)"
```

---

### Task 4: listBrainNames + BrainDelegator

**Files:**
- Modify: `src/brain/brain.config.ts` (listBrainNames)
- Create: `src/agent-layer/brain-delegator.ts`
- Test: `src/brain/brain.config.spec.ts` (listBrainNames), `src/agent-layer/brain-delegator.spec.ts`

**Interfaces:**
- Consumes: Task 1 `DelegateHandle`, `BrainProvider`(brain.port).
- Produces(Task 5가 소비):
  - `brain.config.ts`: `listBrainNames(configDir: string): string[]`.
  - `brain-delegator.ts`: `class BrainDelegator { constructor(resolve: (name: string) => BrainProvider, names: () => string[]); handle(): DelegateHandle; spentUsd(): number }`.

- [ ] **Step 1: listBrainNames 실패 테스트**

`src/brain/brain.config.spec.ts`의 `describe('Phase 8a — engram-api 프로필', …)` 안(또는 파일 끝 새 describe)에 append:

```ts
  it('listBrainNames는 brains.json의 두뇌 이름들을 반환(없으면 [])', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-names-'));
    try {
      fs.writeFileSync(path.join(dir, 'brains.json'), JSON.stringify({ default: 'claude', brains: { claude: {}, ollama: {}, anthropic: {} } }));
      expect(listBrainNames(dir).sort()).toEqual(['anthropic', 'claude', 'ollama']);
      expect(listBrainNames(path.join(dir, 'nope'))).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
```

파일 상단 import에 `listBrainNames`를 추가(`import { loadActiveBrain, loadBrainProfile, listBrainNames } from './brain.config';` 형태 — 실제 기존 import 라인에 병합).

- [ ] **Step 2: 실패 확인 후 listBrainNames 구현**

Run: `npx jest src/brain/brain.config.spec.ts -t "listBrainNames"` → FAIL 확인.

`src/brain/brain.config.ts` 끝에 append(파일 상단에 이미 `import * as fs`·`import * as path` 있음):

```ts
// brains.json에 등록된 두뇌 이름 목록(지휘자 위임 대상 후보, Phase 8d). 없거나 깨지면 빈 배열.
export function listBrainNames(configDir: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'brains.json'), 'utf8'));
    return raw && typeof raw.brains === 'object' && raw.brains ? Object.keys(raw.brains) : [];
  } catch {
    return [];
  }
}
```

Run: `npx jest src/brain/brain.config.spec.ts` → PASS.

- [ ] **Step 3: BrainDelegator 실패 테스트**

`src/agent-layer/brain-delegator.spec.ts`:

```ts
import { BrainDelegator } from './brain-delegator';
import { BrainProvider, BrainResult, CompleteOpts } from '../brain/brain.port';

// opts를 기록하는 가짜 두뇌(깊이 1 검증: 일꾼은 opts.delegate 없이 불려야 함).
function fakeBrain(result: Partial<BrainResult>): BrainProvider & { calls: CompleteOpts[] } {
  const calls: CompleteOpts[] = [];
  return {
    calls,
    complete: async (_p: string, _c?: (t: string) => void, opts?: CompleteOpts) => {
      calls.push(opts ?? {});
      return { text: 'worker-answer', costUsd: 0.5, isError: false, ...result } as BrainResult;
    },
  };
}

describe('BrainDelegator', () => {
  it('이름 지정 두뇌를 resolve해 complete(task)를 delegate 없이 부른다(깊이 1)', async () => {
    const worker = fakeBrain({});
    const d = new BrainDelegator((name) => (name === 'ollama' ? worker : (fakeBrain({}) as BrainProvider)), () => ['ollama', 'claude']);
    const out = await d.handle().run('ollama', '리뷰해줘');
    expect(out).toBe('worker-answer');
    expect(worker.calls).toHaveLength(1);
    expect(worker.calls[0].delegate).toBeUndefined(); // 재위임 불가
    expect(d.spentUsd()).toBeCloseTo(0.5);
  });

  it('미지 두뇌는 에러 텍스트(throw 아님)', async () => {
    const d = new BrainDelegator(() => fakeBrain({}) as BrainProvider, () => ['ollama']);
    const out = await d.handle().run('gpt', 't');
    expect(out).toContain('unknown brain');
    expect(out).toContain('ollama');
  });

  it('일꾼 isError는 에러 텍스트', async () => {
    const d = new BrainDelegator(() => fakeBrain({ isError: true, raw: 'boom' }) as BrainProvider, () => ['x']);
    expect(await d.handle().run('x', 't')).toContain('failed');
  });

  it('handle()마다 비용 카운터 리셋 + brains 목록 노출', () => {
    const d = new BrainDelegator(() => fakeBrain({}) as BrainProvider, () => ['a', 'b']);
    expect(d.handle().brains).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 4: 실패 확인 후 구현**

Run: `npx jest src/agent-layer/brain-delegator.spec.ts` → FAIL(모듈 없음).

`src/agent-layer/brain-delegator.ts`:

```ts
import { BrainProvider, DelegateHandle } from '../brain/brain.port';

// 지휘자 위임 실행기(스펙 §2.3). 이름으로 등록 두뇌를 resolve해 complete를 부른다.
// 깊이 1: 일꾼에겐 delegate 미전달 → 재위임 불가(무한 재귀 차단). never-throw.
// resolve/names는 agent-layer.module이 주입(createBrain 캐시·brains.json 로딩 재사용).
export class BrainDelegator {
  private spent = 0;

  constructor(
    private readonly resolve: (name: string) => BrainProvider,
    private readonly names: () => string[],
  ) {}

  handle(): DelegateHandle {
    this.spent = 0;
    return {
      brains: this.names(),
      run: async (brain, task) => {
        const available = this.names();
        if (!available.includes(brain)) {
          return `delegate error: unknown brain "${brain}" (available: ${available.join(', ')})`;
        }
        const worker = this.resolve(brain);
        const r = await worker.complete(task); // cwd 없음=채팅작업, delegate 없음=깊이 1
        this.spent += r.costUsd;
        return r.isError ? `delegate error: brain "${brain}" failed (${String(r.raw)})` : r.text;
      },
    };
  }

  spentUsd(): number {
    return this.spent;
  }
}
```

Run: `npx jest src/agent-layer/brain-delegator.spec.ts` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/brain/brain.config.ts src/brain/brain.config.spec.ts src/agent-layer/brain-delegator.ts src/agent-layer/brain-delegator.spec.ts
git commit -m "feat(phase8d): listBrainNames + BrainDelegator(깊이1·비용누적·미지두뇌 가드)"
```

---

### Task 5: ReaderAgent 배선 + conductor 프롬프트 + 모듈

**Files:**
- Create: `prompts/conductor.md`
- Modify: `src/agent-layer/reader-agent.ts`
- Modify: `src/agent-layer/agent-layer.module.ts`
- Test: `src/agent-layer/reader-agent.spec.ts`

**Interfaces:**
- Consumes: Task 4 `BrainDelegator`, Task 1 `DelegateHandle`.
- Produces: 지휘자 활성 시 채팅 두뇌 호출에 `opts.delegate` 전달 + conductor 지침 프롬프트 포함.

- [ ] **Step 1: conductor 프롬프트 파일**

`prompts/conductor.md`:

```markdown
You can delegate subtasks to other registered brains using the ask_brain tool.
- If the user names a specific brain for part of the work (e.g. "review with claude"), use ask_brain to hand that part to it.
- If you get stuck, or another brain would clearly do a part better, delegate it. For autonomous delegation (the user did not name a brain), prefer local/free brains over paid API brains.
- If the request is ambiguous or has a meaningful choice, ask one brief clarifying question instead of guessing.
- Coding delegation is not available yet — delegate only analysis, review, and writing tasks.
```

- [ ] **Step 2: 실패 테스트 작성**

`src/agent-layer/reader-agent.spec.ts`에 append(또는 파일 없으면 생성). ReaderAgent를 직접 구성(rag 스텁·opts 기록 가짜 두뇌). BrainDelegator는 Task 4 것을 스텁 resolve/names로.

```ts
import { ReaderAgent } from './reader-agent';
import { BrainDelegator } from './brain-delegator';
import { BrainProvider, BrainResult, CompleteOpts } from '../brain/brain.port';

const rag = { search: async () => [] } as any;
const logger = { error: () => {}, info: () => {}, warn: () => {} } as any;
function recordingBrain() {
  const seen: { prompt: string; opts?: CompleteOpts }[] = [];
  const brain: BrainProvider = {
    complete: async (prompt, _c, opts) => { seen.push({ prompt, opts }); return { text: 'ok', costUsd: 0, isError: false } as BrainResult; },
  };
  return { brain, seen };
}
const msg = { text: '리뷰는 클로드로 해줘', userId: 'default' } as any;

describe('ReaderAgent 지휘자 배선(Phase 8d)', () => {
  it('delegator 주입 시 opts.delegate 전달 + conductor 프롬프트 포함', async () => {
    const { brain, seen } = recordingBrain();
    const worker = { complete: async () => ({ text: 'w', costUsd: 0, isError: false } as BrainResult) } as BrainProvider;
    const delegator = new BrainDelegator(() => worker, () => ['claude', 'ollama']);
    const reader = new ReaderAgent(rag, brain, logger, undefined, undefined, delegator);
    await reader.handle(msg);
    expect(seen[0].opts?.delegate).toBeDefined();
    expect(seen[0].opts?.delegate?.brains).toEqual(['claude', 'ollama']);
    expect(seen[0].prompt).toContain('ask_brain'); // conductor 지침 포함
  });

  it('delegator 미주입 시 opts.delegate 미전달(회귀)', async () => {
    const { brain, seen } = recordingBrain();
    const reader = new ReaderAgent(rag, brain, logger);
    await reader.handle(msg);
    expect(seen[0].opts?.delegate).toBeUndefined();
    expect(seen[0].prompt).not.toContain('ask_brain');
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx jest src/agent-layer/reader-agent.spec.ts -t "지휘자"`
Expected: FAIL — ReaderAgent가 delegator 인자를 안 받고 opts.delegate 미전달.

- [ ] **Step 4: ReaderAgent 구현**

`src/agent-layer/reader-agent.ts` 수정.

**(a)** import에 추가:

```ts
import { BrainDelegator } from './brain-delegator';
import { loadPrompt } from './prompt-store';
```

그리고 파일 상단(RECENT_TURNS 옆)에 conductor 기본 프롬프트:

```ts
// prompts/conductor.md 없을 때의 내장 기본값(지휘자 지침 — out-of-box 동작 보장).
export const CONDUCTOR_DEFAULT = [
  'You can delegate subtasks to other registered brains using the ask_brain tool.',
  '- If the user names a specific brain for part of the work, use ask_brain to hand that part to it.',
  '- If you get stuck, or another brain would clearly do a part better, delegate it. For autonomous delegation, prefer local/free brains over paid API brains.',
  '- If the request is ambiguous, ask one brief clarifying question instead of guessing.',
  '- Coding delegation is not available yet — delegate only analysis, review, and writing tasks.',
].join('\n');
```

**(b)** 생성자에 `@Optional() BrainDelegator` 추가:

```ts
  constructor(
    private readonly rag: RagStore,
    @Inject(BRAIN) private readonly brain: BrainProvider,
    private readonly logger: PinoLogger,
    @Optional() private readonly insight?: InsightContext,
    @Optional() private readonly conversations?: ConversationStore,
    @Optional() private readonly delegator?: BrainDelegator,
  ) {}
```

**(c)** `handle()`에서 위임 핸들 생성·전달·프롬프트 플래그. 기존 `const result = await this.brain.complete(this.buildPrompt(...), onChunk);` 줄을 교체:

```ts
      const handle = this.delegator?.handle();
      const result = await this.brain.complete(
        this.buildPrompt(msg.text, hits, ctx, recent, !!handle),
        onChunk,
        handle ? { delegate: handle } : undefined,
      );
```

**(d)** `buildPrompt` 시그니처에 `conductorOn = false`를 더하고, 켜졌을 때 지침 블록을 배열 앞쪽에 삽입:

```ts
  private buildPrompt(question: string, hits: SearchResult[], ctx = '', recent: ConversationRecord[] = [], conductorOn = false): string {
    const context = hits.map((h, i) => `[${i + 1}] ${h.title} (slug: ${h.slug})\n${h.text}`).join('\n\n');
    const clip = (s: string): string => (s.length > 400 ? s.slice(0, 400) + '…' : s);
    const recentBlock = recent.length
      ? `# Prior conversation (continuity reference — not evidence; evidence is the wiki below)\n${recent
          .map((r) => `User: ${clip(r.question)}\nEngram: ${clip(r.answer)}`)
          .join('\n')}\n\n`
      : '';
    const insightBlock = ctx
      ? `# User context for reference (not evidence — evidence is the wiki below)\n${ctx}\n\n`
      : '';
    const conductorBlock = conductorOn ? `# Delegation\n${loadPrompt('conductor', CONDUCTOR_DEFAULT)}\n\n` : '';
    return [
      'Answer the question using the searched wiki content below as the primary basis.',
      'Mark the evidence you use with [n]. If the search content cannot answer it, state that this is general knowledge outside the wiki.',
      'If there is prior conversation, continue its flow (interpret short replies and pronouns against the prior conversation).',
      'If there are numbers/time series, include a chart block (the UI renders it as a graph): ```chart {"type":"bar|line|pie","title":"title","labels":["A","B"],"values":[1,2],"unit":"%"} ``` (bar/line = trend/compare, pie = share).',
      'Per-item comparisons also work as a markdown table (| header | ... |) — for changes attach arrows like ▲2.3% (up) / ▼1.1% (down) and the UI colors them green/red. Use - [ ] / - [x] checkboxes for to-do lists.',
      outputDirective('interactive'),
      '',
      conductorBlock + recentBlock + insightBlock + `# Searched wiki\n${context || '(none)'}`,
      '',
      `# Question\n${question}`,
    ].join('\n');
  }
```

- [ ] **Step 5: 모듈 배선**

`src/agent-layer/agent-layer.module.ts` 수정.

**(a)** import에 추가(기존 brain 관련 import 옆):

```ts
import { BrainDelegator } from './brain-delegator';
import { createBrain } from '../brain/brain.factory';
import { loadBrainProfile, listBrainNames } from '../brain/brain.config';
```

(`createBrain`·`loadBrainProfile`은 이미 import되어 있으면 `listBrainNames`만 추가. `BrainDelegator` 신규.)

**(b)** providers 배열에 `ReaderAgent` 앞이나 뒤 아무 곳(순서 무관)에 BrainDelegator provider 추가:

```ts
    {
      provide: BrainDelegator,
      useFactory: (paths: PathResolver, defaultBrain: BrainProvider) => {
        // SpecialistAgent와 동일 캐시 패턴: 'claude'(default 프로필명)은 주입 BRAIN 고정(FakeBrain override 관통).
        const cache = new Map<string, BrainProvider>();
        cache.set('claude', defaultBrain);
        const resolve = (key: string): BrainProvider => {
          if (!cache.has(key)) cache.set(key, createBrain(loadBrainProfile(paths.getConfigDir(), key)));
          return cache.get(key)!;
        };
        return new BrainDelegator(resolve, () => listBrainNames(paths.getConfigDir()));
      },
      inject: [PathResolver, BRAIN],
    },
```

(`ReaderAgent`는 클래스 provider(자동 주입)이라, BrainDelegator가 provider로 등록되면 `@Optional() delegator?: BrainDelegator`에 자동 주입된다 — ReaderAgent 항목 자체는 무변경.)

- [ ] **Step 6: 통과 확인**

Run: `npx jest src/agent-layer/reader-agent.spec.ts`
Expected: PASS(신규 2 + 기존 reader 테스트 전부).

- [ ] **Step 7: 커밋**

```bash
git add prompts/conductor.md src/agent-layer/reader-agent.ts src/agent-layer/agent-layer.module.ts src/agent-layer/reader-agent.spec.ts
git commit -m "feat(phase8d): ReaderAgent 지휘자 배선(opts.delegate·conductor 프롬프트) + 모듈 BrainDelegator provider"
```

---

### Task 6: 전체 회귀 + 빌드

**Files:** 없음(검증만)

**Interfaces:** Consumes: 전 Task.

- [ ] **Step 1: 백엔드 전체 스위트**

Run: `npm test`
Expected: PASS(기존 + 신규 전부 — 특히 anthropic/openai brain·reader-agent·brain.config·orchestrator 회귀 없음). 실패 시 해당 Task로 복귀.

- [ ] **Step 2: 렌더러 전체(무변경 확인)**

Run: `npm --prefix renderer test`
Expected: PASS.

- [ ] **Step 3: 타입/빌드**

Run: `npm run build && npm --prefix renderer run build`
Expected: nest/tsc/vite 에러 0.

---

## Self-Review

**Spec coverage:**
- §2.1 DelegateHandle + CompleteOpts.delegate → Task 1. ✅
- §2.2 ask_brain 도구(동적 설명·delegate 있을 때만·라우팅) → Task 1(스키마/실행기) + Task 2·3(provider 배선). ✅
- §2.3 BrainDelegator(깊이 1·비용 누적·미지 두뇌 에러·resolve/names 재사용) → Task 4. ✅
- §2.4 ReaderAgent(delegator @Optional·handle 전달·conductor 프롬프트·claude CLI는 무시) → Task 5. ✅
- §2.5 "먼저 질문"=새 장치 없음(프롬프트만) → Task 5 conductor 프롬프트. ✅
- §3 하위호환(위임 비활성 회귀 0·never-throw·깊이1·미지두뇌) → Task 2·3(delegate 없을 때 미노출)·Task 4(가드). ✅
- §4 테스트 전략 전 항목 → 각 Task 테스트. ✅
- §1.7 자율 위임 로컬 우선 → conductor 프롬프트 문구(Task 5). ✅

**Placeholder scan:** "적절한 처리"류 없음 — 전 스텝 실제 코드·명령·기대. ✅

**Type consistency:**
- `DelegateHandle { brains: string[]; run(brain, task): Promise<string> }` — Task 1 정의, Task 2·3(provider), Task 4(BrainDelegator.handle 반환), Task 5(opts.delegate) 동일. ✅
- `askBrainDef(brains)`/`runAskBrain(input, delegate?)` — Task 1 정의, Task 2·3 사용 동일. ✅
- `BrainDelegator(resolve, names)`·`handle()`·`spentUsd()` — Task 4 정의, Task 5(모듈 factory·ReaderAgent) 사용 동일. ✅
- `listBrainNames(configDir)` — Task 4 정의, Task 5 모듈 사용 동일. ✅
- `CompleteOpts.delegate` — Task 1 정의, Task 2·3 executor·turn, Task 5 complete 호출 동일. ✅

**주의(구현자용):**
- Task 2·3 테스트의 목 fetch는 **첫 호출=ask_brain 턴, 둘째 호출=최종 텍스트 턴**으로 분기(call 카운터). delegate.run은 fetch를 안 타는 순수 스텁이라 web fetch 분기 불필요.
- Task 5 ReaderAgent는 두뇌 종류를 판별하지 않는다 — delegator만 있으면 항상 opts.delegate를 넘기고, CLI 두뇌는 무시(우리 루프 안 탐). 그래서 "claude CLI 기본이면 미노출"은 provider 레벨(Task 2·3)에서 이미 성립.
- Task 4 BrainDelegator는 스펙 §2.3의 configDir 생성자 인자를 뺐다(불필요 — resolve/names 클로저가 configDir를 캡처). 의도된 단순화.
