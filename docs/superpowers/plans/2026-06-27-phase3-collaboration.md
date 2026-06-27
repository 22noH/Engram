# Phase 3 — B 협업 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 여러 페르소나 에이전트가 Orchestrator(유일 배정구)와 공유 블랙보드를 경유해 협업하는 B 레이어를 짓고, Phase 4가 올라탈 이종 두뇌·도구 권한 토대를 같이 깐다.

**Architecture:** 에이전트끼리 직접 대화 0 — 모든 흐름은 Orchestrator를 경유하고, 기여는 TaskStore(FSM 블랙보드)에 stigmergy로 쌓인다. 두뇌는 하네스 1개(Claude Code) + 백엔드 env 교체(로컬LLM 흡수) + Gemini/Codex 네이티브 CLI 어댑터. 도구 권한은 새 엔진 없이 각 하네스 네이티브 권한을 config로 운전.

**Tech Stack:** NestJS / TypeScript / Node 22+ / Jest / cross-spawn / gray-matter(frontmatter) / @nestjs/schedule

**Spec:** [docs/superpowers/specs/2026-06-27-phase3-collaboration-design.md](../specs/2026-06-27-phase3-collaboration-design.md)

## Global Constraints

- 셸 스크립트 0개. 경로는 `path.join`, spawn은 `cross-spawn`(하드코딩 금지, DESIGN §3·§12).
- 모든 캐시·맵은 크기 제한 또는 정리 경로 보유(상주 위생 §10.3). 작업 경계마다 try/catch — 한 에이전트 실패가 프로세스를 안 죽임.
- 단일 라이터 / 페이지 락: 공유 상태 동시쓰기는 기존 `KeyedLock`(`run(key, fn)`)으로 직렬화. 새 락 안 만듦.
- 두뇌 동시호출 상한 = 기존 `Semaphore`(`run(fn)`). 매 두뇌 호출은 별도 프로세스 spawn.
- 환경 = Windows + PowerShell(Bash 도구 깨짐). 서브에이전트는 PowerShell 도구로 npm/npx/git 실행. **한글 stdin은 PS 파이프로 넘기지 말 것**(`???`로 깨짐) — 테스트 입력은 파일/인자로.
- 데이터는 `runtime/`(git 미추적). 코드와 분리.
- 커밋 푸터: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- 공유/커밋 문서에 타 프로젝트 비교·약점 언급 금지.

## 기존 자산(재사용 — 다시 만들지 말 것)

- `BrainProvider` 포트: `complete(prompt: string, onChunk?: (text:string)=>void): Promise<BrainResult>`. `BrainResult = { text, costUsd, isError, raw? }`. DI 토큰 `BRAIN`, `JUDGE_BRAIN`.
- `ClaudeCliBrain(profile: BrainProfile)` — `src/brain/claude-cli.brain.ts`. spawn은 49행.
- `BrainProfile = { provider, cli, model, concurrency, timeoutMs, extraArgs }` — `src/brain/brain.config.ts`. `loadActiveBrain(configDir)`, `loadBrainProfile(configDir, name)`.
- `FakeBrain(result?)` — 결정론 두뇌(테스트용).
- `Semaphore(n).run(fn)` — `src/brain/semaphore.ts`.
- `KeyedLock.run(key, fn)` — `src/knowledge-core/keyed-lock.ts`.
- `PathResolver`: `getDataDir/getConfigDir/getWikiPagesDir(userId)/...` — `src/pal/path-resolver.ts`. `DEFAULT_USER='default'`.
- `Orchestrator.route(msg, onChunk)`, `.digest(userId)` — `src/agent-layer/orchestrator.ts`.
- `ReaderAgent.handle(msg, onChunk)`. `CoreMessage = { text, userId }`.
- `WikiEngine`(페이지 CRUD, userId 후행 옵셔널), `PinoLogger.{info,warn,error}(msg, ...ctx)`.
- gray-matter는 이미 의존성에 있음(page-serializer가 사용).

---

# 1부 — 토대 (Task 1–9)

## Task 1: PathResolver.getStateDir + TaskStore 타입·FSM·create/get

**Files:**
- Modify: `src/pal/path-resolver.ts` (getStateDir 추가)
- Create: `src/knowledge-core/task-store.ts`
- Create: `src/knowledge-core/task-store.spec.ts`

**Interfaces:**
- Produces:
  - `getStateDir(): string` → `<dataDir>/state`
  - `type TaskStatus = 'PENDING'|'RUNNING'|'SUCCESS'|'FAILED'`
  - `type TaskKind = 'collaboration'|'board-decision'`
  - `interface TaskRecord { id:string; kind:TaskKind; status:TaskStatus; question:string; assignees:string[]; blackboard:Record<string,string>; result:string|null; createdAt:string; updatedAt:string }`
  - `class TaskStore` with `create(input:{kind:TaskKind; question:string; assignees:string[]}): Promise<TaskRecord>`, `get(id:string): Promise<TaskRecord|null>`

- [ ] **Step 1: getStateDir 실패 테스트**

`src/pal/path-resolver.spec.ts`에 추가:
```typescript
it('getStateDir는 dataDir/state를 가리킨다', () => {
  const r = new PathResolver('/tmp/x');
  expect(r.getStateDir()).toBe(require('path').join('/tmp/x', 'state'));
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest path-resolver -t getStateDir`. Expected: FAIL(getStateDir 없음).

- [ ] **Step 3: getStateDir 구현** — `src/pal/path-resolver.ts`의 `getConfigDir` 아래에 추가:
```typescript
  // 공유 상태(TaskStore 등) 디렉토리(설계 §15 runtime/state).
  getStateDir(): string {
    return path.join(this.dataDir, 'state');
  }
```

- [ ] **Step 4: 통과 확인** — Run: `npx jest path-resolver -t getStateDir`. Expected: PASS.

- [ ] **Step 5: TaskStore create/get 실패 테스트**

`src/knowledge-core/task-store.spec.ts`:
```typescript
import { TaskStore } from './task-store';
import { KeyedLock } from './keyed-lock';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function tmpStore(): { store: TaskStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-task-'));
  return { store: new TaskStore(dir, new KeyedLock()), dir };
}

describe('TaskStore create/get', () => {
  it('레코드를 PENDING으로 만들고 다시 읽는다', async () => {
    const { store } = tmpStore();
    const t = await store.create({ kind: 'collaboration', question: 'Q', assignees: ['Brand'] });
    expect(t.status).toBe('PENDING');
    expect(t.id).toMatch(/^task_/);
    expect(t.blackboard).toEqual({});
    const again = await store.get(t.id);
    expect(again?.question).toBe('Q');
  });

  it('없는 id는 null', async () => {
    const { store } = tmpStore();
    expect(await store.get('task_none')).toBeNull();
  });
});
```

- [ ] **Step 6: 실패 확인** — Run: `npx jest task-store`. Expected: FAIL(모듈 없음).

- [ ] **Step 7: TaskStore 구현(create/get)**

`src/knowledge-core/task-store.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { KeyedLock } from './keyed-lock';

export type TaskStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';
export type TaskKind = 'collaboration' | 'board-decision';

export interface TaskRecord {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  question: string;
  assignees: string[];
  blackboard: Record<string, string>;
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

// 협업/회의의 공유 블랙보드(설계 §5.1). runtime/state/*.json, 레코드별 KeyedLock 단일라이터.
// 진실은 여기(파일)에 — 에이전트는 stateless(Phase4 seam #2). 진전은 status·blackboard로 관측(seam #4).
@Injectable()
export class TaskStore {
  private seq = 0;
  constructor(
    private readonly stateDir: string,
    private readonly lock: KeyedLock,
  ) {}

  async create(input: { kind: TaskKind; question: string; assignees: string[] }): Promise<TaskRecord> {
    const now = new Date().toISOString();
    // id 충돌 방지: 타임스탬프 + 프로세스 내 단조 증가 시퀀스(Math.random 미사용 — 결정 가능·재현성).
    const id = `task_${now.replace(/[:.]/g, '-')}_${(this.seq++).toString(36)}`;
    const rec: TaskRecord = {
      id, kind: input.kind, status: 'PENDING', question: input.question,
      assignees: input.assignees, blackboard: {}, result: null, createdAt: now, updatedAt: now,
    };
    await this.write(rec);
    return rec;
  }

  async get(id: string): Promise<TaskRecord | null> {
    try {
      const raw = await fs.promises.readFile(this.file(id), 'utf8');
      return JSON.parse(raw) as TaskRecord;
    } catch {
      return null; // 없음/깨짐 → null(읽기는 락 불요)
    }
  }

  private file(id: string): string {
    return path.join(this.stateDir, `${id}.json`);
  }

  private async write(rec: TaskRecord): Promise<void> {
    await fs.promises.mkdir(this.stateDir, { recursive: true });
    await fs.promises.writeFile(this.file(rec.id), JSON.stringify(rec, null, 2));
  }
}
```

- [ ] **Step 8: 통과 확인** — Run: `npx jest task-store path-resolver`. Expected: PASS.

