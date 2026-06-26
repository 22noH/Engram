# Phase 1 — A 읽기 (ReaderAgent + CLI Gateway) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자가 CLI로 질문하면 위키(RAG)에 근거해 출처를 단 답을 스트리밍으로 받는 첫 입출력 경로를 만든다.

**Architecture:** `CLI Gateway → Orchestrator(스텁) → ReaderAgent → RagStore(완료) + BrainProvider(Claude CLI)`. 두뇌는 교체 가능한 포트(`BRAIN` 토큰), Claude CLI 어댑터 1개만 구현. 모든 흐름은 Orchestrator를 경유(설계 불변). 출력은 `onChunk` 콜백을 층 사이로 통과시켜 스트리밍.

**Tech Stack:** NestJS 11 / TypeScript 5.7 / Node 22, jest + ts-jest(CommonJS), cross-spawn(claude 실행), 인라인 Semaphore(p-limit 대체 — ESM 마찰 회피).

## Global Constraints

- 셸 스크립트 0개. spawn은 `cross-spawn`(설계 §12 이식성).
- 모델·CLI 경로·동시 수·타임아웃 하드코딩 금지 → `runtime/config/brains.json`에서(설계 §3).
- 경로는 `path.join`/`PathResolver`로만(하드코딩 금지).
- 테스트는 `src/**/*.spec.ts`, `FakeEmbedder`식 결정론적 fake 사용(네트워크·실모델·실 claude 호출 없음).
- 에이전트는 stateless(매 턴 독립, Claude 세션 resume 안 함).
- 한 에이전트 실패가 프로세스를 죽이지 않게 작업 경계 try/catch(설계 §10.3).
- 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- 스펙: `docs/superpowers/specs/2026-06-26-phase1-reader-cli-design.md`.

---

## File Structure

```
src/brain/
 ├ brain.port.ts          BrainProvider 인터페이스 + BrainResult + BRAIN 토큰
 ├ fake-brain.ts          테스트용 고정 BrainResult 제공자
 ├ semaphore.ts           동시 실행 상한 (p-limit 대체)
 ├ brain.config.ts        brains.json 로더 (복수 프로필 + default + env 덮어쓰기)
 ├ claude-cli.brain.ts    claude -p 어댑터 (cross-spawn + stream-json + Semaphore)
 └ brain.module.ts        BRAIN provider 와이어링
src/agent-layer/
 ├ reader-agent.ts        A: 질문→검색→컨텍스트→brain→답+출처
 ├ orchestrator.ts        미니 스텁 (route()=reader.handle 위임)
 └ agent-layer.module.ts
src/edge/
 ├ core-message.ts        CoreMessage 타입
 ├ cli.gateway.ts         원샷 + REPL 어댑터
 └ edge.module.ts
src/cli.ts                CLI 진입점 (standalone 컨텍스트 → Gateway)
```

수정: `src/pal/path-resolver.ts`(getConfigDir 추가), `src/knowledge-core/knowledge-core.module.ts`(PinoLogger export), `src/app.module.ts`(모듈 추가), `package.json`(cross-spawn dep + bin/scripts).

---

## Task 1: BrainProvider 포트 + FakeBrain

**Files:**
- Create: `src/brain/brain.port.ts`
- Create: `src/brain/fake-brain.ts`
- Test: `src/brain/fake-brain.spec.ts`

**Interfaces:**
- Produces: `interface BrainResult { text: string; costUsd: number; isError: boolean; raw?: unknown }`, `interface BrainProvider { complete(prompt: string, onChunk?: (text: string) => void): Promise<BrainResult> }`, `const BRAIN: symbol`, `class FakeBrain implements BrainProvider`(생성자 인자로 고정 결과 주입).

- [ ] **Step 1: Write the failing test**

`src/brain/fake-brain.spec.ts`:
```ts
import { FakeBrain } from './fake-brain';

describe('FakeBrain', () => {
  it('주입한 결과를 반환한다', async () => {
    const brain = new FakeBrain({ text: '답', costUsd: 0, isError: false });
    const r = await brain.complete('질문');
    expect(r.text).toBe('답');
    expect(r.isError).toBe(false);
  });

  it('onChunk가 있으면 텍스트를 흘려보낸다', async () => {
    const brain = new FakeBrain({ text: 'hello', costUsd: 0, isError: false });
    const chunks: string[] = [];
    await brain.complete('q', (t) => chunks.push(t));
    expect(chunks.join('')).toBe('hello');
  });

  it('기본 결과는 isError=false', async () => {
    const r = await new FakeBrain().complete('q');
    expect(r.isError).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/brain/fake-brain.spec.ts`
Expected: FAIL — "Cannot find module './fake-brain'".

- [ ] **Step 3: Write the port and fake**

`src/brain/brain.port.ts`:
```ts
// 교체 가능한 두뇌 포트(설계 §7.5). Phase 1 어댑터 = ClaudeCliBrain 1개.
export interface BrainResult {
  text: string; // 최종 답 본문
  costUsd: number; // 호출 비용(없으면 0)
  isError: boolean; // CLI 오류/타임아웃 여부
  raw?: unknown; // 원본 응답(디버깅용)
}

export interface BrainProvider {
  // onChunk: 텍스트 조각이 생성될 때마다 호출(스트리밍). 생략 시 블로킹 수집.
  complete(prompt: string, onChunk?: (text: string) => void): Promise<BrainResult>;
}

export const BRAIN = Symbol('BRAIN'); // DI 토큰
```