- [ ] **Step 9: 커밋**
```bash
git add src/pal/path-resolver.ts src/pal/path-resolver.spec.ts src/knowledge-core/task-store.ts src/knowledge-core/task-store.spec.ts
git commit -m "feat(core): TaskStore 토대 — 레코드 타입·create/get + PathResolver.getStateDir"
```

---

## Task 2: TaskStore FSM 전이 + 블랙보드 쓰기(KeyedLock 직렬화)

**Files:**
- Modify: `src/knowledge-core/task-store.ts`
- Modify: `src/knowledge-core/task-store.spec.ts`

**Interfaces:**
- Consumes: Task 1 `TaskStore`, `TaskRecord`, `TaskStatus`.
- Produces:
  - `transition(id:string, to:TaskStatus): Promise<TaskRecord>` — 유효 전이만(역행·완료후 변경 거부 → throw)
  - `contribute(id:string, persona:string, text:string): Promise<TaskRecord>` — blackboard[persona]=text, updatedAt 갱신
  - `setResult(id:string, result:string): Promise<TaskRecord>` — result 설정

전이 규칙: `PENDING→RUNNING`, `RUNNING→SUCCESS`, `RUNNING→FAILED`, `PENDING→FAILED`. 그 외 throw.

- [ ] **Step 1: FSM·블랙보드 실패 테스트**

`task-store.spec.ts`에 추가:
```typescript
describe('TaskStore FSM/blackboard', () => {
  it('유효 전이는 통과, 무효 전이는 throw', async () => {
    const { store } = tmpStore();
    const t = await store.create({ kind: 'collaboration', question: 'Q', assignees: [] });
    await store.transition(t.id, 'RUNNING');
    const done = await store.transition(t.id, 'SUCCESS');
    expect(done.status).toBe('SUCCESS');
    await expect(store.transition(t.id, 'RUNNING')).rejects.toThrow(); // 완료 후 역행 금지
  });

  it('PENDING에서 RUNNING 건너뛰고 SUCCESS는 금지', async () => {
    const { store } = tmpStore();
    const t = await store.create({ kind: 'collaboration', question: 'Q', assignees: [] });
    await expect(store.transition(t.id, 'SUCCESS')).rejects.toThrow();
  });

  it('동시 contribute 두 건이 둘 다 살아남는다(KeyedLock 직렬화)', async () => {
    const { store } = tmpStore();
    const t = await store.create({ kind: 'collaboration', question: 'Q', assignees: ['A', 'B'] });
    await Promise.all([store.contribute(t.id, 'A', 'aa'), store.contribute(t.id, 'B', 'bb')]);
    const got = await store.get(t.id);
    expect(got?.blackboard).toEqual({ A: 'aa', B: 'bb' });
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest task-store -t FSM`. Expected: FAIL.

- [ ] **Step 3: FSM·블랙보드 구현**

`task-store.ts`에 상수 + 메서드 추가:
```typescript
const VALID: Record<TaskStatus, TaskStatus[]> = {
  PENDING: ['RUNNING', 'FAILED'],
  RUNNING: ['SUCCESS', 'FAILED'],
  SUCCESS: [],
  FAILED: [],
};
```
클래스 내부에 추가(모든 변경은 `lock.run(id, …)`으로 read-modify-write 직렬화):
```typescript
  transition(id: string, to: TaskStatus): Promise<TaskRecord> {
    return this.mutate(id, (rec) => {
      if (!VALID[rec.status].includes(to)) {
        throw new Error(`잘못된 전이: ${rec.status} → ${to} (${id})`);
      }
      rec.status = to;
    });
  }

  contribute(id: string, persona: string, text: string): Promise<TaskRecord> {
    return this.mutate(id, (rec) => { rec.blackboard[persona] = text; });
  }

  setResult(id: string, result: string): Promise<TaskRecord> {
    return this.mutate(id, (rec) => { rec.result = result; });
  }

  // 같은 레코드 동시변경을 KeyedLock으로 직렬화(read→수정→write 원자성).
  private mutate(id: string, fn: (rec: TaskRecord) => void): Promise<TaskRecord> {
    return this.lock.run(id, async () => {
      const rec = await this.get(id);
      if (!rec) throw new Error(`레코드 없음: ${id}`);
      fn(rec);
      rec.updatedAt = new Date().toISOString();
      await this.write(rec);
      return rec;
    });
  }
```

- [ ] **Step 4: 통과 확인** — Run: `npx jest task-store`. Expected: PASS.

- [ ] **Step 5: 커밋**
```bash
git add src/knowledge-core/task-store.ts src/knowledge-core/task-store.spec.ts
git commit -m "feat(core): TaskStore FSM 전이 + 블랙보드 쓰기(KeyedLock 직렬화)"
```

---

## Task 3: BrainProfile.env + ClaudeCliBrain env 주입(백엔드 교체)

**Files:**
- Modify: `src/brain/brain.config.ts` (env 필드)
- Modify: `src/brain/claude-cli.brain.ts` (spawn env)
- Modify: `src/brain/claude-cli.brain.spec.ts`
- Modify: `src/brain/brain.config.spec.ts`

**Interfaces:**
- Produces: `BrainProfile`에 `env?: Record<string,string>` 추가. ClaudeCliBrain이 spawn 시 `{ ...process.env, ...profile.env }` 전달. 로컬LLM = `provider:'claude-cli'` + `env:{ ANTHROPIC_BASE_URL, ... }`.

- [ ] **Step 1: env 주입 실패 테스트**

`claude-cli.brain.spec.ts`에 추가(spawn 모킹 — 기존 테스트의 모킹 패턴을 따른다. cross-spawn 모듈을 jest.mock):
```typescript
it('profile.env가 spawn 환경에 병합된다', async () => {
  const calls: any[] = [];
  jest.spyOn(require('cross-spawn'), 'default').mockImplementation((...a: any[]) => {
    calls.push(a);
    // 즉시 close되는 가짜 child
    const ev: Record<string, Function[]> = {};
    const child: any = {
      stdout: { on: () => {} }, stderr: { on: () => {} },
      on: (k: string, f: Function) => { (ev[k] ||= []).push(f); if (k === 'close') setImmediate(() => f(0)); },
      kill: () => {},
    };
    return child;
  });
  const { ClaudeCliBrain } = require('./claude-cli.brain');
  const brain = new ClaudeCliBrain({ provider: 'claude-cli', cli: 'claude', model: '', concurrency: 1, timeoutMs: 1000, extraArgs: [], env: { ANTHROPIC_BASE_URL: 'http://x' } });
  await brain.complete('hi');
  const opts = calls[0][2];
  expect(opts.env.ANTHROPIC_BASE_URL).toBe('http://x');
});
```
> 주의: 기존 spec에 이미 cross-spawn 모킹 패턴이 있으면 그 헬퍼를 재사용. 위 인라인 모킹과 충돌하지 않게 배치.

- [ ] **Step 2: 실패 확인** — Run: `npx jest claude-cli.brain -t spawn`. Expected: FAIL(env 미전달).

- [ ] **Step 3: 타입 + spawn 수정**

`brain.config.ts` `BrainProfile`에 추가: `env?: Record<string, string>;` 그리고 `DEFAULTS`에 `env: {}` 추가, `resolve()` 병합이 `{ ...DEFAULTS, ...raw }`로 env를 덮으므로 raw.env 우선됨(확인).

`claude-cli.brain.ts:49` 수정:
```typescript
      const child = spawn(this.profile.cli, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...this.profile.env },
      });
```

- [ ] **Step 4: 통과 확인** — Run: `npx jest claude-cli.brain brain.config`. Expected: PASS.

- [ ] **Step 5: 커밋**
```bash
git add src/brain/brain.config.ts src/brain/claude-cli.brain.ts src/brain/claude-cli.brain.spec.ts src/brain/brain.config.spec.ts
git commit -m "feat(brain): ClaudeCliBrain spawn env 주입 — 로컬LLM 백엔드 교체(ANTHROPIC_BASE_URL)"
```

---

## Task 4: BrainFactory + provider 분기

**Files:**
- Create: `src/brain/brain.factory.ts`
- Create: `src/brain/brain.factory.spec.ts`
- Modify: `src/brain/brain.config.ts` (provider 검증 완화)

**Interfaces:**
- Consumes: `BrainProfile`, `ClaudeCliBrain`, (Task 5/6) `GeminiBrain`, `CodexBrain`.
- Produces: `createBrain(profile: BrainProfile): BrainProvider` — provider별 어댑터 선택. `claude-cli`→ClaudeCliBrain, `gemini-cli`→GeminiBrain, `codex-cli`→CodexBrain, 그 외 throw.

> Task 5·6 어댑터가 아직 없으므로 이 태스크는 `claude-cli`만 실제 분기하고 gemini/codex는 동적 require로 둔다(미구현 시 throw). Task 6 후 두 분기가 살아난다.

- [ ] **Step 1: 팩토리 실패 테스트**

`brain.factory.spec.ts`:
```typescript
import { createBrain } from './brain.factory';
import { ClaudeCliBrain } from './claude-cli.brain';

const base = { cli: 'x', model: '', concurrency: 1, timeoutMs: 1000, extraArgs: [], env: {} };

it('claude-cli provider는 ClaudeCliBrain', () => {
  expect(createBrain({ ...base, provider: 'claude-cli' } as any)).toBeInstanceOf(ClaudeCliBrain);
});
it('알 수 없는 provider는 throw', () => {
  expect(() => createBrain({ ...base, provider: 'nope' } as any)).toThrow();
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest brain.factory`. Expected: FAIL.

- [ ] **Step 3: 팩토리 구현**

`brain.factory.ts`:
```typescript
import { BrainProvider } from './brain.port';
import { BrainProfile } from './brain.config';
import { ClaudeCliBrain } from './claude-cli.brain';

// brains.json provider → 어댑터(설계 §6). 로컬LLM은 claude-cli + env 프로필이라 별 provider 불요.
export function createBrain(profile: BrainProfile): BrainProvider {
  switch (profile.provider) {
    case 'claude-cli':
      return new ClaudeCliBrain(profile);
    case 'gemini-cli': {
      const { GeminiBrain } = require('./gemini.brain');
      return new GeminiBrain(profile);
    }
    case 'codex-cli': {
      const { CodexBrain } = require('./codex.brain');
      return new CodexBrain(profile);
    }
    default:
      throw new Error(`지원하지 않는 provider: ${profile.provider}`);
  }
}
```

`brain.config.ts`의 `resolve()`에서 `provider !== 'claude-cli'` throw 가드를 **허용 목록**으로 교체:
```typescript
  const ALLOWED = ['claude-cli', 'gemini-cli', 'codex-cli'];
  if (!ALLOWED.includes(profile.provider)) {
    throw new Error(`지원하지 않는 provider: ${profile.provider}`);
  }
```

- [ ] **Step 4: 통과 확인** — Run: `npx jest brain.factory brain.config`. Expected: PASS.

- [ ] **Step 5: 커밋**
```bash
git add src/brain/brain.factory.ts src/brain/brain.factory.spec.ts src/brain/brain.config.ts
git commit -m "feat(brain): BrainFactory provider 분기 + provider 허용목록(gemini/codex 추가)"
```

---

## Task 5: GeminiBrain 어댑터 (네이티브 gemini CLI)

**Files:**
- Create: `src/brain/gemini.brain.ts`
- Create: `src/brain/gemini.brain.spec.ts`

**Interfaces:**
- Produces: `class GeminiBrain implements BrainProvider`(생성자 `(profile: BrainProfile)`). `complete()`가 `gemini` CLI를 spawn해 텍스트 생성, `BrainResult`로 정규화. Semaphore 보유.

> **calibration:** 실제 `gemini` CLI의 비대화 출력 플래그·포맷은 설치본마다 다를 수 있다(spec §13 미해결). 아래는 합리적 기본 — 출력 파서는 `profile.extraArgs`로 조정 가능하게 두고, 실 스모크(opt-in)로 보정한다. `// ponytail: gemini 출력형식은 설치본 따라 보정 — extraArgs/파서가 조정 노브`.

- [ ] **Step 1: 실패 테스트(spawn 모킹 — 표준출력 텍스트 수집)**

`gemini.brain.spec.ts`:
```typescript
it('gemini stdout 텍스트를 BrainResult.text로 모은다', async () => {
  jest.spyOn(require('cross-spawn'), 'default').mockImplementation(() => {
    const handlers: any = {};
    const child: any = {
      stdout: { on: (k: string, f: Function) => { if (k === 'data') setImmediate(() => f(Buffer.from('안녕'))); } },
      stderr: { on: () => {} },
      on: (k: string, f: Function) => { handlers[k] = f; if (k === 'close') setImmediate(() => f(0)); },
      kill: () => {},
    };
    return child;
  });
  const { GeminiBrain } = require('./gemini.brain');
  const r = await new GeminiBrain({ provider: 'gemini-cli', cli: 'gemini', model: '', concurrency: 1, timeoutMs: 1000, extraArgs: [], env: {} }).complete('hi');
  expect(r.isError).toBe(false);
  expect(r.text).toContain('안녕');
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest gemini.brain`. Expected: FAIL.

- [ ] **Step 3: 구현**

`gemini.brain.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import spawn from 'cross-spawn';
import { BrainProvider, BrainResult } from './brain.port';
import { BrainProfile } from './brain.config';
import { Semaphore } from './semaphore';

// Gemini CLI 어댑터(설계 §6.2). Phase 3=텍스트 생성. 도구 위임은 Phase 4.
// ponytail: gemini 출력형식은 설치본 따라 보정 — extraArgs/파서가 조정 노브.
@Injectable()
export class GeminiBrain implements BrainProvider {
  private readonly sem: Semaphore;
  constructor(private readonly profile: BrainProfile) {
    this.sem = new Semaphore(profile.concurrency);
  }

  complete(prompt: string, onChunk?: (t: string) => void): Promise<BrainResult> {
    return this.sem.run(() => this.spawnOnce(prompt, onChunk));
  }

  private spawnOnce(prompt: string, onChunk?: (t: string) => void): Promise<BrainResult> {
    return new Promise<BrainResult>((resolve) => {
      const args = ['-p', prompt, ...(this.profile.model ? ['-m', this.profile.model] : []), ...this.profile.extraArgs];
      const child = spawn(this.profile.cli, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...this.profile.env } });
      let text = '';
      let settled = false;
      const finish = (r: BrainResult): void => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); resolve(r); };
      const timer = setTimeout(() => finish({ text, costUsd: 0, isError: true, raw: 'timeout' }), this.profile.timeoutMs);
      child.stdout?.on('data', (d: Buffer) => { const s = d.toString(); text += s; onChunk?.(s); });
      child.on('error', () => finish({ text: '', costUsd: 0, isError: true, raw: 'spawn-error' }));
      child.on('close', (code: number) => finish({ text, costUsd: 0, isError: code !== 0 }));
    });
  }
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx jest gemini.brain`. Expected: PASS.

- [ ] **Step 5: 커밋**
```bash
git add src/brain/gemini.brain.ts src/brain/gemini.brain.spec.ts
git commit -m "feat(brain): GeminiBrain 네이티브 CLI 어댑터(텍스트 생성)"
```

---

## Task 6: CodexBrain 어댑터 (네이티브 codex CLI)

**Files:**
- Create: `src/brain/codex.brain.ts`
- Create: `src/brain/codex.brain.spec.ts`

**Interfaces:**
- Produces: `class CodexBrain implements BrainProvider`. Task 5와 동형(spawn+stdout 수집+Semaphore). 호출 args만 codex용.

> **calibration:** `codex` CLI의 비대화 실행 플래그도 설치본 의존(spec §13). `// ponytail: codex 실행 플래그·출력은 설치본 따라 보정`.

- [ ] **Step 1: 실패 테스트** — `codex.brain.spec.ts` (Task 5 테스트와 동형, `GeminiBrain`→`CodexBrain`, provider `codex-cli`, cli `codex`).

```typescript
it('codex stdout 텍스트를 BrainResult.text로 모은다', async () => {
  jest.spyOn(require('cross-spawn'), 'default').mockImplementation(() => {
    const child: any = {
      stdout: { on: (k: string, f: Function) => { if (k === 'data') setImmediate(() => f(Buffer.from('code'))); } },
      stderr: { on: () => {} },
      on: (k: string, f: Function) => { if (k === 'close') setImmediate(() => f(0)); },
      kill: () => {},
    };
    return child;
  });
  const { CodexBrain } = require('./codex.brain');
  const r = await new CodexBrain({ provider: 'codex-cli', cli: 'codex', model: '', concurrency: 1, timeoutMs: 1000, extraArgs: [], env: {} }).complete('hi');
  expect(r.text).toContain('code');
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest codex.brain`. Expected: FAIL.

- [ ] **Step 3: 구현** — `codex.brain.ts`는 `gemini.brain.ts`를 복제하되 클래스명 `CodexBrain`, 주석 codex용, args:
```typescript
      const args = ['exec', prompt, ...this.profile.extraArgs]; // ponytail: codex 실행 플래그·출력은 설치본 따라 보정
```
(나머지 spawnOnce 본문은 Task 5와 동일하게 작성 — 복제. 코드를 줄이려 공유 베이스 추출은 YAGNI, 두 어댑터뿐.)

- [ ] **Step 4: 통과 확인** — Run: `npx jest codex.brain`. Expected: PASS.

- [ ] **Step 5: 커밋**
```bash
git add src/brain/codex.brain.ts src/brain/codex.brain.spec.ts
git commit -m "feat(brain): CodexBrain 네이티브 CLI 어댑터(텍스트 생성)"
```

---

## Task 7: PersonaRegistry — personas/*.md 로드·파싱

**Files:**
- Create: `src/agent-layer/persona-registry.ts`
- Create: `src/agent-layer/persona-registry.spec.ts`