`src/brain/fake-brain.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { BrainProvider, BrainResult } from './brain.port';

// 결정론적 가짜 두뇌. 실 claude 호출 없이 단위테스트에 쓴다(FakeEmbedder와 같은 역할).
@Injectable()
export class FakeBrain implements BrainProvider {
  constructor(
    private readonly result: BrainResult = { text: 'fake answer', costUsd: 0, isError: false },
  ) {}

  async complete(_prompt: string, onChunk?: (text: string) => void): Promise<BrainResult> {
    if (onChunk) onChunk(this.result.text);
    return this.result;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/brain/fake-brain.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/brain/brain.port.ts src/brain/fake-brain.ts src/brain/fake-brain.spec.ts
git commit -m "feat(brain): BrainProvider 포트 + FakeBrain

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Semaphore (동시 실행 상한)

**Files:**
- Create: `src/brain/semaphore.ts`
- Test: `src/brain/semaphore.spec.ts`

**Interfaces:**
- Produces: `class Semaphore { constructor(max: number); run<T>(fn: () => Promise<T>): Promise<T> }`.

- [ ] **Step 1: Write the failing test**

`src/brain/semaphore.spec.ts`:
```ts
import { Semaphore } from './semaphore';

describe('Semaphore', () => {
  it('max=1이면 동시 실행 최대치를 1로 제한한다', async () => {
    const sem = new Semaphore(1);
    let active = 0;
    let peak = 0;
    const task = () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      });
    await Promise.all([task(), task(), task()]);
    expect(peak).toBe(1);
  });

  it('max=2면 동시 2개까지 허용한다', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      });
    await Promise.all([task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });

  it('작업이 throw해도 다음 대기자를 풀어준다', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(sem.run(async () => 42)).resolves.toBe(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/brain/semaphore.spec.ts`
Expected: FAIL — "Cannot find module './semaphore'".

- [ ] **Step 3: Write the implementation**

`src/brain/semaphore.ts`:
```ts
// 동시 실행 상한(설계 §8 — 동시에 생각하는 두뇌 수에 천장).
// ponytail: p-limit 대체 인라인 구현. p-limit v4+는 순수 ESM이라 CJS(ts-jest/Nest)와 충돌.
//           기능이 더 필요해지면 p-limit@3(CJS)로 교체.
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/brain/semaphore.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/brain/semaphore.ts src/brain/semaphore.spec.ts
git commit -m "feat(brain): 동시 호출 상한 Semaphore (p-limit 대체)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: PathResolver.getConfigDir()

**Files:**
- Modify: `src/pal/path-resolver.ts`
- Test: `src/pal/path-resolver.spec.ts` (기존 파일에 추가)

**Interfaces:**
- Produces: `PathResolver.getConfigDir(): string` → `<dataDir>/config`.

- [ ] **Step 1: Write the failing test**

`src/pal/path-resolver.spec.ts`에 추가:
```ts
  it('getConfigDir는 dataDir 아래 config를 반환한다', () => {
    const r = new PathResolver('/data');
    expect(r.getConfigDir()).toBe(require('path').join('/data', 'config'));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/pal/path-resolver.spec.ts`
Expected: FAIL — "getConfigDir is not a function".

- [ ] **Step 3: Add the method**

`src/pal/path-resolver.ts`의 `getRagDir()` 아래에 추가:
```ts
  // 설정(brains.json 등) 디렉토리(설계 §15 runtime/config).
  getConfigDir(): string {
    return path.join(this.dataDir, 'config');
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/pal/path-resolver.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pal/path-resolver.ts src/pal/path-resolver.spec.ts
git commit -m "feat(pal): PathResolver.getConfigDir (runtime/config)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: brains.json 설정 로더

**Files:**
- Create: `src/brain/brain.config.ts`
- Test: `src/brain/brain.config.spec.ts`

**Interfaces:**
- Consumes: `PathResolver.getConfigDir()` (Task 3).
- Produces: `interface BrainProfile { provider: string; cli: string; model: string; concurrency: number; timeoutMs: number; extraArgs: string[] }`, `function loadActiveBrain(configDir: string, env?: NodeJS.ProcessEnv): BrainProfile`.

- [ ] **Step 1: Write the failing test**

`src/brain/brain.config.spec.ts`:
```ts
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { loadActiveBrain } from './brain.config';

describe('loadActiveBrain', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cfg-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('파일이 없으면 기본 brains.json을 만들고 default 프로필을 반환한다', () => {
    const p = loadActiveBrain(dir, {});
    expect(p.provider).toBe('claude-cli');
    expect(p.cli).toBe('claude');
    expect(p.concurrency).toBe(2);
    expect(fs.existsSync(path.join(dir, 'brains.json'))).toBe(true);
  });

  it('파일의 default 프로필을 읽는다', () => {
    fs.writeFileSync(
      path.join(dir, 'brains.json'),
      JSON.stringify({ default: 'c', brains: { c: { provider: 'claude-cli', cli: 'claude', model: 'opus', concurrency: 5, timeoutMs: 9000, extraArgs: [] } } }),
    );
    const p = loadActiveBrain(dir, {});
    expect(p.model).toBe('opus');
    expect(p.concurrency).toBe(5);
  });

  it('env가 활성 프로필을 덮어쓴다', () => {
    const p = loadActiveBrain(dir, { ENGRAM_BRAIN_MODEL: 'haiku', ENGRAM_BRAIN_CONCURRENCY: '1' });
    expect(p.model).toBe('haiku');
    expect(p.concurrency).toBe(1);
  });

  it('default가 가리키는 프로필이 없으면 throw', () => {
    fs.writeFileSync(path.join(dir, 'brains.json'), JSON.stringify({ default: 'x', brains: {} }));
    expect(() => loadActiveBrain(dir, {})).toThrow(/default/);
  });

  it('claude-cli가 아닌 provider는 거부한다', () => {
    fs.writeFileSync(
      path.join(dir, 'brains.json'),
      JSON.stringify({ default: 'g', brains: { g: { provider: 'gemini-api' } } }),
    );
    expect(() => loadActiveBrain(dir, {})).toThrow(/provider/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/brain/brain.config.spec.ts`
Expected: FAIL — "Cannot find module './brain.config'".

- [ ] **Step 3: Write the loader**

`src/brain/brain.config.ts`:
```ts
import * as fs from 'fs';
import * as path from 'path';

// 두뇌 프로필 — brains.json의 한 항목(설계 §4.3).
export interface BrainProfile {
  provider: string;
  cli: string;
  model: string;
  concurrency: number;
  timeoutMs: number;
  extraArgs: string[];
}

interface BrainsFile {
  default: string;
  brains: Record<string, Partial<BrainProfile>>;
}

const DEFAULTS: BrainProfile = {
  provider: 'claude-cli',
  cli: 'claude',
  model: '',
  concurrency: 2,
  timeoutMs: 120000,
  extraArgs: [],
};

const DEFAULT_FILE: BrainsFile = { default: 'claude', brains: { claude: { ...DEFAULTS } } };

// runtime/config/brains.json에서 활성(default) 두뇌 프로필을 해소한다.
// 파일이 없으면 기본 파일을 1회 생성(사용자가 편집 가능). env는 활성 프로필 덮어쓰기.
export function loadActiveBrain(configDir: string, env: NodeJS.ProcessEnv = process.env): BrainProfile {
  const file = path.join(configDir, 'brains.json');
  let cfg: BrainsFile;
  if (fs.existsSync(file)) {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as BrainsFile;
  } else {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(DEFAULT_FILE, null, 2));
    cfg = DEFAULT_FILE;
  }

  const raw = cfg.brains?.[cfg.default];
  if (!raw) throw new Error(`brains.json: default '${cfg.default}' 프로필이 없습니다`);
  const profile: BrainProfile = { ...DEFAULTS, ...raw };

  if (env.ENGRAM_BRAIN_CLI) profile.cli = env.ENGRAM_BRAIN_CLI;
  if (env.ENGRAM_BRAIN_MODEL) profile.model = env.ENGRAM_BRAIN_MODEL;
  if (env.ENGRAM_BRAIN_CONCURRENCY) profile.concurrency = Number(env.ENGRAM_BRAIN_CONCURRENCY);
  if (env.ENGRAM_BRAIN_TIMEOUT_MS) profile.timeoutMs = Number(env.ENGRAM_BRAIN_TIMEOUT_MS);

  if (profile.provider !== 'claude-cli') {
    throw new Error(`지원하지 않는 provider: ${profile.provider} (Phase 1은 claude-cli만)`);
  }
  return profile;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/brain/brain.config.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/brain/brain.config.ts src/brain/brain.config.spec.ts
git commit -m "feat(brain): brains.json 로더 (복수 프로필 + default + env)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: ClaudeCliBrain 어댑터

**Files:**
- Modify: `package.json` (cross-spawn 추가)
- Create: `src/brain/claude-cli.brain.ts`
- Test: `src/brain/claude-cli.brain.spec.ts`

**Interfaces:**
- Consumes: `BrainProvider`/`BrainResult`(Task 1), `Semaphore`(Task 2), `BrainProfile`(Task 4), `cross-spawn`.
- Produces: `class ClaudeCliBrain implements BrainProvider`(생성자 인자 `profile: BrainProfile`).

- [ ] **Step 1: 의존성 추가**

```bash
npm install cross-spawn
npm install -D @types/cross-spawn
```
Expected: `package.json` dependencies에 `cross-spawn`, devDependencies에 `@types/cross-spawn` 추가.

- [ ] **Step 2: 실 claude 출력 형식 1회 확인 (현실 보정)**

Run: `claude -p "1+1?" --output-format stream-json --verbose`
확인할 것: 줄 단위 JSON 이벤트가 나오는지, 텍스트가 담긴 이벤트 형태(`type:"assistant"`의 `message.content[].text`), 마지막 `type:"result"` 이벤트의 `result`·`total_cost_usd`·`is_error` 필드명.
> 만약 토큰 단위 스트리밍이 필요하면 프로필 `extraArgs`에 `--include-partial-messages`를 넣고 `extractDelta`의 `stream_event` 분기가 처리한다. 필드명이 다르면 Step 4 구현을 실제 출력에 맞춰 조정(claude-code-guide 에이전트로 교차확인 가능).

- [ ] **Step 3: Write the failing test**

`src/brain/claude-cli.brain.spec.ts`:
```ts
import { EventEmitter } from 'events';
jest.mock('cross-spawn');
import spawn from 'cross-spawn';
import { ClaudeCliBrain } from './claude-cli.brain';
import { BrainProfile } from './brain.config';

const PROFILE: BrainProfile = { provider: 'claude-cli', cli: 'claude', model: '', concurrency: 1, timeoutMs: 1000, extraArgs: [] };

function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

describe('ClaudeCliBrain', () => {
  afterEach(() => jest.clearAllMocks());

  it('stream-json을 파싱해 텍스트 델타·최종 결과·비용을 정규화한다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new ClaudeCliBrain(PROFILE);
    const chunks: string[] = [];
    const p = brain.complete('q', (t) => chunks.push(t));
    child.stdout.emit('data', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '안녕' }] } }) + '\n');
    child.stdout.emit('data', JSON.stringify({ type: 'result', is_error: false, result: '안녕하세요', total_cost_usd: 0.01 }) + '\n');
    child.emit('close', 0);
    const r = await p;
    expect(chunks.join('')).toBe('안녕');
    expect(r.text).toBe('안녕하세요');
    expect(r.costUsd).toBe(0.01);
    expect(r.isError).toBe(false);
  });

  it('여러 data 청크에 걸친 JSON 줄을 버퍼링한다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new ClaudeCliBrain(PROFILE);
    const p = brain.complete('q');
    const line = JSON.stringify({ type: 'result', is_error: false, result: '쪼개진답', total_cost_usd: 0 }) + '\n';
    child.stdout.emit('data', line.slice(0, 10));
    child.stdout.emit('data', line.slice(10));
    child.emit('close', 0);
    const r = await p;
    expect(r.text).toBe('쪼개진답');
  });

  it('spawn 에러 시 isError를 반환한다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new ClaudeCliBrain(PROFILE);
    const p = brain.complete('q');
    child.emit('error', new Error('ENOENT'));
    const r = await p;
    expect(r.isError).toBe(true);
  });

  it('타임아웃 시 isError를 반환하고 kill한다', async () => {
    jest.useFakeTimers();
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new ClaudeCliBrain({ ...PROFILE, timeoutMs: 50 });
    const p = brain.complete('q');
    jest.advanceTimersByTime(60);
    const r = await p;
    expect(r.isError).toBe(true);
    expect(child.kill).toHaveBeenCalled();
    jest.useRealTimers();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx jest src/brain/claude-cli.brain.spec.ts`
Expected: FAIL — "Cannot find module './claude-cli.brain'".

- [ ] **Step 5: Write the adapter**

`src/brain/claude-cli.brain.ts`:
```ts
import { Injectable } from '@nestjs/common';
import spawn from 'cross-spawn';
import { BrainProvider, BrainResult } from './brain.port';
import { BrainProfile } from './brain.config';
import { Semaphore } from './semaphore';

// stream-json 이벤트에서 화면에 흘릴 텍스트 조각을 뽑는다.
// - assistant 메시지의 text 블록(메시지 단위 스트리밍)
// - --include-partial-messages 사용 시 stream_event의 text_delta(토큰 단위)
function extractDelta(ev: Record<string, unknown>): string {
  if (ev.type === 'assistant') {
    const content = (ev.message as { content?: Array<{ type?: string; text?: string }> })?.content;
    if (Array.isArray(content)) {
      return content.filter((c) => c?.type === 'text').map((c) => c.text ?? '').join('');
    }
  }
  if (ev.type === 'stream_event') {
    const event = ev.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      return event.delta.text ?? '';
    }
  }
  return '';
}

// Claude CLI(claude -p) 어댑터(설계 §7.5). 구독 한도 내 토큰 $0.
// 모든 호출이 complete() 한 메서드로 수렴 → Semaphore가 유일한 choke point(설계 §8).
@Injectable()
export class ClaudeCliBrain implements BrainProvider {
  private readonly sem: Semaphore;

  constructor(private readonly profile: BrainProfile) {
    this.sem = new Semaphore(profile.concurrency);
  }

  complete(prompt: string, onChunk?: (text: string) => void): Promise<BrainResult> {
    return this.sem.run(() => this.spawnOnce(prompt, onChunk));
  }

  private spawnOnce(prompt: string, onChunk?: (text: string) => void): Promise<BrainResult> {
    return new Promise<BrainResult>((resolve) => {
      const args = [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        ...(this.profile.model ? ['--model', this.profile.model] : []),
        ...this.profile.extraArgs,
      ];
      const child = spawn(this.profile.cli, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let buf = '';
      let text = '';
      let costUsd = 0;
      let isError = false;
      let settled = false;

      const finish = (r: BrainResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        resolve(r);
      };

      const timer = setTimeout(
        () => finish({ text, costUsd, isError: true, raw: 'timeout' }),
        this.profile.timeoutMs,
      );

      child.stdout?.on('data', (d: Buffer) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line);
          } catch {
            continue; // 부분 줄/비JSON은 건너뜀
          }
          const delta = extractDelta(ev);
          if (delta) {
            text += delta;
            onChunk?.(delta);
          }
          if (ev.type === 'result') {
            costUsd = Number(ev.total_cost_usd ?? 0);
            isError = Boolean(ev.is_error);
            if (typeof ev.result === 'string') text = ev.result; // 최종 권위 텍스트로 교체
          }
        }
      });

      child.on('error', () => finish({ text: '', costUsd: 0, isError: true, raw: 'spawn-error' }));
      child.on('close', () => finish({ text, costUsd, isError }));
    });
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/brain/claude-cli.brain.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/brain/claude-cli.brain.ts src/brain/claude-cli.brain.spec.ts
git commit -m "feat(brain): Claude CLI 어댑터 (cross-spawn + stream-json + 세마포어)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: BrainModule

**Files:**
- Create: `src/brain/brain.module.ts`
- Test: `src/brain/brain.module.spec.ts`

**Interfaces:**
- Consumes: `BRAIN`(Task 1), `ClaudeCliBrain`(Task 5), `loadActiveBrain`(Task 4), `PathResolver.getConfigDir`(Task 3), `FakeBrain`(Task 1).
- Produces: `class BrainModule`(BRAIN export).

- [ ] **Step 1: Write the failing test**

`src/brain/brain.module.spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { BrainModule } from './brain.module';
import { BRAIN, BrainProvider } from './brain.port';
import { FakeBrain } from './fake-brain';

describe('BrainModule', () => {
  it('BRAIN 토큰을 FakeBrain으로 override해 해소한다', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [BrainModule] })
      .overrideProvider(BRAIN).useValue(new FakeBrain({ text: 'ok', costUsd: 0, isError: false }))
      .compile();
    const brain = moduleRef.get<BrainProvider>(BRAIN);
    const r = await brain.complete('q');
    expect(r.text).toBe('ok');
    await moduleRef.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/brain/brain.module.spec.ts`
Expected: FAIL — "Cannot find module './brain.module'".

- [ ] **Step 3: Write the module**

`src/brain/brain.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { PathResolver } from '../pal/path-resolver';
import { BRAIN } from './brain.port';
import { ClaudeCliBrain } from './claude-cli.brain';
import { loadActiveBrain } from './brain.config';

// 두뇌 포트 와이어링(설계 §7.5). brains.json의 활성 프로필로 ClaudeCliBrain을 만든다.
// 테스트는 BRAIN을 FakeBrain으로 override(팩토리·실 claude 우회).
@Module({
  providers: [
    {
      provide: BRAIN,
      useFactory: () => new ClaudeCliBrain(loadActiveBrain(new PathResolver().getConfigDir())),
    },
  ],
  exports: [BRAIN],
})
export class BrainModule {}
```
> `new PathResolver()`는 `ENGRAM_DATA_DIR`(미지정 시 `<cwd>/runtime`)을 1회 읽는다 — KnowledgeCore와 같은 데이터 루트. 테스트는 BRAIN override로 이 팩토리를 건너뛴다.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/brain/brain.module.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain/brain.module.ts src/brain/brain.module.spec.ts
git commit -m "feat(brain): BrainModule — brains.json 활성 프로필로 BRAIN 와이어링

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: CoreMessage 타입

**Files:**
- Create: `src/edge/core-message.ts`
- Test: `src/edge/core-message.spec.ts`

**Interfaces:**
- Produces: `interface CoreMessage { text: string; userId: string }`.

- [ ] **Step 1: Write the failing test**

`src/edge/core-message.spec.ts`:
```ts
import { CoreMessage } from './core-message';

describe('CoreMessage', () => {
  it('text와 userId 필드를 갖는다', () => {
    const msg: CoreMessage = { text: '질문', userId: 'default' };
    expect(msg.text).toBe('질문');
    expect(msg.userId).toBe('default');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/edge/core-message.spec.ts`
Expected: FAIL — "Cannot find module './core-message'".

- [ ] **Step 3: Write the type**

`src/edge/core-message.ts`:
```ts
// 앞단 중립 메시지(설계 §9.1). Gateway 어댑터가 프론트엔드 입력을 이 타입으로 번역한다.
// 코어(Orchestrator/ReaderAgent)는 채널 ID·버튼 등 프론트 특유의 것을 모른다.
export interface CoreMessage {
  text: string; // 사용자 질문
  userId: string; // 멀티유저 네임스페이스(기본 DEFAULT_USER)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/edge/core-message.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edge/core-message.ts src/edge/core-message.spec.ts
git commit -m "feat(edge): CoreMessage — 앞단 중립 메시지 타입

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: ReaderAgent (A)

**Files:**
- Modify: `src/knowledge-core/knowledge-core.module.ts` (PinoLogger export 추가)
- Create: `src/agent-layer/reader-agent.ts`
- Test: `src/agent-layer/reader-agent.spec.ts`

**Interfaces:**
- Consumes: `RagStore.search(query, limit, userId): Promise<SearchResult[]>`(완료, `SearchResult = { userId?, slug, title, text, score }`), `BRAIN`/`BrainProvider`(Task 1), `CoreMessage`(Task 7), `PinoLogger.error(msg, trace?, ctx?)`(완료).
- Produces: `class ReaderAgent { handle(msg: CoreMessage, onChunk?: (t: string) => void): Promise<string> }`.

- [ ] **Step 1: Write the failing test**

`src/agent-layer/reader-agent.spec.ts`:
```ts
import { ReaderAgent } from './reader-agent';
import { FakeBrain } from '../brain/fake-brain';
import { SearchResult } from '../knowledge-core/rag/rag.types';

// RagStore의 search만 쓰는 최소 스텁.
function stubRag(results: SearchResult[]) {
  return { search: jest.fn(async () => results) } as any;
}
const logger = { error: jest.fn() } as any;

describe('ReaderAgent', () => {
  it('검색 결과를 컨텍스트로 brain에 넘기고 답+출처를 반환한다', async () => {
    const rag = stubRag([{ slug: 'a', title: 'A페이지', text: '본문', score: 1 }]);
    const reader = new ReaderAgent(rag, new FakeBrain({ text: '답이다', costUsd: 0, isError: false }), logger);
    const out = await reader.handle({ text: '질문', userId: 'default' });
    expect(rag.search).toHaveBeenCalledWith('질문', 5, 'default');
    expect(out).toContain('답이다');
    expect(out).toContain('출처:');
    expect(out).toContain('A페이지');
    expect(out).toContain('(a)');
  });

  it('검색 결과가 없으면 경고 머리말을 붙이고 출처는 없다', async () => {
    const rag = stubRag([]);
    const reader = new ReaderAgent(rag, new FakeBrain({ text: '일반답', costUsd: 0, isError: false }), logger);
    const out = await reader.handle({ text: '질문', userId: 'default' });
    expect(out).toContain('⚠ 위키에 관련 내용 없음');
    expect(out).not.toContain('출처:');
  });

  it('brain이 isError면 실패 메시지를 반환한다', async () => {
    const rag = stubRag([{ slug: 'a', title: 'A', text: 'b', score: 1 }]);
    const reader = new ReaderAgent(rag, new FakeBrain({ text: '', costUsd: 0, isError: true }), logger);
    const out = await reader.handle({ text: '질문', userId: 'default' });
    expect(out).toContain('답변 생성 실패');
  });

  it('예외가 나도 프로세스를 죽이지 않고 실패 메시지를 반환한다', async () => {
    const rag = { search: jest.fn(async () => { throw new Error('rag down'); }) } as any;
    const reader = new ReaderAgent(rag, new FakeBrain(), logger);
    const out = await reader.handle({ text: '질문', userId: 'default' });
    expect(out).toContain('답변 생성 실패');
    expect(logger.error).toHaveBeenCalled();
  });

  it('onChunk로 머리말·본문·출처를 흘려보낸다(스트리밍)', async () => {
    const rag = stubRag([{ slug: 'a', title: 'A페이지', text: 'b', score: 1 }]);
    const reader = new ReaderAgent(rag, new FakeBrain({ text: '스트림답', costUsd: 0, isError: false }), logger);
    const chunks: string[] = [];
    await reader.handle({ text: '질문', userId: 'default' }, (t) => chunks.push(t));
    const joined = chunks.join('');
    expect(joined).toContain('스트림답');
    expect(joined).toContain('출처:');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/agent-layer/reader-agent.spec.ts`
Expected: FAIL — "Cannot find module './reader-agent'".

- [ ] **Step 3: Write ReaderAgent**

`src/agent-layer/reader-agent.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { RagStore } from '../knowledge-core/rag/rag-store';
import { SearchResult } from '../knowledge-core/rag/rag.types';
import { BRAIN, BrainProvider } from '../brain/brain.port';
import { PinoLogger } from '../pal/logger';
import { CoreMessage } from '../edge/core-message';

const NO_HITS_HEADER = '⚠ 위키에 관련 내용 없음 — 일반 지식 기반 답변\n\n';

// A 읽기(설계 §7.2). 질문 → RAG 검색 → 컨텍스트 종합 → 답 + 출처. 매 턴 독립(stateless).
@Injectable()
export class ReaderAgent {
  constructor(
    private readonly rag: RagStore,
    @Inject(BRAIN) private readonly brain: BrainProvider,
    private readonly logger: PinoLogger,
  ) {}

  async handle(msg: CoreMessage, onChunk?: (t: string) => void): Promise<string> {
    const emit = (s: string): void => onChunk?.(s);
    try {
      const hits = await this.rag.search(msg.text, 5, msg.userId);
      const header = hits.length === 0 ? NO_HITS_HEADER : '';
      if (header) emit(header);

      const result = await this.brain.complete(this.buildPrompt(msg.text, hits), onChunk);
      if (result.isError) {
        const m = '답변 생성 실패: 두뇌 호출 오류';
        emit(m);
        return header + m;
      }

      const sources = hits.length
        ? `\n\n───\n출처: ${hits.map((h, i) => `[${i + 1}] ${h.title} (${h.slug})`).join(' · ')}`
        : '';
      emit(sources);
      return header + result.text + sources;
    } catch (err) {
      this.logger.error('ReaderAgent.handle 실패', String(err), 'ReaderAgent');
      const m = `답변 생성 실패: ${String(err)}`;
      emit(m);
      return m;
    }
  }

  // 검색된 위키를 번호 매긴 컨텍스트로 조립 + 근거 우선·출처 표기 지시.
  private buildPrompt(question: string, hits: SearchResult[]): string {
    const ctx = hits.map((h, i) => `[${i + 1}] ${h.title} (slug: ${h.slug})\n${h.text}`).join('\n\n');
    return [
      '아래 검색된 위키 내용을 우선 근거로 질문에 답하라.',
      '사용한 근거는 [n]으로 표기하라. 검색 내용으로 답할 수 없으면 위키 밖 일반 지식임을 명시하라.',
      '',
      `# 검색된 위키\n${ctx || '(없음)'}`,
      '',
      `# 질문\n${question}`,
    ].join('\n');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/agent-layer/reader-agent.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: KnowledgeCoreModule에서 PinoLogger를 export**

`src/knowledge-core/knowledge-core.module.ts`의 `exports` 배열을 수정:
```ts
  exports: [WikiEngine, RagStore, PinoLogger],
```
(ReaderAgent가 같은 PinoLogger 인스턴스를 주입받게 — 별도 인스턴스/로그파일 중복 방지.)

- [ ] **Step 6: 무회귀 확인**

Run: `npx jest src/knowledge-core/knowledge-core.module.spec.ts src/agent-layer/reader-agent.spec.ts`
Expected: PASS (기존 모듈 테스트 + ReaderAgent).

- [ ] **Step 7: Commit**

```bash
git add src/agent-layer/reader-agent.ts src/agent-layer/reader-agent.spec.ts src/knowledge-core/knowledge-core.module.ts
git commit -m "feat(agent): ReaderAgent — 위키 근거 우선·출처 명시·스트리밍

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Orchestrator 스텁 + AgentLayerModule

**Files:**
- Create: `src/agent-layer/orchestrator.ts`
- Create: `src/agent-layer/agent-layer.module.ts`
- Test: `src/agent-layer/orchestrator.spec.ts`
- Test: `src/agent-layer/agent-layer.module.spec.ts`

**Interfaces:**
- Consumes: `ReaderAgent`(Task 8), `KnowledgeCoreModule`(RagStore·PinoLogger export), `BrainModule`(BRAIN export), `CoreMessage`(Task 7).
- Produces: `class Orchestrator { route(msg: CoreMessage, onChunk?): Promise<string> }`, `class AgentLayerModule`(Orchestrator export).

- [ ] **Step 1: Write the failing tests**

`src/agent-layer/orchestrator.spec.ts`:
```ts
import { Orchestrator } from './orchestrator';

describe('Orchestrator (스텁)', () => {
  it('route는 reader.handle로 위임하고 onChunk를 통과시킨다', async () => {
    const reader = { handle: jest.fn(async () => '답') } as any;
    const orch = new Orchestrator(reader);
    const cb = jest.fn();
    const out = await orch.route({ text: 'q', userId: 'default' }, cb);
    expect(out).toBe('답');
    expect(reader.handle).toHaveBeenCalledWith({ text: 'q', userId: 'default' }, cb);
  });
});
```

`src/agent-layer/agent-layer.module.spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { AgentLayerModule } from './agent-layer.module';
import { Orchestrator } from './orchestrator';
import { BRAIN } from '../brain/brain.port';
import { FakeBrain } from '../brain/fake-brain';
import { EMBEDDER } from '../knowledge-core/rag/embedder.port';
import { FakeEmbedder } from '../knowledge-core/rag/fake-embedder';
import { PathResolver } from '../pal/path-resolver';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

describe('AgentLayerModule (integration)', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-al-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('Orchestrator를 해소하고 빈 위키에 질의하면 일반지식 머리말을 반환한다', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AgentLayerModule] })
      .overrideProvider(PathResolver).useValue(new PathResolver(dir))
      .overrideProvider(EMBEDDER).useClass(FakeEmbedder)
      .overrideProvider(BRAIN).useValue(new FakeBrain({ text: '일반답', costUsd: 0, isError: false }))
      .compile();
    await moduleRef.init();
    const orch = moduleRef.get(Orchestrator);
    const out = await orch.route({ text: '없는질문', userId: 'default' });
    expect(out).toContain('⚠ 위키에 관련 내용 없음');
    await moduleRef.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/agent-layer/orchestrator.spec.ts src/agent-layer/agent-layer.module.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write Orchestrator + module**

`src/agent-layer/orchestrator.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { ReaderAgent } from './reader-agent';
import { CoreMessage } from '../edge/core-message';

// 허브(설계 §7.1). 모든 흐름이 경유 — Gateway는 Orchestrator만 알고 에이전트를 직접 모른다.
// Phase 1은 단일 에이전트라 위임만. Phase 3에서 분해·종합·TurnBudget이 여기 채워진다.
@Injectable()
export class Orchestrator {
  constructor(private readonly reader: ReaderAgent) {}

  route(msg: CoreMessage, onChunk?: (t: string) => void): Promise<string> {
    return this.reader.handle(msg, onChunk);
  }
}
```

`src/agent-layer/agent-layer.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { KnowledgeCoreModule } from '../knowledge-core/knowledge-core.module';
import { BrainModule } from '../brain/brain.module';
import { ReaderAgent } from './reader-agent';
import { Orchestrator } from './orchestrator';

// AgentLayer(설계 §7). 코어(RagStore·PinoLogger)와 두뇌(BRAIN)를 소비.
@Module({
  imports: [KnowledgeCoreModule, BrainModule],
  providers: [ReaderAgent, Orchestrator],
  exports: [Orchestrator],
})
export class AgentLayerModule {}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/agent-layer/orchestrator.spec.ts src/agent-layer/agent-layer.module.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent-layer/orchestrator.ts src/agent-layer/agent-layer.module.ts src/agent-layer/orchestrator.spec.ts src/agent-layer/agent-layer.module.spec.ts
git commit -m "feat(agent): 미니 Orchestrator 스텁 + AgentLayerModule

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: CLI Gateway + EdgeModule + 진입점 배선

**Files:**
- Create: `src/edge/cli.gateway.ts`
- Create: `src/edge/edge.module.ts`
- Create: `src/cli.ts`
- Test: `src/edge/cli.gateway.spec.ts`
- Modify: `src/app.module.ts` (모듈 추가)
- Modify: `package.json` (bin + start:cli 스크립트)

**Interfaces:**
- Consumes: `Orchestrator`(Task 9), `CoreMessage`(Task 7), `DEFAULT_USER`(`../pal/path-resolver`), `AppModule`.
- Produces: `class CliGateway { run(argv: string[]): Promise<void> }`, `class EdgeModule`(CliGateway export).

- [ ] **Step 1: Write the failing test**

`src/edge/cli.gateway.spec.ts`:
```ts
import { CliGateway } from './cli.gateway';

describe('CliGateway', () => {
  let writes: string[];
  let spy: jest.SpyInstance;
  beforeEach(() => {
    writes = [];
    spy = jest.spyOn(process.stdout, 'write').mockImplementation((s: any) => { writes.push(String(s)); return true; });
  });
  afterEach(() => spy.mockRestore());

  it('ask 모드: 인수를 CoreMessage로 만들어 route하고 스트림을 stdout에 쓴다', async () => {
    const orch = { route: jest.fn(async (_m, onChunk?: (t: string) => void) => { onChunk?.('답변'); return '답변'; }) } as any;
    await new CliGateway(orch).run(['ask', '안녕', '세계']);
    expect(orch.route).toHaveBeenCalledWith({ text: '안녕 세계', userId: 'default' }, expect.any(Function));
    expect(writes.join('')).toContain('답변');
  });

  it('알 수 없는 인수는 사용법을 출력한다', async () => {
    const orch = { route: jest.fn() } as any;
    await new CliGateway(orch).run(['bogus']);
    expect(orch.route).not.toHaveBeenCalled();
    expect(writes.join('')).toContain('사용법');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/edge/cli.gateway.spec.ts`
Expected: FAIL — "Cannot find module './cli.gateway'".

- [ ] **Step 3: Write CliGateway**

`src/edge/cli.gateway.ts`:
```ts
import * as readline from 'readline';
import { Injectable } from '@nestjs/common';
import { Orchestrator } from '../agent-layer/orchestrator';
import { DEFAULT_USER } from '../pal/path-resolver';

// CLI 어댑터(설계 §9.1). 인수 파싱·프롬프트·stdout 쓰기 등 CLI 특유의 것을 여기 가둔다.
// 코어는 CoreMessage만 본다. 원샷·REPL 모두 같은 orchestrator.route()로 수렴.
@Injectable()
export class CliGateway {
  constructor(private readonly orchestrator: Orchestrator) {}

  async run(argv: string[]): Promise<void> {
    if (argv[0] === 'ask' && argv[1]) {
      await this.ask(argv.slice(1).join(' '));
    } else if (argv.length === 0) {
      await this.repl();
    } else {
      process.stdout.write('사용법: engram ask "질문"  |  engram (REPL)\n');
    }
  }

  private async ask(question: string): Promise<void> {
    await this.orchestrator.route(
      { text: question, userId: DEFAULT_USER },
      (t) => process.stdout.write(t),
    );
    process.stdout.write('\n');
  }

  private async repl(): Promise<void> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write('Engram REPL — 질문을 입력하세요 (exit 종료)\n> ');
    for await (const line of rl) {
      const q = line.trim();
      if (q === 'exit' || q === 'quit') break;
      if (q) {
        await this.orchestrator.route({ text: q, userId: DEFAULT_USER }, (t) => process.stdout.write(t));
        process.stdout.write('\n');
      }
      process.stdout.write('> ');
    }
    rl.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/edge/cli.gateway.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write EdgeModule + cli.ts + AppModule 배선**

`src/edge/edge.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AgentLayerModule } from '../agent-layer/agent-layer.module';
import { CliGateway } from './cli.gateway';

// Edge(설계 §9). Gateway 어댑터를 AgentLayer(Orchestrator) 앞단에 둔다.
@Module({
  imports: [AgentLayerModule],
  providers: [CliGateway],
  exports: [CliGateway],
})
export class EdgeModule {}
```

`src/cli.ts`:
```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CliGateway } from './edge/cli.gateway';

// CLI 진입점(설계 §9.1). main.ts(상주)와 분리 — 질문하고 종료.
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  await app.init();
  const gateway = app.get(CliGateway);
  await gateway.run(process.argv.slice(2));
  await app.close();
}

void main();
```

`src/app.module.ts`를 수정:
```ts
import { Module } from '@nestjs/common';
import { KnowledgeCoreModule } from './knowledge-core/knowledge-core.module';
import { AgentLayerModule } from './agent-layer/agent-layer.module';
import { EdgeModule } from './edge/edge.module';

// Engram 루트 모듈.
@Module({
  imports: [KnowledgeCoreModule, AgentLayerModule, EdgeModule],
})
export class AppModule {}
```

`package.json`에 추가(`scripts`에 `start:cli`, 최상위에 `bin`):
```json
  "bin": { "engram": "dist/cli.js" },
```
그리고 `scripts`에:
```json
    "start:cli": "ts-node src/cli.ts",
```

- [ ] **Step 6: 전체 테스트 + 빌드 무회귀 확인**

Run: `npx jest` 그리고 `npm run build`
Expected: 전체 PASS(신규 + 기존 Phase 0), tsc/nest build 클린.

- [ ] **Step 7: 수동 스모크(실 claude — 선택, 환경에 claude 있을 때)**

Run: `npm run build && node dist/cli.js ask "엔그램이 뭐야?"`
Expected: 답이 글자 단위로 흘러나오고, 빈 위키면 `⚠ 위키에 관련 내용 없음` 머리말. 프로세스가 깔끔히 종료. (`runtime/config/brains.json`이 자동 생성됨.)

- [ ] **Step 8: Commit**

```bash
git add src/edge/cli.gateway.ts src/edge/cli.gateway.spec.ts src/edge/edge.module.ts src/cli.ts src/app.module.ts package.json
git commit -m "feat(edge): CLI Gateway(원샷+REPL) + cli.ts 진입점 + 모듈 배선

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 완료 확인 (스펙 §10 대조)

- [ ] `node dist/cli.js ask "질문"` → 위키 근거 답이 스트리밍 + 출처 목록 (Task 10 Step 7).
- [ ] 인수 없이 → REPL 연속 질의 (Task 10 — `repl()`).
- [ ] 위키에 없는 질문 → `⚠` 머리말 + 일반 지식 (Task 8, Task 9 통합 테스트).
- [ ] 두뇌 동시 호출이 `concurrency`를 넘지 않음 (Task 2 + Task 5).
- [ ] CLI 타임아웃·오류가 프로세스를 안 죽이고 실패 메시지로 전달 (Task 5 timeout/error, Task 8 try/catch).
- [ ] Gateway가 ReaderAgent를 직접 참조 안 함 — Orchestrator만 주입 (Task 10).
- [ ] 모델·경로·동시 수·타임아웃이 `brains.json`에서 옴 (Task 4 + Task 6).
- [ ] 신규 단위 테스트 통과 + 기존 Phase 0 무회귀 (Task 10 Step 6).