**Interfaces:**
- Produces:
  - `interface Persona { name:string; role:string; brain:string; tools:string[]; invocation:('summon'|'schedule')[]; board?:string; prompt:string }`
  - `class PersonaRegistry` 생성자 `(personasDir: string, logger?: PinoLogger)`; `load(): Promise<void>`(디렉토리 .md 전부 파싱), `get(name:string): Persona|undefined`, `all(): Persona[]`.
  - 파싱: gray-matter. frontmatter 누락 필드는 기본값(tools:[], invocation:['summon']). name 누락 .md는 경고+스킵.

- [ ] **Step 1: 실패 테스트**

`persona-registry.spec.ts`:
```typescript
import { PersonaRegistry } from './persona-registry';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function tmpPersonas(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-persona-'));
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
  return dir;
}

it('frontmatter를 파싱하고 name으로 조회한다', async () => {
  const dir = tmpPersonas({
    'trend.md': '---\nname: Trend\nrole: 시장 분석\nbrain: claude\ntools: [WebSearch]\n---\n시장을 본다',
  });
  const reg = new PersonaRegistry(dir);
  await reg.load();
  const p = reg.get('Trend');
  expect(p?.role).toBe('시장 분석');
  expect(p?.tools).toEqual(['WebSearch']);
  expect(p?.prompt.trim()).toBe('시장을 본다');
  expect(reg.get('Trend')?.invocation).toEqual(['summon']); // 기본값
});

it('name 없는 파일은 스킵', async () => {
  const dir = tmpPersonas({ 'bad.md': '---\nrole: x\n---\nbody' });
  const reg = new PersonaRegistry(dir);
  await reg.load();
  expect(reg.all()).toHaveLength(0);
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest persona-registry`. Expected: FAIL.

- [ ] **Step 3: 구현**

`persona-registry.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { PinoLogger } from '../pal/logger';

export interface Persona {
  name: string;
  role: string;
  brain: string;
  tools: string[];
  invocation: ('summon' | 'schedule')[];
  board?: string;
  prompt: string;
}

// 페르소나 = .md 정의(클래스, 설계 §7.3). 런타임 상태는 별도 객체(이 레지스트리는 정의만 보관).
@Injectable()
export class PersonaRegistry {
  private personas = new Map<string, Persona>();
  constructor(
    private readonly personasDir: string,
    private readonly logger?: PinoLogger,
  ) {}

  async load(): Promise<void> {
    this.personas.clear();
    let files: string[] = [];
    try {
      files = (await fs.promises.readdir(this.personasDir)).filter((f) => f.endsWith('.md'));
    } catch {
      this.logger?.warn(`personas 디렉토리 없음: ${this.personasDir}`, 'PersonaRegistry');
      return;
    }
    for (const f of files) {
      try {
        const parsed = matter(await fs.promises.readFile(path.join(this.personasDir, f), 'utf8'));
        const fm = parsed.data as Record<string, unknown>;
        const name = typeof fm.name === 'string' ? fm.name : '';
        if (!name) { this.logger?.warn(`name 없는 페르소나 스킵: ${f}`, 'PersonaRegistry'); continue; }
        this.personas.set(name, {
          name,
          role: String(fm.role ?? ''),
          brain: String(fm.brain ?? 'claude'),
          tools: Array.isArray(fm.tools) ? fm.tools.map(String) : [],
          invocation: Array.isArray(fm.invocation) ? (fm.invocation as ('summon' | 'schedule')[]) : ['summon'],
          board: typeof fm.board === 'string' ? fm.board : undefined,
          prompt: parsed.content,
        });
      } catch (e) {
        this.logger?.warn(`페르소나 파싱 실패 ${f}: ${String(e)}`, 'PersonaRegistry');
      }
    }
  }

  get(name: string): Persona | undefined { return this.personas.get(name); }
  all(): Persona[] { return [...this.personas.values()]; }
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx jest persona-registry`. Expected: PASS.

- [ ] **Step 5: 커밋**
```bash
git add src/agent-layer/persona-registry.ts src/agent-layer/persona-registry.spec.ts
git commit -m "feat(agent): PersonaRegistry — personas/*.md frontmatter 로드·파싱"
```

---

## Task 8: 8팀 페르소나 .md 작성

**Files:**
- Create: `personas/manager.md`, `infra.md`, `brand.md`, `career.md`, `academy.md`, `trend.md`, `recon.md`, `record.md`
- Create: `personas/persona-files.spec.ts` (8개 로드 검증)

**Interfaces:**
- Consumes: Task 7 `PersonaRegistry`.
- 로스터(spec §5.2): Manager(board:chair)·Infra(board:infra-chief)·Brand·Career·Academy·Trend(board:strategy-advisor, tools:[WebSearch,WebFetch], invocation:[summon,schedule])·Recon(tools:[WebSearch,WebFetch], invocation:[summon,schedule])·Record(board:record-keeper, invocation:[schedule]).

> 페르소나 본문은 1차 초안(사용자가 추후 개인화). brain은 전부 `claude`(도구 쓰는 Trend/Recon은 반드시 claude 하네스, 나머지도 기본 claude — 로컬LLM 라우팅은 사용자가 brains.json+brain 필드로 후조정).

- [ ] **Step 1: 8개 .md 작성** — 각 파일 형식(Manager 예):
```markdown
---
name: Manager
role: 전체 총괄·의사결정 조율
brain: claude
invocation: [summon, schedule]
board: chair
---
너는 Manager다. 사용자의 비서실장으로서 전체 방향을 잡고 의사결정을 조율한다.
질문을 받으면 핵심 쟁점을 정리하고, 필요한 전문 영역을 식별해 균형 잡힌 결론을 제시한다.
근거 없는 단정 대신 트레이드오프를 분명히 한다.
```
나머지 7개도 같은 형식. Trend/Recon만 `tools: [WebSearch, WebFetch]` 추가. board 역할은 위 로스터대로. 본문은 각 역할(Infra=시스템/인프라/운영, Brand=마케팅/포지셔닝, Career=커리어/인맥/성장, Academy=학습/연구/지식정리, Trend=시장/트렌드/뉴스, Recon=리서치/정보수집, Record=회의록/기록보관)에 맞춰 2~3문장.

- [ ] **Step 2: 로드 검증 테스트**

`personas/persona-files.spec.ts`:
```typescript
import { PersonaRegistry } from '../src/agent-layer/persona-registry';
import * as path from 'path';

it('8팀 페르소나가 모두 로드된다', async () => {
  const reg = new PersonaRegistry(path.join(__dirname));
  await reg.load();
  const names = reg.all().map((p) => p.name).sort();
  expect(names).toEqual(['Academy', 'Brand', 'Career', 'Infra', 'Manager', 'Recon', 'Record', 'Trend']);
  expect(reg.get('Trend')?.tools).toContain('WebSearch');
  expect(reg.get('Manager')?.board).toBe('chair');
});
```
> jest가 personas/ 밖이면 `roots`/`testMatch` 확인. 기본 `jest.config.js`가 `**/*.spec.ts`면 잡힘. 안 잡히면 spec을 `src/agent-layer/`로 옮기고 경로만 `../../personas`로 조정.

- [ ] **Step 3: 통과 확인** — Run: `npx jest persona-files`. Expected: PASS.

- [ ] **Step 4: 커밋**
```bash
git add personas/
git commit -m "feat(agent): 8팀 페르소나 .md 1차 정의(Manager·Infra·Brand·Career·Academy·Trend·Recon·Record)"
```

---

## Task 9: 권한 울타리 — permissions.json 로더 + 허용도구 산출

**Files:**
- Create: `src/agent-layer/permission-fence.ts`
- Create: `src/agent-layer/permission-fence.spec.ts`

**Interfaces:**
- Produces:
  - `interface FenceConfig { default:'deny'; allow:{ tools:Record<string,string[]>; writePaths:string[]; denyPaths:string[] } }`
  - `class PermissionFence` 생성자 `(configPath: string)`; `load(): Promise<void>`(없으면 default-deny 빈 설정), `allowedTools(persona: Persona): string[]`(persona.tools ∩ allow.tools[name], **claude 하네스 brain일 때만**; 아니면 [] + 무시), `spawnFlags(persona: Persona): string[]`(`['--allowedTools', tools.join(',')]` + writePaths를 `--add-dir`로; denyPaths는 절대 제외).
  - `isHarnessBrain(brain: string): boolean` — `claude`/로컬LLM(claude-cli 백엔드) 판정. Phase 3에선 brains.json provider가 claude-cli면 true. 단순화: 이름이 `gemini`/`codex`로 시작하면 false, 그 외 true. `// ponytail: provider 조회 대신 이름 규칙 — 정밀화는 brains.json 조회로`.

- [ ] **Step 1: 실패 테스트**

`permission-fence.spec.ts`:
```typescript
import { PermissionFence } from './permission-fence';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const persona = (over: any = {}) => ({ name: 'Trend', role: '', brain: 'claude', tools: ['WebSearch', 'Bash'], invocation: ['summon'], prompt: '', ...over });

function tmpFence(cfg: any): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-fence-'));
  const p = path.join(dir, 'permissions.json');
  if (cfg) fs.writeFileSync(p, JSON.stringify(cfg));
  return p;
}

it('persona.tools ∩ allow.tools 만 허용', async () => {
  const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: { Trend: ['WebSearch'] }, writePaths: [], denyPaths: [] } }));
  await fence.load();
  expect(fence.allowedTools(persona() as any)).toEqual(['WebSearch']); // Bash는 허용목록에 없어 탈락
});

it('claude 하네스가 아니면 도구 0', async () => {
  const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: { Trend: ['WebSearch'] }, writePaths: [], denyPaths: [] } }));
  await fence.load();
  expect(fence.allowedTools(persona({ brain: 'gemini' }) as any)).toEqual([]);
});

it('설정 파일 없으면 default-deny(도구 0)', async () => {
  const fence = new PermissionFence(tmpFence(null));
  await fence.load();
  expect(fence.allowedTools(persona() as any)).toEqual([]);
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest permission-fence`. Expected: FAIL.

- [ ] **Step 3: 구현**

`permission-fence.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import { Persona } from './persona-registry';

export interface FenceConfig {
  default: 'deny';
  allow: { tools: Record<string, string[]>; writePaths: string[]; denyPaths: string[] };
}

const EMPTY: FenceConfig = { default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } };

// 도구 권한 울타리(설계 §8). 새 권한엔진 ❌ — 네이티브 권한 플래그를 산출만. default-deny.
@Injectable()
export class PermissionFence {
  private cfg: FenceConfig = EMPTY;
  constructor(private readonly configPath: string) {}

  async load(): Promise<void> {
    try {
      this.cfg = JSON.parse(await fs.promises.readFile(this.configPath, 'utf8')) as FenceConfig;
    } catch {
      this.cfg = EMPTY; // 없음/깨짐 → 전부 거부(안전 기본)
    }
  }

  // Claude Code 하네스 위에서 도는 두뇌만 도구 가능(진짜 Claude + 로컬LLM 백엔드).
  isHarnessBrain(brain: string): boolean {
    return !brain.startsWith('gemini') && !brain.startsWith('codex'); // ponytail: 이름 규칙 — 정밀화는 brains.json 조회로
  }

  allowedTools(persona: Persona): string[] {
    if (!this.isHarnessBrain(persona.brain)) return [];
    const granted = this.cfg.allow.tools[persona.name] ?? [];
    return persona.tools.filter((t) => granted.includes(t));
  }

  // spawn args 조각: --allowedTools + 쓰기 허용 폴더(--add-dir). denyPaths는 절대 미포함.
  spawnFlags(persona: Persona): string[] {
    const tools = this.allowedTools(persona);
    if (tools.length === 0) return [];
    const flags = ['--allowedTools', tools.join(',')];
    const writes = this.cfg.allow.writePaths.filter((p) => !this.cfg.allow.denyPaths.includes(p));
    for (const w of writes) flags.push('--add-dir', w);
    return flags;
  }
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx jest permission-fence`. Expected: PASS.

- [ ] **Step 5: 커밋**
```bash
git add src/agent-layer/permission-fence.ts src/agent-layer/permission-fence.spec.ts
git commit -m "feat(agent): 권한 울타리 — default-deny + persona.tools∩allow, claude 하네스 한정"
```

---

# 2부 — 협업 코어 (Task 10–13)

## Task 10: SpecialistAgent — 제네릭 워커

**Files:**
- Create: `src/agent-layer/specialist-agent.ts`
- Create: `src/agent-layer/specialist-agent.spec.ts`

**Interfaces:**
- Consumes: `PersonaRegistry`, `PermissionFence`, `BrainFactory.createBrain`, `BrainProfile`(brains.json 프로필 맵), `RagStore`.
- Produces: `class SpecialistAgent` 생성자 `(registry, fence, resolveBrain, rag, logger)` where `resolveBrain: (brainKey:string)=>BrainProvider`. `contribute(personaName:string, question:string, userId:string): Promise<string>` — 페르소나 프롬프트 + RAG 컨텍스트로 두뇌 호출, 텍스트 반환. stateless. 실패 시 빈 문자열 아님 → throw(상위에서 티켓 FAILED 처리).

> 두뇌 해소(`resolveBrain`)는 brainKey→BrainProvider. Task 13/통합에서 brains.json 프로필별 createBrain 캐시를 주입. 권한 플래그는 현재 ClaudeCliBrain이 `profile.extraArgs`로 받으므로, fence.spawnFlags를 해당 프로필 extraArgs에 합쳐 brain을 만들거나, Phase 3에선 **fence.spawnFlags를 prompt 앞 시스템 지시가 아니라 brain 생성 시 extraArgs로** 전달(아래 구현은 resolveBrain이 persona별 플래그를 이미 반영했다고 가정 — 단순화).

- [ ] **Step 1: 실패 테스트(FakeBrain 주입)**

`specialist-agent.spec.ts`:
```typescript
import { SpecialistAgent } from './specialist-agent';
import { PersonaRegistry } from './persona-registry';
import { PermissionFence } from './permission-fence';
import { FakeBrain } from '../brain/fake-brain';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';

function reg(): PersonaRegistry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sp-'));
  fs.writeFileSync(path.join(dir, 'brand.md'), '---\nname: Brand\nrole: 마케팅\nbrain: claude\n---\n마케팅 관점으로 본다');
  const r = new PersonaRegistry(dir);
  return r;
}
const fakeRag = { search: async () => [] } as any;
const fakeFence = { allowedTools: () => [], spawnFlags: () => [] } as any;

it('페르소나 프롬프트로 두뇌를 호출해 기여를 반환', async () => {
  const r = reg(); await r.load();
  const brain = new FakeBrain({ text: 'Brand 의견', costUsd: 0, isError: false });
  const sp = new SpecialistAgent(r, fakeFence, () => brain, fakeRag, { warn() {}, error() {} } as any);
  const out = await sp.contribute('Brand', '런칭 전략?', 'default');
  expect(out).toBe('Brand 의견');
});

it('없는 페르소나는 throw', async () => {
  const r = reg(); await r.load();
  const sp = new SpecialistAgent(r, fakeFence, () => new FakeBrain(), fakeRag, { warn() {}, error() {} } as any);
  await expect(sp.contribute('Ghost', 'q', 'default')).rejects.toThrow();
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest specialist-agent`. Expected: FAIL.

- [ ] **Step 3: 구현**

`specialist-agent.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { PersonaRegistry } from './persona-registry';
import { PermissionFence } from './permission-fence';
import { BrainProvider } from '../brain/brain.port';
import { RagStore } from '../knowledge-core/rag/rag-store';
import { PinoLogger } from '../pal/logger';

// 제네릭 협업 워커(설계 §7.3). persona+brain만 주입, 코드는 하나. stateless — 매 호출 독립.
@Injectable()
export class SpecialistAgent {
  constructor(
    private readonly registry: PersonaRegistry,
    private readonly fence: PermissionFence,
    private readonly resolveBrain: (brainKey: string) => BrainProvider,
    private readonly rag: RagStore,
    private readonly logger: PinoLogger,
  ) {}

  async contribute(personaName: string, question: string, userId: string): Promise<string> {
    const persona = this.registry.get(personaName);
    if (!persona) throw new Error(`알 수 없는 페르소나: ${personaName}`);
    const hits = await this.rag.search(question, 5, userId);
    const ctx = hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.text}`).join('\n\n');
    const prompt = [
      persona.prompt,
      `\n# 공유 위키(근거)\n${ctx || '(없음)'}`,
      `\n# 다룰 질문\n${question}`,
      '\n네 역할 관점에서만 기여하라. 다른 전문가와 대화하지 말고 네 분석만 적어라.',
    ].join('\n');
    const brain = this.resolveBrain(persona.brain);
    const r = await brain.complete(prompt);
    if (r.isError) throw new Error(`두뇌 호출 실패: ${personaName}`);
    return r.text;
  }
}
```
> `fence`는 두뇌 해소 측(resolveBrain 구성, Task 13/통합)에서 spawnFlags를 프로필 extraArgs로 합쳐 쓴다. 여기선 의존만 보유(향후 확장점).

- [ ] **Step 4: 통과 확인** — Run: `npx jest specialist-agent`. Expected: PASS.

- [ ] **Step 5: 커밋**
```bash
git add src/agent-layer/specialist-agent.ts src/agent-layer/specialist-agent.spec.ts
git commit -m "feat(agent): SpecialistAgent 제네릭 stateless 워커(페르소나+RAG→두뇌 기여)"
```

---

## Task 11: TurnBudget — 협업 총턴 상한

**Files:**
- Create: `src/agent-layer/turn-budget.ts`
- Create: `src/agent-layer/turn-budget.spec.ts`

**Interfaces:**
- Produces: `class TurnBudget` 생성자 `(max:number)`; `tryConsume(): boolean`(남으면 1 차감 true, 소진 false), `remaining():number`, `used():number`. 세션 1개당 1 인스턴스(Semaphore와 직교 — 이건 누적 총량).

- [ ] **Step 1: 실패 테스트**

`turn-budget.spec.ts`:
```typescript
import { TurnBudget } from './turn-budget';
it('max까지만 소비하고 그 다음은 거부', () => {
  const b = new TurnBudget(2);
  expect(b.tryConsume()).toBe(true);
  expect(b.tryConsume()).toBe(true);
  expect(b.tryConsume()).toBe(false);
  expect(b.used()).toBe(2);
  expect(b.remaining()).toBe(0);
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest turn-budget`. Expected: FAIL.

- [ ] **Step 3: 구현**

`turn-budget.ts`:
```typescript
// 협업 세션당 총 두뇌호출 상한(설계 §8). 소진 시 추가 배정 중단 → 가진 것으로 종합.
export class TurnBudget {
  private spent = 0;
  constructor(private readonly max: number) {}
  tryConsume(): boolean {
    if (this.spent >= this.max) return false;
    this.spent++;
    return true;
  }
  remaining(): number { return Math.max(0, this.max - this.spent); }
  used(): number { return this.spent; }
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx jest turn-budget`. Expected: PASS.

- [ ] **Step 5: 커밋**
```bash
git add src/agent-layer/turn-budget.ts src/agent-layer/turn-budget.spec.ts
git commit -m "feat(agent): TurnBudget 협업 총턴 상한(Semaphore와 직교)"
```

---

## Task 12: Synthesizer — 블랙보드 종합

**Files:**
- Create: `src/agent-layer/synthesizer.ts`
- Create: `src/agent-layer/synthesizer.spec.ts`

**Interfaces:**
- Consumes: `BrainProvider`(별도 호출 — 작성자≠검증자 결, seam #5), `TaskRecord.blackboard`.
- Produces: `class Synthesizer` 생성자 `(brain: BrainProvider)`; `synthesize(question:string, blackboard:Record<string,string>, onChunk?): Promise<string>`. 빈 블랙보드면 "기여 없음" 안내.

- [ ] **Step 1: 실패 테스트**

`synthesizer.spec.ts`:
```typescript
import { Synthesizer } from './synthesizer';
import { FakeBrain } from '../brain/fake-brain';

it('블랙보드를 종합 프롬프트로 두뇌에 넘겨 답을 만든다', async () => {
  const s = new Synthesizer(new FakeBrain({ text: '종합결론', costUsd: 0, isError: false }));
  const out = await s.synthesize('Q', { Brand: 'a', Trend: 'b' });
  expect(out).toBe('종합결론');
});

it('빈 블랙보드는 안내 문자열', async () => {
  const s = new Synthesizer(new FakeBrain());
  const out = await s.synthesize('Q', {});
  expect(out).toContain('기여');
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest synthesizer`. Expected: FAIL.

- [ ] **Step 3: 구현**

`synthesizer.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { BrainProvider } from '../brain/brain.port';

// 블랙보드 기여 종합(설계 §4 ④). 별도 두뇌 호출 — 작성자≠종합자(seam #5).
@Injectable()
export class Synthesizer {
  constructor(private readonly brain: BrainProvider) {}

  async synthesize(question: string, blackboard: Record<string, string>, onChunk?: (t: string) => void): Promise<string> {
    const entries = Object.entries(blackboard);
    if (entries.length === 0) return '전문가 기여가 없어 종합할 내용이 없습니다.';
    const body = entries.map(([who, txt]) => `## ${who}\n${txt}`).join('\n\n');
    const prompt = [
      '아래는 여러 전문가가 같은 질문에 대해 각자 적은 의견이다. 이를 하나의 일관된 답으로 종합하라.',
      '상충하면 트레이드오프를 밝히고, 중복은 합쳐라.',
      `\n# 질문\n${question}`,
      `\n# 전문가 의견\n${body}`,
    ].join('\n');
    const r = await this.brain.complete(prompt, onChunk);
    return r.isError ? '종합 실패: 두뇌 호출 오류' : r.text;
  }
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx jest synthesizer`. Expected: PASS.

- [ ] **Step 5: 커밋**
```bash
git add src/agent-layer/synthesizer.ts src/agent-layer/synthesizer.spec.ts
git commit -m "feat(agent): Synthesizer 블랙보드 종합(별도 두뇌 — 작성자≠종합자)"
```

---

## Task 13: Orchestrator 실체화 — 분해·배정·수집·종합 + collaborate()

**Files:**
- Modify: `src/agent-layer/orchestrator.ts`
- Create: `src/agent-layer/orchestrator-collaborate.spec.ts`

**Interfaces:**
- Consumes: Task 1·2 `TaskStore`, Task 10 `SpecialistAgent`, Task 11 `TurnBudget`, Task 12 `Synthesizer`, `Semaphore`(동시), `PersonaRegistry`.
- Produces: `Orchestrator.collaborate(question:string, personas:string[], userId:string, opts?:{turnBudget?:number}): Promise<string>` — TaskStore 세션 생성→RUNNING→각 페르소나 SpecialistAgent.contribute를 Semaphore+TurnBudget 하에 병렬 실행→블랙보드 기록→Synthesizer→SUCCESS, result 반환. 실패 페르소나는 건너뛰고 로깅(세션 보호). TurnBudget 소진 시 남은 페르소나 스킵.
  - `route()` 분기 추가: 기존 단일경로 유지(Reader). `/team A,B` 형식 또는 다중 대상이면 collaborate. (간단: route는 그대로 두고 collaborate를 별 메서드로 — Gateway가 `team` 서브명령에서 호출. seam #1: 배정구는 여전히 Orchestrator.)

> 배정구 단일화(seam #1·#3): 협업 진입은 collaborate 하나. 향후 run-state 스위치를 여기 앞단에 끼운다(이번엔 자리만).

- [ ] **Step 1: 실패 테스트(FakeBrain 기반 SpecialistAgent·Synthesizer 주입)**

`orchestrator-collaborate.spec.ts`:
```typescript
import { Orchestrator } from './orchestrator';
import { TaskStore } from '../knowledge-core/task-store';
import { KeyedLock } from '../knowledge-core/keyed-lock';
import { Semaphore } from '../brain/semaphore';
import { TurnBudget } from './turn-budget';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';

function store(): TaskStore {
  return new TaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'engram-orc-')), new KeyedLock());
}
const logger = { warn() {}, error() {}, info() {} } as any;

it('두 페르소나 기여를 블랙보드에 모아 종합하고 세션 SUCCESS', async () => {
  const ts = store();
  const specialist = { contribute: async (p: string) => `${p} 기여` } as any;
  const synth = { synthesize: async (_q: string, bb: Record<string, string>) => `종합(${Object.keys(bb).sort().join(',')})` } as any;
  // 협업에 필요한 협력자만 주입하는 생성자(아래 구현에서 reader 등 기존 의존은 옵셔널/유지)
  const orc = new Orchestrator(
    null as any, null as any, logger, null as any,
    ts, specialist, synth, new Semaphore(2),
  );
  const out = await orc.collaborate('런칭 전략?', ['Brand', 'Trend'], 'default');
  expect(out).toBe('종합(Brand,Trend)');
});

it('TurnBudget 소진 시 남은 페르소나는 스킵', async () => {
  const ts = store();
  const seen: string[] = [];
  const specialist = { contribute: async (p: string) => { seen.push(p); return `${p}`; } } as any;
  const synth = { synthesize: async (_q: string, bb: Record<string, string>) => Object.keys(bb).join(',') } as any;
  const orc = new Orchestrator(null as any, null as any, logger, null as any, ts, specialist, synth, new Semaphore(2));
  const out = await orc.collaborate('q', ['A', 'B', 'C'], 'default', { turnBudget: 1 });
  expect(seen.length).toBe(1); // 1턴만
  expect(out).toBe(seen[0]);
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest orchestrator-collaborate`. Expected: FAIL.

- [ ] **Step 3: Orchestrator 확장**

`orchestrator.ts` 생성자에 협업 협력자 추가(기존 4개 뒤에 옵셔널 — 기존 route/digest 불변. **@Optional() 필수**: Task 16 배선 전까지 NestJS DI가 미등록 provider 주입을 시도해 AppModule 부팅 테스트가 깨지는 걸 방지):
```typescript
import { Injectable, Optional } from '@nestjs/common';
import { TaskStore } from '../knowledge-core/task-store';
import { SpecialistAgent } from './specialist-agent';
import { Synthesizer } from './synthesizer';
import { Semaphore } from '../brain/semaphore';
import { TurnBudget } from './turn-budget';
```
생성자:
```typescript
  constructor(
    private readonly reader: ReaderAgent,
    private readonly conversations: ConversationStore,
    private readonly logger: PinoLogger,
    private readonly ingester: IngesterAgent,
    @Optional() private readonly tasks?: TaskStore,
    @Optional() private readonly specialist?: SpecialistAgent,
    @Optional() private readonly synthesizer?: Synthesizer,
    @Optional() private readonly sem?: Semaphore,
  ) {}
```
메서드 추가:
```typescript
  // B 협업(설계 §4): 분해는 호출자가 결정(personas), 여기서 배정·수집·종합. 유일 배정구(seam #1).
  async collaborate(
    question: string,
    personas: string[],
    userId: string = DEFAULT_USER,
    opts: { turnBudget?: number } = {},
  ): Promise<string> {
    if (!this.tasks || !this.specialist || !this.synthesizer || !this.sem) {
      throw new Error('협업 협력자가 주입되지 않음(Orchestrator)');
    }
    const budget = new TurnBudget(opts.turnBudget ?? personas.length + 1);
    const session = await this.tasks.create({ kind: 'collaboration', question, assignees: personas });
    await this.tasks.transition(session.id, 'RUNNING');
    await Promise.all(
      personas.map((p) =>
        this.sem!.run(async () => {
          if (!budget.tryConsume()) return; // 예산 소진 → 스킵(돈 천장)
          try {
            const text = await this.specialist!.contribute(p, question, userId);
            await this.tasks!.contribute(session.id, p, text);
          } catch (err) {
            this.logger.warn(`페르소나 기여 실패(스킵) ${p}: ${String(err)}`, 'Orchestrator');
          }
        }),
      ),
    );
    const fresh = await this.tasks.get(session.id);
    const result = await this.synthesizer.synthesize(question, fresh?.blackboard ?? {});
    await this.tasks.setResult(session.id, result);
    await this.tasks.transition(session.id, 'SUCCESS');
    return result;
  }
```

- [ ] **Step 4: 통과 확인** — Run: `npx jest orchestrator`. Expected: PASS(기존 route/digest 테스트 + 신규 collaborate).

- [ ] **Step 5: 커밋**
```bash
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator-collaborate.spec.ts
git commit -m "feat(agent): Orchestrator.collaborate — 배정·수집(블랙보드)·종합 + TurnBudget/Semaphore"
```

---

# 3부 — 회의 + 통합 (Task 14–16)

## Task 14: MeetingEngine — 제네릭 스케줄 세션

**Files:**
- Create: `src/agent-layer/meeting-engine.ts`
- Create: `src/agent-layer/meeting-engine.spec.ts`

**Interfaces:**
- Consumes: `Orchestrator.collaborate`, `WikiEngine`(회의록 페이지), `TaskStore`(kind:'board-decision').
- Produces:
  - `interface MeetingDef { name:string; schedule:string; roster:string[]; agenda:string }`
  - `class MeetingEngine` 생성자 `(orchestrator, wiki, tasks, logger)`; `run(def: MeetingDef, userId:string): Promise<{ minutesSlug:string; decisionId:string }>` — collaborate(agenda, roster)로 종합→Record가 회의록을 위키 페이지로(slug `meeting-<name>-<date>`)→결정을 TaskStore(board-decision)로.

- [ ] **Step 1: 실패 테스트**

`meeting-engine.spec.ts`:
```typescript
import { MeetingEngine } from './meeting-engine';
import { TaskStore } from '../knowledge-core/task-store';
import { KeyedLock } from '../knowledge-core/keyed-lock';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';

it('회의를 돌려 회의록 페이지와 결정 레코드를 만든다', async () => {
  const tasks = new TaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'engram-mt-')), new KeyedLock());
  const orchestrator = { collaborate: async () => '오늘의 종합 결론' } as any;
  const pages: any[] = [];
  const wiki = { createPage: async (input: any) => { pages.push(input); return input; } } as any;
  const eng = new MeetingEngine(orchestrator, wiki, tasks, { info() {}, warn() {}, error() {} } as any);
  const res = await eng.run({ name: '일일브리핑', schedule: '0 3 * * *', roster: ['Manager', 'Record'], agenda: '점검' }, 'default');
  expect(pages[0].slug).toContain('meeting-일일브리핑');
  expect(pages[0].body).toContain('오늘의 종합 결론');
  const dec = await tasks.get(res.decisionId);
  expect(dec?.kind).toBe('board-decision');
  expect(dec?.result).toBe('오늘의 종합 결론');
});
```
> WikiEngine 실제 API: `createPage(input: CreatePageInput, userId)`, `CreatePageInput = { slug, title, category, body, sources?, status? }`.

- [ ] **Step 2: 실패 확인** — Run: `npx jest meeting-engine`. Expected: FAIL.

- [ ] **Step 3: 구현** — `meeting-engine.ts`(WikiEngine 실제 메서드명에 맞춰 페이지 생성):
```typescript
import { Injectable } from '@nestjs/common';
import { Orchestrator } from './orchestrator';
import { WikiEngine } from '../knowledge-core/wiki/wiki-engine';
import { TaskStore } from '../knowledge-core/task-store';
import { PinoLogger } from '../pal/logger';
import { DEFAULT_USER } from '../pal/path-resolver';

export interface MeetingDef { name: string; schedule: string; roster: string[]; agenda: string }

// 제네릭 회의 = 안건 고정 협업(설계 §7). 산출물: 회의록=위키, 결정=TaskStore(board-decision).
@Injectable()
export class MeetingEngine {
  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly wiki: WikiEngine,
    private readonly tasks: TaskStore,
    private readonly logger: PinoLogger,
  ) {}

  async run(def: MeetingDef, userId: string = DEFAULT_USER): Promise<{ minutesSlug: string; decisionId: string }> {
    const summary = await this.orchestrator.collaborate(def.agenda, def.roster, userId);
    const date = new Date().toISOString().slice(0, 10);
    const slug = `meeting-${def.name}-${date}`;
    // Record(서기)가 회의록을 위키에(설계 §7.3 산출물 매핑). 회의록은 확정 기록 → published.
    await this.wiki.createPage(
      { slug, title: `${def.name} 회의록 (${date})`, category: 'meeting', body: `# 안건\n${def.agenda}\n\n# 결론\n${summary}`, status: 'published' },
      userId,
    );
    const decision = await this.tasks.create({ kind: 'board-decision', question: def.agenda, assignees: def.roster });
    await this.tasks.transition(decision.id, 'RUNNING');
    await this.tasks.setResult(decision.id, summary);
    await this.tasks.transition(decision.id, 'SUCCESS');
    this.logger.info(`회의 완료: ${def.name} → ${slug}`, 'MeetingEngine');
    return { minutesSlug: slug, decisionId: decision.id };
  }
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx jest meeting-engine`. Expected: PASS.

- [ ] **Step 5: 커밋**
```bash
git add src/agent-layer/meeting-engine.ts src/agent-layer/meeting-engine.spec.ts
git commit -m "feat(agent): MeetingEngine 제네릭 회의(협업→위키 회의록+TaskStore 결정)"
```

---

## Task 15: meetings.json 로더 + engram meeting 명령 + Scheduler 배선

**Files:**
- Create: `src/edge/meeting-config.ts` (로더)
- Create: `src/edge/meeting.scheduler.ts` (@Cron 등록)
- Modify: `src/edge/cli.gateway.ts` (`meeting` 서브명령 + `team`)
- Create: `src/edge/meeting-config.spec.ts`
- Modify: `src/edge/cli.gateway.spec.ts`

**Interfaces:**
- Produces:
  - `loadMeetings(configDir:string): MeetingDef[]` / `saveMeetings(configDir, defs)` — `runtime/config/meetings.json`(없으면 []).
  - `CliGateway`: `engram meeting add|list|remove|run` (Orchestrator/MeetingEngine 경유 — seam #1), `engram team <names> <질문>` → orchestrator.collaborate.
  - `MeetingScheduler` — 등록 회의를 동적 cron으로(@nestjs/schedule `SchedulerRegistry`). 시각 도래 시 `meetingEngine.run`.

> Scheduler 동적 등록은 `@nestjs/schedule`의 `SchedulerRegistry.addCronJob`. 정적 @Cron 데코레이터로는 config 기반 N개를 못 만드므로 onModuleInit에서 등록.

- [ ] **Step 1: 로더 실패 테스트**

`meeting-config.spec.ts`:
```typescript
import { loadMeetings, saveMeetings } from './meeting-config';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';

it('없으면 빈 배열, 저장 후 다시 읽힌다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-mc-'));
  expect(loadMeetings(dir)).toEqual([]);
  saveMeetings(dir, [{ name: 'd', schedule: '0 3 * * *', roster: ['Manager'], agenda: 'a' }]);
  expect(loadMeetings(dir)[0].name).toBe('d');
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest meeting-config`. Expected: FAIL.

- [ ] **Step 3: 로더 구현**

`meeting-config.ts`:
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { MeetingDef } from '../agent-layer/meeting-engine';

const file = (dir: string): string => path.join(dir, 'meetings.json');

export function loadMeetings(configDir: string): MeetingDef[] {
  try { return JSON.parse(fs.readFileSync(file(configDir), 'utf8')) as MeetingDef[]; }
  catch { return []; }
}
export function saveMeetings(configDir: string, defs: MeetingDef[]): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file(configDir), JSON.stringify(defs, null, 2));
}
```

- [ ] **Step 4: CliGateway 명령 추가** — `run()`의 분기에 추가(기존 ask/digest/review/REPL 유지):
```typescript
    } else if (argv[0] === 'team' && argv[1]) {
      const names = argv[1].split(',').map((s) => s.trim()).filter(Boolean);
      const q = argv.slice(2).join(' ');
      const out = await this.orchestrator.collaborate(q, names, DEFAULT_USER);
      process.stdout.write(out + '\n');
    } else if (argv[0] === 'meeting') {
      await this.meeting(argv.slice(1));
```
그리고 `meeting()` 메서드(add/list/remove/run; loadMeetings/saveMeetings + meetingEngine.run). CliGateway 생성자에 `loadMeetings` 경유 위해 `PathResolver`와 `MeetingEngine` 주입 추가.
```typescript
  private async meeting(args: string[]): Promise<void> {
    const dir = this.paths.getConfigDir();
    const defs = loadMeetings(dir);
    if (args[0] === 'list') {
      process.stdout.write(defs.map((d) => `${d.name}  [${d.schedule}]  ${d.roster.join(',')}`).join('\n') + '\n');
    } else if (args[0] === 'add') {
      // engram meeting add <name> <cron> <roster,comma> <agenda...>
      defs.push({ name: args[1], schedule: args[2], roster: args[3].split(','), agenda: args.slice(4).join(' ') });
      saveMeetings(dir, defs);
      process.stdout.write(`회의 추가: ${args[1]}\n`);
    } else if (args[0] === 'remove') {
      saveMeetings(dir, defs.filter((d) => d.name !== args[1]));
      process.stdout.write(`회의 삭제: ${args[1]}\n`);
    } else if (args[0] === 'run') {
      const def = defs.find((d) => d.name === args[1]);
      if (!def) { process.stdout.write(`회의 없음: ${args[1]}\n`); return; }
      const r = await this.meetingEngine.run(def, DEFAULT_USER);
      process.stdout.write(`회의록: ${r.minutesSlug}\n`);
    } else {
      process.stdout.write('사용법: engram meeting add|list|remove|run\n');
    }
  }
```

- [ ] **Step 5: MeetingScheduler 구현**

`meeting.scheduler.ts`:
```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { MeetingEngine } from '../agent-layer/meeting-engine';
import { PathResolver, DEFAULT_USER } from '../pal/path-resolver';
import { PinoLogger } from '../pal/logger';
import { loadMeetings } from './meeting-config';

// 등록된 회의를 동적 cron으로 — config N개를 onModuleInit에 등록(정적 @Cron 불가).
@Injectable()
export class MeetingScheduler implements OnModuleInit {
  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly engine: MeetingEngine,
    private readonly paths: PathResolver,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    for (const def of loadMeetings(this.paths.getConfigDir())) {
      const job = new CronJob(def.schedule, () => {
        this.engine.run(def, DEFAULT_USER).catch((e) =>
          this.logger.error('회의 실행 실패', String(e), 'MeetingScheduler'),
        );
      });
      this.registry.addCronJob(`meeting-${def.name}`, job as any);
      job.start();
    }
  }
}
```
> `cron`은 @nestjs/schedule가 끌어오는 전이 의존. 없으면 `npm i cron`. DigestScheduler가 @Cron을 쓰므로 ScheduleModule은 이미 import됨.

- [ ] **Step 6: 테스트 통과 확인** — Run: `npx jest meeting-config cli.gateway`. Expected: PASS. (Scheduler는 통합 스모크에서.)

- [ ] **Step 7: 커밋**
```bash
git add src/edge/meeting-config.ts src/edge/meeting.scheduler.ts src/edge/cli.gateway.ts src/edge/meeting-config.spec.ts src/edge/cli.gateway.spec.ts
git commit -m "feat(edge): engram meeting/team 명령 + meetings.json + 동적 회의 스케줄러"
```

---

## Task 16: 모듈 배선 + 통합·회귀·스모크

**Files:**
- Modify: `src/agent-layer/agent-layer.module.ts` (신규 provider·resolveBrain 팩토리)
- Modify: `src/knowledge-core/knowledge-core.module.ts` (TaskStore export)
- Modify: `src/edge/edge.module.ts` (MeetingScheduler·CliGateway 의존)
- Create: `src/agent-layer/collaboration.integration.spec.ts`

**Interfaces:**
- TaskStore provider: `useFactory: (paths, lock) => new TaskStore(paths.getStateDir(), lock)`.
- PersonaRegistry provider: `useFactory: (paths) => { const r = new PersonaRegistry(<repo>/personas, logger); return r; }` + onModuleInit에서 `load()`. (personas 디렉토리 = 코드 옆 `personas/`, `path.join(process.cwd(),'personas')` 또는 `__dirname` 기준 해소.)
- PermissionFence provider: `useFactory: (paths) => new PermissionFence(path.join(paths.getConfigDir(),'permissions.json'))` + load.
- SpecialistAgent provider: registry·fence·resolveBrain·rag·logger. `resolveBrain` = brains.json 프로필 맵을 createBrain으로 캐시(프로필별 1회 생성, fence.spawnFlags를 extraArgs로 병합).
- Synthesizer provider: JUDGE_BRAIN 사용(작성자≠종합자) 또는 BRAIN.
- Orchestrator provider: 기존 4 + tasks·specialist·synthesizer·semaphore.

- [ ] **Step 1: 통합 테스트(실 DI, FakeBrain override)**

`collaboration.integration.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { BRAIN, JUDGE_BRAIN } from '../brain/brain.port';
import { FakeBrain } from '../brain/fake-brain';
import { Orchestrator } from './orchestrator';

it('실 DI 그래프로 협업이 종합 답을 낸다(FakeBrain)', async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(BRAIN).useValue(new FakeBrain({ text: '의견', costUsd: 0, isError: false }))
    .overrideProvider(JUDGE_BRAIN).useValue(new FakeBrain({ text: '종합', costUsd: 0, isError: false }))
    .compile();
  const orc = mod.get(Orchestrator);
  const out = await orc.collaborate('전략?', ['Brand', 'Trend'], 'default');
  expect(typeof out).toBe('string');
  await mod.close();
});
```
> personas 디렉토리가 테스트 cwd에서 해소되는지 확인(안 되면 PersonaRegistry provider 경로를 절대경로로).

- [ ] **Step 2: 실패 확인** — Run: `npx jest collaboration.integration`. Expected: FAIL(배선 전).

- [ ] **Step 3: 모듈 배선** — 위 Interfaces대로 provider 추가. resolveBrain 팩토리 예:
```typescript
// AgentLayerModule 내 SpecialistAgent provider
{
  provide: SpecialistAgent,
  useFactory: (registry, fence, rag, logger, paths) => {
    const cache = new Map<string, BrainProvider>();
    const resolve = (key: string): BrainProvider => {
      if (!cache.has(key)) {
        const profile = loadBrainProfile(paths.getConfigDir(), key);
        cache.set(key, createBrain(profile));
      }
      return cache.get(key)!;
    };
    return new SpecialistAgent(registry, fence, resolve, rag, logger);
  },
  inject: [PersonaRegistry, PermissionFence, RagStore, PinoLogger, PathResolver],
}
```
> fence.spawnFlags를 두뇌 프로필 extraArgs로 합치는 건 resolve 안에서 persona별로 처리하거나, Phase 3 단순화로 SpecialistAgent.contribute가 fence.spawnFlags(persona)를 brain별 extraArgs로 주입하도록 확장(선택). 최소 동작은 위로 충분.

- [ ] **Step 4: 통합 통과 + 전체 회귀** — Run: `npx jest`. Expected: 전체 green(기존 + 신규). Run: `npm run build`. Expected: tsc 클린.

- [ ] **Step 5: 실 스모크(수동, opt-in)** — 실제 `claude` 설치 환경에서:
```
node dist/src/cli.js team Brand,Trend "내 사이드 프로젝트 런칭 전략 한 줄로"
node dist/src/cli.js meeting add 데모 "0 3 * * *" Manager,Record "위키 점검"
node dist/src/cli.js meeting run 데모
```
종합 답 출력 + 회의록 페이지 생성 확인. (Ollama 백엔드 스모크: brains.json에 ollama 프로필 추가 후 페르소나 brain 교체해 1회.)

- [ ] **Step 6: 커밋**
```bash
git add src/agent-layer/agent-layer.module.ts src/knowledge-core/knowledge-core.module.ts src/edge/edge.module.ts src/agent-layer/collaboration.integration.spec.ts
git commit -m "feat: Phase 3 배선 — 협업·회의 DI 통합 + 회귀 + 실 claude 스모크"
```

---

## 완료 기준 (Phase 3)

- [ ] 16 태스크 전부 green, `npm run build` 클린.
- [ ] `engram team A,B "질문"` → 다중 페르소나 협업 종합 답.
- [ ] `engram meeting add/list/run` → 회의 등록·실행, 위키 회의록 + TaskStore 결정 생성.
- [ ] 로컬LLM 백엔드(ollama 프로필) env 교체 동작(스모크).
- [ ] Phase 4 seam 6개 보존: 배정구 단일(collaborate), 에이전트 stateless(진실은 TaskStore), 진전 관측(FSM), 작성자≠종합자(Synthesizer 별도 두뇌), 권한 울타리 default-deny.
- [ ] 백로그(defer): GeminiBrain/CodexBrain 출력 파서 실 보정, fence.spawnFlags의 per-persona extraArgs 정밀 주입, run-state 스위치 본체(Phase 4), 자율 코드 검증 게이트(Phase 4).
