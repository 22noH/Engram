# Phase 2 — C 자율쓰기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대화 로그를 자율 다이제스트해 writer/judge 2콜 검증 파이프라인 + 사람 승인 게이트를 거쳐 위키를 갱신한다.

**Architecture:** 대화 턴을 ConversationStore(JSONL)에 적재 → @Cron/수동 트리거가 Orchestrator.digest()→IngesterAgent를 돌려 writer 추출(추출+중요도+근거)→ImportanceGate 필터→RAG retrieval→judge 판정 후 ProposalStore 결재 대기함에 enqueue. 라이브 위키는 `engram review` 승인 전까지 무손상. 승인 시 WikiEngine이 op를 적용하고 WikiWatcher가 RAG를 재색인.

**Tech Stack:** NestJS / TypeScript / Node 22+, Jest, cross-spawn(claude -p), LanceDB(기존 RagStore), `@nestjs/schedule`(신규).

## Global Constraints

- 셸 스크립트 0개 · OS cron 미사용(in-process `@nestjs/schedule`만) · 경로 하드코딩 금지(`path.join`/PathResolver)
- 코드/데이터 분리: 모든 런타임 데이터는 `runtime/`(PathResolver) 아래. git 미추적.
- stateless 워커: IngesterAgent는 매 run 독립. 작업 경계마다 try/catch(한 실패가 프로세스를 안 죽임, §10.3).
- 두뇌 호출은 BrainProvider 포트 경유. 단위테스트는 FakeBrain 주입(실 claude 우회).
- 모든 흐름은 Orchestrator 경유(Gateway·Scheduler는 Orchestrator만 안다).
- 자동반영 티어 없음 — Phase 2는 전부 사람 승인. 출처 없는 사실은 폐기.
- 셸: PowerShell. 테스트 실행 `npx jest <path>`. 통합 임베더 테스트는 `$env:ENGRAM_RAG_INTEGRATION=1` opt-in.

---

### Task 1: ConversationStore

대화 턴을 append-only JSONL로 적재하고 워터마크 이후만 읽는다. B 수집 경로의 소스.

**Files:**
- Create: `src/knowledge-core/conversation-store.ts`
- Test: `src/knowledge-core/conversation-store.spec.ts`

**Interfaces:**
- Consumes: `PathResolver`(기존, `getDataDir()`), `DEFAULT_USER`.
- Produces:
  ```ts
  export interface ConversationRecord { ts: string; question: string; answer: string }
  @Injectable() export class ConversationStore {
    constructor(paths: PathResolver)
    append(userId: string, rec: ConversationRecord): Promise<void>
    since(userId: string, cursorTs: string | null): Promise<ConversationRecord[]>  // ts > cursorTs, 시간순. cursorTs=null이면 전체.
    readCursor(userId: string): Promise<string | null>   // runtime/state/ingest-cursor.json
    writeCursor(userId: string, ts: string): Promise<void>
  }
  ```
- 경로: `runtime/state/conversations/{userId}/YYYY-MM-DD.jsonl` (ts의 날짜로 파일 분할), 커서 `runtime/state/ingest-cursor.json` = `{ [userId]: lastTs }`.
- 참고: 출처(sources)는 별도 필드로 두지 않는다 — writer 추출이 대화 본문에서 직접 인용. (스펙 §4.1 단순화)

- [ ] **Step 1: Write the failing test**

```ts
// src/knowledge-core/conversation-store.spec.ts
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ConversationStore } from './conversation-store';
import { PathResolver } from '../pal/path-resolver';

describe('ConversationStore', () => {
  let dir: string; let store: ConversationStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-conv-'));
    store = new ConversationStore(new PathResolver(dir));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('append한 레코드를 since(null)로 전부 읽는다', async () => {
    await store.append('default', { ts: '2026-06-26T01:00:00.000Z', question: 'q1', answer: 'a1' });
    await store.append('default', { ts: '2026-06-27T01:00:00.000Z', question: 'q2', answer: 'a2' });
    const all = await store.since('default', null);
    expect(all.map((r) => r.question)).toEqual(['q1', 'q2']); // 날짜 파일 경계 가로지름, 시간순
  });

  it('커서 이후만 반환한다', async () => {
    await store.append('default', { ts: '2026-06-26T01:00:00.000Z', question: 'old', answer: 'a' });
    await store.append('default', { ts: '2026-06-26T02:00:00.000Z', question: 'new', answer: 'a' });
    const recent = await store.since('default', '2026-06-26T01:30:00.000Z');
    expect(recent.map((r) => r.question)).toEqual(['new']);
  });

  it('대화 없으면 since는 빈 배열, readCursor는 null', async () => {
    expect(await store.since('default', null)).toEqual([]);
    expect(await store.readCursor('default')).toBeNull();
  });

  it('writeCursor→readCursor 라운드트립', async () => {
    await store.writeCursor('default', '2026-06-26T05:00:00.000Z');
    expect(await store.readCursor('default')).toBe('2026-06-26T05:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx jest src/knowledge-core/conversation-store.spec.ts` → FAIL (모듈 없음)

- [ ] **Step 3: Write minimal implementation**

```ts
// src/knowledge-core/conversation-store.ts
import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PathResolver, DEFAULT_USER } from '../pal/path-resolver';

export interface ConversationRecord { ts: string; question: string; answer: string }

@Injectable()
export class ConversationStore {
  constructor(private readonly paths: PathResolver) {}

  private convDir(userId: string): string {
    return path.join(this.paths.getDataDir(), 'state', 'conversations', userId);
  }
  private cursorPath(): string {
    return path.join(this.paths.getDataDir(), 'state', 'ingest-cursor.json');
  }

  async append(userId: string = DEFAULT_USER, rec: ConversationRecord): Promise<void> {
    const dir = this.convDir(userId);
    await fs.mkdir(dir, { recursive: true });
    const day = rec.ts.slice(0, 10); // YYYY-MM-DD
    await fs.appendFile(path.join(dir, `${day}.jsonl`), JSON.stringify(rec) + '\n');
  }

  async since(userId: string = DEFAULT_USER, cursorTs: string | null): Promise<ConversationRecord[]> {
    const dir = this.convDir(userId);
    let files: string[];
    try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const out: ConversationRecord[] = [];
    for (const f of files) {
      const text = await fs.readFile(path.join(dir, f), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line) as ConversationRecord;
        if (cursorTs === null || rec.ts > cursorTs) out.push(rec);
      }
    }
    return out.sort((a, b) => a.ts.localeCompare(b.ts));
  }

  async readCursor(userId: string = DEFAULT_USER): Promise<string | null> {
    try {
      const map = JSON.parse(await fs.readFile(this.cursorPath(), 'utf8')) as Record<string, string>;
      return map[userId] ?? null;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }

  async writeCursor(userId: string = DEFAULT_USER, ts: string): Promise<void> {
    let map: Record<string, string> = {};
    try { map = JSON.parse(await fs.readFile(this.cursorPath(), 'utf8')); } catch { /* 없으면 새로 */ }
    map[userId] = ts;
    await fs.mkdir(path.dirname(this.cursorPath()), { recursive: true });
    await fs.writeFile(this.cursorPath(), JSON.stringify(map, null, 2));
  }
}
```

- [ ] **Step 4: Run test to verify it passes** — `npx jest src/knowledge-core/conversation-store.spec.ts` → PASS (4 tests)

- [ ] **Step 5: Register provider + commit** — KnowledgeCoreModule providers에 `ConversationStore` 추가, exports에도 추가.

```bash
git add src/knowledge-core/conversation-store.ts src/knowledge-core/conversation-store.spec.ts src/knowledge-core/knowledge-core.module.ts
git commit -m "feat(core): ConversationStore — 대화 턴 JSONL 적재 + 워터마크"
```

---

### Task 2: Orchestrator 턴 로깅 배선

매 `route()` 턴 완료 후 대화를 적재한다.

**Files:**
- Modify: `src/agent-layer/orchestrator.ts`
- Modify: `src/agent-layer/agent-layer.module.ts` (KnowledgeCoreModule이 ConversationStore export → 이미 import 중이라 주입만)
- Test: `src/agent-layer/orchestrator.spec.ts` (기존, 케이스 추가)

**Interfaces:**
- Consumes: `ConversationStore.append`(T1), `ReaderAgent.handle`(기존).
- Produces: `Orchestrator.route()` 동작 불변 + 부수효과로 ConversationStore.append 1회.

- [ ] **Step 1: Write the failing test** (기존 spec에 추가)

```ts
it('route 후 대화를 ConversationStore에 적재한다', async () => {
  const appended: any[] = [];
  const convStore = { append: async (_u: string, r: any) => { appended.push(r); } } as any;
  const reader = { handle: async () => 'the answer' } as any;
  const orch = new Orchestrator(reader, convStore);
  await orch.route({ text: 'my question', userId: 'default' });
  expect(appended).toHaveLength(1);
  expect(appended[0].question).toBe('my question');
  expect(appended[0].answer).toBe('the answer');
  expect(typeof appended[0].ts).toBe('string');
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx jest src/agent-layer/orchestrator.spec.ts` → FAIL (생성자 인자 불일치)

- [ ] **Step 3: Implement**

```ts
// src/agent-layer/orchestrator.ts
import { Injectable } from '@nestjs/common';
import { ReaderAgent } from './reader-agent';
import { ConversationStore } from '../knowledge-core/conversation-store';
import { CoreMessage } from '../edge/core-message';

@Injectable()
export class Orchestrator {
  constructor(
    private readonly reader: ReaderAgent,
    private readonly conversations: ConversationStore,
  ) {}

  async route(msg: CoreMessage, onChunk?: (t: string) => void): Promise<string> {
    const answer = await this.reader.handle(msg, onChunk);
    await this.conversations.append(msg.userId, {
      ts: new Date().toISOString(), question: msg.text, answer,
    });
    return answer;
  }
}
```

- [ ] **Step 4: Run tests** — `npx jest src/agent-layer/orchestrator.spec.ts` → PASS (기존 + 신규)
- [ ] **Step 5: Commit**

```bash
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator.spec.ts
git commit -m "feat(agent): Orchestrator가 매 턴 대화를 ConversationStore에 적재"
```

---

### Task 3: ImportanceGate

후보 사실을 중요도 임계치로 거른다(§5.3). 채점은 writer 추출이 동봉, 게이트는 순수 필터.

**Files:**
- Create: `src/knowledge-core/importance-gate.ts`
- Test: `src/knowledge-core/importance-gate.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ScoredFact { claim: string; importance: number; sourceQuote: string }
  @Injectable() export class ImportanceGate {
    constructor()  // 임계치는 ENGRAM_IMPORTANCE_THRESHOLD env(기본 3), 비숫자/범위밖이면 3
    filter(facts: ScoredFact[]): ScoredFact[]   // importance >= threshold
    readonly threshold: number
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/knowledge-core/importance-gate.spec.ts
import { ImportanceGate } from './importance-gate';

const f = (importance: number) => ({ claim: 'c', importance, sourceQuote: 's' });

describe('ImportanceGate', () => {
  it('기본 임계치 3 미만은 폐기한다', () => {
    const gate = new ImportanceGate({} as any);
    expect(gate.threshold).toBe(3);
    expect(gate.filter([f(1), f(2), f(3), f(5)]).map((x) => x.importance)).toEqual([3, 5]);
  });
  it('env 임계치를 따른다', () => {
    const gate = new ImportanceGate({ ENGRAM_IMPORTANCE_THRESHOLD: '4' } as any);
    expect(gate.filter([f(3), f(4)]).map((x) => x.importance)).toEqual([4]);
  });
  it('비숫자 env는 기본 3으로 폴백한다', () => {
    const gate = new ImportanceGate({ ENGRAM_IMPORTANCE_THRESHOLD: 'abc' } as any);
    expect(gate.threshold).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (모듈 없음)

- [ ] **Step 3: Implement**

```ts
// src/knowledge-core/importance-gate.ts
import { Injectable } from '@nestjs/common';

export interface ScoredFact { claim: string; importance: number; sourceQuote: string }

@Injectable()
export class ImportanceGate {
  readonly threshold: number;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    const n = Number(env.ENGRAM_IMPORTANCE_THRESHOLD);
    this.threshold = Number.isFinite(n) && n >= 1 && n <= 5 ? n : 3; // §5.3 1~5, 기본 3
  }
  filter(facts: ScoredFact[]): ScoredFact[] {
    return facts.filter((x) => x.importance >= this.threshold);
  }
}
```

- [ ] **Step 4: Run test to verify it passes** — PASS (3 tests)
- [ ] **Step 5: Register + commit** — KnowledgeCoreModule providers/exports에 `{ provide: ImportanceGate, useFactory: () => new ImportanceGate() }` 추가.

```bash
git add src/knowledge-core/importance-gate.ts src/knowledge-core/importance-gate.spec.ts src/knowledge-core/knowledge-core.module.ts
git commit -m "feat(core): ImportanceGate — 중요도 3점↑ 필터(§5.3)"
```

---

### Task 4: ProposalStore

승인 대기 제안 큐(`runtime/state/proposals/`). 위키 밖 결재 대기함.

**Files:**
- Create: `src/knowledge-core/proposal-store.ts`
- Test: `src/knowledge-core/proposal-store.spec.ts`

**Interfaces:**
- Consumes: `PathResolver`.
- Produces:
  ```ts
  export type ProposalOp = 'create' | 'append' | 'supersede';
  export interface ProposalVerdict { confidence: number; reason: string; conflictSlugs?: string[] }
  export interface Proposal {
    id: string; userId: string; createdTs: string;
    op: ProposalOp; targetSlug: string; title: string; category: string;
    payload: string; sources: string[]; importance: number;
    verdict: ProposalVerdict; status: 'pending' | 'approved' | 'rejected';
  }
  export type NewProposal = Omit<Proposal, 'id' | 'createdTs' | 'status'>;
  @Injectable() export class ProposalStore {
    constructor(paths: PathResolver)
    enqueue(p: NewProposal): Promise<Proposal>     // id·createdTs 부여, status='pending'
    listPending(userId?: string): Promise<Proposal[]>  // createdTs 오름차순
    get(id: string): Promise<Proposal | null>
    markApproved(id: string): Promise<void>
    markRejected(id: string): Promise<void>
  }
  ```
- 경로: `runtime/state/proposals/{id}.json`. id = `${createdTs 압축}-${targetSlug}-${rand}` 충돌없는 키.

- [ ] **Step 1: Write the failing test**

```ts
// src/knowledge-core/proposal-store.spec.ts
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ProposalStore } from './proposal-store';
import { PathResolver } from '../pal/path-resolver';

const sample = (slug: string) => ({
  userId: 'default', op: 'create' as const, targetSlug: slug, title: 'T', category: 'general',
  payload: 'body', sources: ['conv:2026-06-26T01:00'], importance: 4,
  verdict: { confidence: 0.9, reason: 'ok' },
});

describe('ProposalStore', () => {
  let dir: string; let store: ProposalStore;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-prop-')); store = new ProposalStore(new PathResolver(dir)); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('enqueue는 id·createdTs·pending을 부여한다', async () => {
    const p = await store.enqueue(sample('alpha'));
    expect(p.id).toBeTruthy();
    expect(p.status).toBe('pending');
    expect((await store.get(p.id))?.targetSlug).toBe('alpha');
  });
  it('listPending은 pending만 createdTs순으로 반환한다', async () => {
    const a = await store.enqueue(sample('a'));
    await store.enqueue(sample('b'));
    await store.markRejected(a.id);
    const pend = await store.listPending();
    expect(pend.map((x) => x.targetSlug)).toEqual(['b']);
  });
  it('markApproved는 상태를 전이한다', async () => {
    const p = await store.enqueue(sample('c'));
    await store.markApproved(p.id);
    expect((await store.get(p.id))?.status).toBe('approved');
    expect(await store.listPending()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (모듈 없음)

- [ ] **Step 3: Implement**

```ts
// src/knowledge-core/proposal-store.ts
import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PathResolver } from '../pal/path-resolver';

export type ProposalOp = 'create' | 'append' | 'supersede';
export interface ProposalVerdict { confidence: number; reason: string; conflictSlugs?: string[] }
export interface Proposal {
  id: string; userId: string; createdTs: string;
  op: ProposalOp; targetSlug: string; title: string; category: string;
  payload: string; sources: string[]; importance: number;
  verdict: ProposalVerdict; status: 'pending' | 'approved' | 'rejected';
}
export type NewProposal = Omit<Proposal, 'id' | 'createdTs' | 'status'>;

@Injectable()
export class ProposalStore {
  constructor(private readonly paths: PathResolver) {}
  private dir(): string { return path.join(this.paths.getDataDir(), 'state', 'proposals'); }
  private file(id: string): string { return path.join(this.dir(), `${id}.json`); }

  async enqueue(p: NewProposal): Promise<Proposal> {
    const createdTs = new Date().toISOString();
    const rand = Math.floor(Math.random() * 1e6).toString(36); // 런타임 — Math.random 허용
    const id = `${createdTs.replace(/[:.]/g, '-')}-${p.targetSlug}-${rand}`;
    const full: Proposal = { ...p, id, createdTs, status: 'pending' };
    await fs.mkdir(this.dir(), { recursive: true });
    await fs.writeFile(this.file(id), JSON.stringify(full, null, 2));
    return full;
  }
  async get(id: string): Promise<Proposal | null> {
    try { return JSON.parse(await fs.readFile(this.file(id), 'utf8')) as Proposal; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  async listPending(userId?: string): Promise<Proposal[]> {
    let files: string[];
    try { files = (await fs.readdir(this.dir())).filter((f) => f.endsWith('.json')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const out: Proposal[] = [];
    for (const f of files) {
      const p = JSON.parse(await fs.readFile(path.join(this.dir(), f), 'utf8')) as Proposal;
      if (p.status === 'pending' && (!userId || p.userId === userId)) out.push(p);
    }
    return out.sort((a, b) => a.createdTs.localeCompare(b.createdTs));
  }
  private async setStatus(id: string, status: Proposal['status']): Promise<void> {
    const p = await this.get(id);
    if (!p) throw new Error(`Proposal not found: ${id}`);
    p.status = status;
    await fs.writeFile(this.file(id), JSON.stringify(p, null, 2));
  }
  markApproved(id: string): Promise<void> { return this.setStatus(id, 'approved'); }
  markRejected(id: string): Promise<void> { return this.setStatus(id, 'rejected'); }
}
```

- [ ] **Step 4: Run test to verify it passes** — PASS (3 tests)
- [ ] **Step 5: Register + commit** — KnowledgeCoreModule providers/exports에 `ProposalStore` 추가.

```bash
git add src/knowledge-core/proposal-store.ts src/knowledge-core/proposal-store.spec.ts src/knowledge-core/knowledge-core.module.ts
git commit -m "feat(core): ProposalStore — 승인 대기 제안 큐(결재 대기함)"
```

---

### Task 5: brain multi-profile + judge

named 프로필 해소를 추가하고 judge 두뇌를 별도 토큰으로 제공한다. judge 프로필이 brains.json에 없으면 default로 폴백.

**Files:**
- Modify: `src/brain/brain.config.ts` (named 프로필 해소 + DEFAULT_FILE에 judge 추가)
- Modify: `src/brain/brain.port.ts` (JUDGE_BRAIN 토큰 추가)
- Modify: `src/brain/brain.module.ts` (JUDGE_BRAIN provider)
- Test: `src/brain/brain.config.spec.ts` (케이스 추가)

**Interfaces:**
- Produces:
  ```ts
  // brain.config.ts — 추가
  export function loadBrainProfile(configDir: string, name: string, env?: NodeJS.ProcessEnv): BrainProfile
  // name 프로필이 없으면 default 프로필로 폴백(throw 안 함). env 덮어쓰기는 활성/일반 동일 규칙.
  // brain.port.ts — 추가
  export const JUDGE_BRAIN: unique symbol = Symbol('JUDGE_BRAIN');
  ```

- [ ] **Step 1: Write the failing test** (brain.config.spec.ts에 추가)

```ts
import { loadBrainProfile } from './brain.config';

it('loadBrainProfile은 지정 프로필을 해소한다', () => {
  fs.writeFileSync(path.join(dir, 'brains.json'), JSON.stringify({
    default: 'w', brains: {
      w: { provider: 'claude-cli', model: 'opus' },
      judge: { provider: 'claude-cli', model: 'haiku' },
    },
  }));
  expect(loadBrainProfile(dir, 'judge', {}).model).toBe('haiku');
});
it('없는 프로필은 default로 폴백한다', () => {
  fs.writeFileSync(path.join(dir, 'brains.json'), JSON.stringify({
    default: 'w', brains: { w: { provider: 'claude-cli', model: 'opus' } },
  }));
  expect(loadBrainProfile(dir, 'judge', {}).model).toBe('opus'); // judge 없음 → default(w)
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (loadBrainProfile 없음)

- [ ] **Step 3: Implement** — `brain.config.ts`에서 공통 해소 로직을 함수로 빼고 두 진입점 제공.

```ts
// brain.config.ts — DEFAULT_FILE에 judge 추가
const DEFAULT_FILE: BrainsFile = {
  default: 'claude',
  brains: { claude: { ...DEFAULTS }, judge: { ...DEFAULTS } }, // judge 분리는 사용자가 모델만 바꾸면 됨
};

// 공통: 파일 로드(+없으면 생성)
function readBrainsFile(configDir: string): BrainsFile {
  const file = path.join(configDir, 'brains.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as BrainsFile;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(DEFAULT_FILE, null, 2));
  return DEFAULT_FILE;
}

function resolve(cfg: BrainsFile, name: string, env: NodeJS.ProcessEnv): BrainProfile {
  const raw = cfg.brains?.[name];
  if (!raw) throw new Error(`brains.json: '${name}' 프로필이 없습니다`);
  const profile: BrainProfile = { ...DEFAULTS, ...raw };
  if (env.ENGRAM_BRAIN_CLI) profile.cli = env.ENGRAM_BRAIN_CLI;
  if (env.ENGRAM_BRAIN_MODEL) profile.model = env.ENGRAM_BRAIN_MODEL;
  profile.concurrency = posIntEnv(env.ENGRAM_BRAIN_CONCURRENCY, profile.concurrency);
  profile.timeoutMs = posIntEnv(env.ENGRAM_BRAIN_TIMEOUT_MS, profile.timeoutMs);
  if (profile.provider !== 'claude-cli') {
    throw new Error(`지원하지 않는 provider: ${profile.provider} (Phase 1·2는 claude-cli만)`);
  }
  return profile;
}

export function loadActiveBrain(configDir: string, env: NodeJS.ProcessEnv = process.env): BrainProfile {
  const cfg = readBrainsFile(configDir);
  if (!cfg.brains?.[cfg.default]) throw new Error(`brains.json: default '${cfg.default}' 프로필이 없습니다`);
  return resolve(cfg, cfg.default, env);
}

// name 프로필이 없으면 default로 폴백(별도 judge는 opt-in: 사용자가 brains.json에 채우면 분리됨).
export function loadBrainProfile(configDir: string, name: string, env: NodeJS.ProcessEnv = process.env): BrainProfile {
  const cfg = readBrainsFile(configDir);
  const target = cfg.brains?.[name] ? name : cfg.default;
  return resolve(cfg, target, env);
}
```

```ts
// brain.port.ts — 끝에 추가
export const JUDGE_BRAIN = Symbol('JUDGE_BRAIN'); // judge 전용 두뇌 DI 토큰(작성자≠검증자)
```

```ts
// brain.module.ts — providers/exports에 추가
import { BRAIN, JUDGE_BRAIN } from './brain.port';
import { loadActiveBrain, loadBrainProfile } from './brain.config';
// providers 배열:
{ provide: BRAIN, useFactory: () => new ClaudeCliBrain(loadActiveBrain(new PathResolver().getConfigDir())) },
{ provide: JUDGE_BRAIN, useFactory: () => new ClaudeCliBrain(loadBrainProfile(new PathResolver().getConfigDir(), 'judge')) },
// exports: [BRAIN, JUDGE_BRAIN]
```

- [ ] **Step 4: Run tests** — `npx jest src/brain/` → PASS (기존 + 신규 2)
- [ ] **Step 5: Commit**

```bash
git add src/brain/brain.config.ts src/brain/brain.config.spec.ts src/brain/brain.port.ts src/brain/brain.module.ts
git commit -m "feat(brain): named 프로필 해소 + JUDGE_BRAIN(작성자≠검증자, 없으면 default 폴백)"
```

---

### Task 6: IngesterAgent — writer 추출 + JSON 파싱 방어

대화 배치 → writer 콜 → 후보 사실 JSON 파싱 → ImportanceGate 필터. (retrieval/judge는 T7)

**Files:**
- Create: `src/agent-layer/ingester-agent.ts`
- Test: `src/agent-layer/ingester-agent.spec.ts`

**Interfaces:**
- Consumes: `ConversationStore`(T1), `ImportanceGate`+`ScoredFact`(T3), `BRAIN`(BrainProvider), `JUDGE_BRAIN`(T5, T7서 사용), `RagStore`(T7), `ProposalStore`(T7), `PinoLogger`.
- Produces:
  ```ts
  @Injectable() export class IngesterAgent {
    constructor(conversations, gate, @Inject(BRAIN) writer, @Inject(JUDGE_BRAIN) judge, rag, proposals, logger)
    run(userId?: string): Promise<{ extracted: number; gated: number; proposed: number }>
    extractFacts(convText: string): Promise<ScoredFact[]>   // writer 콜 + 파싱 (T6 범위)
  }
  export function parseJsonBlock<T>(text: string): T | null  // 코드펜스/잡텍스트에서 첫 JSON 추출
  ```
- writer 프롬프트 계약: 대화 텍스트 → JSON 배열 `[{ "claim": string, "importance": 1-5, "sourceQuote": string }]`. sourceQuote 빈 항목은 추출기가 버림.

- [ ] **Step 1: Write the failing test**

```ts
// src/agent-layer/ingester-agent.spec.ts
import { IngesterAgent, parseJsonBlock } from './ingester-agent';
import { FakeBrain } from '../brain/fake-brain';
import { ImportanceGate } from '../knowledge-core/importance-gate';

const noopLogger = { error: () => {}, info: () => {} } as any;

describe('parseJsonBlock', () => {
  it('코드펜스 안 JSON을 뽑는다', () => {
    expect(parseJsonBlock('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });
  it('잡텍스트 사이 JSON 배열을 뽑는다', () => {
    expect(parseJsonBlock('여기 있음: [{"a":1}] 끝')).toEqual([{ a: 1 }]);
  });
  it('JSON 없으면 null', () => { expect(parseJsonBlock('그냥 텍스트')).toBeNull(); });
});

describe('IngesterAgent.extractFacts', () => {
  const facts = [
    { claim: '중요한 사실', importance: 4, sourceQuote: '대화 인용' },
    { claim: '사소', importance: 1, sourceQuote: 'q' },
    { claim: '출처없음', importance: 5, sourceQuote: '' },
  ];
  it('writer 출력을 파싱하고 출처없는 항목을 버린다', async () => {
    const writer = new FakeBrain({ text: JSON.stringify(facts), costUsd: 0, isError: false });
    const agent = new IngesterAgent({} as any, new ImportanceGate({} as any), writer, {} as any, {} as any, {} as any, noopLogger);
    const out = await agent.extractFacts('대화');
    expect(out.map((f) => f.claim)).toEqual(['중요한 사실', '사소']); // 출처없음 제거, 중요도 필터는 run에서
  });
  it('파싱 실패 시 빈 배열 + 경고', async () => {
    const writer = new FakeBrain({ text: '망가진 출력', costUsd: 0, isError: false });
    const agent = new IngesterAgent({} as any, new ImportanceGate({} as any), writer, {} as any, {} as any, {} as any, noopLogger);
    expect(await agent.extractFacts('대화')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (모듈 없음)

- [ ] **Step 3: Implement** (T6 범위: 생성자 + parseJsonBlock + extractFacts. run은 스텁 후 T7에서 완성)

```ts
// src/agent-layer/ingester-agent.ts
import { Inject, Injectable } from '@nestjs/common';
import { ConversationStore } from '../knowledge-core/conversation-store';
import { ImportanceGate, ScoredFact } from '../knowledge-core/importance-gate';
import { RagStore } from '../knowledge-core/rag/rag-store';
import { ProposalStore } from '../knowledge-core/proposal-store';
import { BRAIN, JUDGE_BRAIN, BrainProvider } from '../brain/brain.port';
import { PinoLogger } from '../pal/logger';
import { DEFAULT_USER } from '../pal/path-resolver';

// 코드펜스/잡텍스트에서 첫 JSON(객체 또는 배열)을 뽑아 파싱. 실패 시 null.
export function parseJsonBlock<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  const open = candidate[start]; const close = open === '[' ? ']' : '}';
  const end = candidate.lastIndexOf(close);
  if (end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)) as T; } catch { return null; }
}

@Injectable()
export class IngesterAgent {
  constructor(
    private readonly conversations: ConversationStore,
    private readonly gate: ImportanceGate,
    @Inject(BRAIN) private readonly writer: BrainProvider,
    @Inject(JUDGE_BRAIN) private readonly judge: BrainProvider,
    private readonly rag: RagStore,
    private readonly proposals: ProposalStore,
    private readonly logger: PinoLogger,
  ) {}

  async extractFacts(convText: string): Promise<ScoredFact[]> {
    const prompt = [
      '아래 대화에서 위키에 기록할 가치가 있는 사실만 추출하라.',
      '각 사실에 중요도(importance) 1~5점과 대화에서의 근거 인용(sourceQuote)을 달아라.',
      '출력은 JSON 배열만: [{"claim": string, "importance": number, "sourceQuote": string}]',
      '', `# 대화\n${convText}`,
    ].join('\n');
    const res = await this.writer.complete(prompt);
    if (res.isError) { this.logger.error('writer 추출 실패', String(res.raw), 'IngesterAgent'); return []; }
    const parsed = parseJsonBlock<ScoredFact[]>(res.text);
    if (!Array.isArray(parsed)) { this.logger.error('writer JSON 파싱 실패', res.text.slice(0, 200), 'IngesterAgent'); return []; }
    return parsed.filter((f) => f && typeof f.claim === 'string' && f.sourceQuote); // 출처없으면 거부(§6)
  }

  // T7에서 완성
  async run(userId: string = DEFAULT_USER): Promise<{ extracted: number; gated: number; proposed: number }> {
    return { extracted: 0, gated: 0, proposed: 0 };
  }
}
```

- [ ] **Step 4: Run test to verify it passes** — PASS (parseJsonBlock 3 + extractFacts 2)
- [ ] **Step 5: Commit**

```bash
git add src/agent-layer/ingester-agent.ts src/agent-layer/ingester-agent.spec.ts
git commit -m "feat(agent): IngesterAgent writer 추출 + JSON 파싱 방어 + 출처 필수"
```

---

### Task 7: IngesterAgent — retrieval + judge + enqueue

추출·필터된 사실마다 RAG 검색 → judge 콜 → verdict 분기 → ProposalStore enqueue. run() 완성.

**Files:**
- Modify: `src/agent-layer/ingester-agent.ts`
- Modify: `src/agent-layer/ingester-agent.spec.ts`

**Interfaces:**
- Consumes: `RagStore.search(query, k, userId)`→`SearchResult[]`(기존), `ProposalStore.enqueue`(T4), judge BrainProvider(T5).
- Produces: `run(userId)` 완성 — `{ extracted, gated, proposed }`. judge 출력 계약:
  `{ "verdict": "create"|"append"|"supersede"|"reject", "targetSlug"?: string, "title"?: string, "category"?: string, "confidence": number, "reason": string, "conflictSlugs"?: string[] }`

- [ ] **Step 1: Write the failing test** (배치 전체 — Fake writer/judge 주입)

```ts
// ingester-agent.spec.ts에 추가
import { ConversationStore } from '../knowledge-core/conversation-store';

class FakeConv {
  constructor(private recs: any[]) {}
  since = async () => this.recs;
  readCursor = async () => null;
  writeCursor = async () => {};
}
class FakeRag { search = async () => [] as any[]; }
class CaptureProposals { items: any[] = []; enqueue = async (p: any) => { this.items.push(p); return { ...p, id: 'x', status: 'pending' }; }; }

it('run: 추출→게이트→judge→enqueue 한 바퀴', async () => {
  const conv = new FakeConv([{ ts: '2026-06-26T01:00:00.000Z', question: 'q', answer: 'a' }]);
  const writer = new FakeBrain({ text: JSON.stringify([
    { claim: '중요', importance: 4, sourceQuote: '인용' },
    { claim: '사소', importance: 1, sourceQuote: '인용' },
  ]), costUsd: 0, isError: false });
  const judge = new FakeBrain({ text: JSON.stringify({
    verdict: 'create', targetSlug: 'jungyo', title: '중요', category: 'general', confidence: 0.9, reason: '신규',
  }), costUsd: 0, isError: false });
  const props = new CaptureProposals();
  const agent = new IngesterAgent(conv as any, new ImportanceGate({} as any), writer, judge, new FakeRag() as any, props as any, noopLogger);

  const stats = await agent.run('default');
  expect(stats.extracted).toBe(2);
  expect(stats.gated).toBe(1);          // '사소'(1점) 폐기
  expect(stats.proposed).toBe(1);       // '중요'만 제안
  expect(props.items[0].op).toBe('create');
  expect(props.items[0].sources).toContain('인용');
});

it('run: judge가 reject하면 제안 안 만든다', async () => {
  const conv = new FakeConv([{ ts: '2026-06-26T01:00:00.000Z', question: 'q', answer: 'a' }]);
  const writer = new FakeBrain({ text: JSON.stringify([{ claim: 'c', importance: 5, sourceQuote: 's' }]), costUsd: 0, isError: false });
  const judge = new FakeBrain({ text: JSON.stringify({ verdict: 'reject', confidence: 0.2, reason: '근거부족' }), costUsd: 0, isError: false });
  const props = new CaptureProposals();
  const agent = new IngesterAgent(conv as any, new ImportanceGate({} as any), writer, judge, new FakeRag() as any, props as any, noopLogger);
  const stats = await agent.run('default');
  expect(stats.proposed).toBe(0);
  expect(props.items).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (run 스텁이 0 반환)

- [ ] **Step 3: Implement run()**

```ts
// ingester-agent.ts — run() 교체, SearchResult import 추가
import { SearchResult } from '../knowledge-core/rag/rag.types';
import { Proposal, ProposalOp } from '../knowledge-core/proposal-store';

interface JudgeOut {
  verdict: ProposalOp | 'reject';
  targetSlug?: string; title?: string; category?: string;
  confidence: number; reason: string; conflictSlugs?: string[];
}

async run(userId: string = DEFAULT_USER): Promise<{ extracted: number; gated: number; proposed: number }> {
  try {
    const cursor = await this.conversations.readCursor(userId);
    const recs = await this.conversations.since(userId, cursor);
    if (recs.length === 0) return { extracted: 0, gated: 0, proposed: 0 };

    const convText = recs.map((r) => `Q: ${r.question}\nA: ${r.answer}`).join('\n\n');
    const facts = await this.extractFacts(convText);
    const gated = this.gate.filter(facts);

    let proposed = 0;
    for (const fact of gated) {
      const hits = await this.rag.search(fact.claim, 5, userId);
      const v = await this.judgeFact(fact, hits);
      if (!v || v.verdict === 'reject') continue;
      await this.proposals.enqueue({
        userId,
        op: v.verdict,
        targetSlug: v.targetSlug ?? slugify(fact.claim),
        title: v.title ?? fact.claim.slice(0, 60),
        category: v.category ?? 'general',
        payload: fact.claim,
        sources: [fact.sourceQuote],
        importance: fact.importance,
        verdict: { confidence: v.confidence, reason: v.reason, conflictSlugs: v.conflictSlugs },
      });
      proposed++;
    }
    // 워터마크 전진 — 마지막 레코드 ts
    await this.conversations.writeCursor(userId, recs[recs.length - 1].ts);
    return { extracted: facts.length, gated: gated.length, proposed };
  } catch (err) {
    this.logger.error('IngesterAgent.run 실패', String(err), 'IngesterAgent');
    return { extracted: 0, gated: 0, proposed: 0 };
  }
}

private async judgeFact(fact: ScoredFact, hits: SearchResult[]): Promise<JudgeOut | null> {
  const ctx = hits.map((h, i) => `[${i + 1}] ${h.title} (slug: ${h.slug})\n${h.text}`).join('\n\n');
  const prompt = [
    '아래 후보 사실을 검증하라(너는 작성자가 아닌 검증자다).',
    '기존 위키와 비교해 판정하라:',
    '- create: 신규 주제 → 새 페이지',
    '- append: 기존 페이지에 보강(targetSlug=기존 slug)',
    '- supersede: 기존과 모순 → 기존을 대체(targetSlug=기존 slug, conflictSlugs 명시, 덮어쓰기 금지)',
    '- reject: 근거 부족·환각·무가치',
    '출력은 JSON 객체만: {"verdict","targetSlug","title","category","confidence","reason","conflictSlugs"}',
    '', `# 후보 사실\n${fact.claim}\n근거: ${fact.sourceQuote}`,
    '', `# 관련 기존 위키\n${ctx || '(없음)'}`,
  ].join('\n');
  const res = await this.judge.complete(prompt);
  if (res.isError) { this.logger.error('judge 호출 실패', String(res.raw), 'IngesterAgent'); return null; }
  const out = parseJsonBlock<JudgeOut>(res.text);
  if (!out || typeof out.verdict !== 'string') { this.logger.error('judge JSON 파싱 실패', res.text.slice(0, 200), 'IngesterAgent'); return null; }
  return out;
}
```

```ts
// ingester-agent.ts 하단에 slug 헬퍼
function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
}
```

- [ ] **Step 4: Run test to verify it passes** — `npx jest src/agent-layer/ingester-agent.spec.ts` → PASS
- [ ] **Step 5: Register + commit** — AgentLayerModule providers에 `IngesterAgent` 추가(아직 export 불필요; Orchestrator가 같은 모듈서 주입).

```bash
git add src/agent-layer/ingester-agent.ts src/agent-layer/ingester-agent.spec.ts src/agent-layer/agent-layer.module.ts
git commit -m "feat(agent): IngesterAgent run — retrieval+judge+verdict 분기→제안 enqueue"
```

---

### Task 8: Orchestrator.digest() + `engram digest`

다이제스트 흐름을 Orchestrator 경유로 노출하고 CLI 수동 트리거를 단다.

**Files:**
- Modify: `src/agent-layer/orchestrator.ts` (digest seam)
- Modify: `src/agent-layer/orchestrator.spec.ts`
- Modify: `src/edge/cli.gateway.ts` (`engram digest`)
- Modify: `src/edge/cli.gateway.spec.ts`

**Interfaces:**
- Produces: `Orchestrator.digest(userId): Promise<{extracted;gated;proposed}>` = `ingester.run(userId)` 위임.

- [ ] **Step 1: Write the failing test**

```ts
// orchestrator.spec.ts
it('digest는 IngesterAgent.run에 위임한다', async () => {
  const ingester = { run: jest.fn().mockResolvedValue({ extracted: 2, gated: 1, proposed: 1 }) } as any;
  const orch = new Orchestrator({} as any, {} as any, ingester);
  expect(await orch.digest('default')).toEqual({ extracted: 2, gated: 1, proposed: 1 });
  expect(ingester.run).toHaveBeenCalledWith('default');
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (생성자/digest 없음)

- [ ] **Step 3: Implement**

```ts
// orchestrator.ts — 생성자에 IngesterAgent 추가, digest 메서드
constructor(
  private readonly reader: ReaderAgent,
  private readonly conversations: ConversationStore,
  private readonly ingester: IngesterAgent,
) {}

digest(userId: string = DEFAULT_USER): Promise<{ extracted: number; gated: number; proposed: number }> {
  return this.ingester.run(userId);
}
```

```ts
// cli.gateway.ts — run() 분기에 추가
} else if (argv[0] === 'digest') {
  const s = await this.orchestrator.digest(DEFAULT_USER);
  process.stdout.write(`다이제스트 완료: 추출 ${s.extracted} · 통과 ${s.gated} · 제안 ${s.proposed}건\n`);
}
```

- [ ] **Step 4: Run tests** — `npx jest src/agent-layer/orchestrator.spec.ts src/edge/cli.gateway.spec.ts` → PASS
- [ ] **Step 5: Commit**

```bash
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator.spec.ts src/edge/cli.gateway.ts src/edge/cli.gateway.spec.ts
git commit -m "feat(agent): Orchestrator.digest seam + engram digest 수동 트리거"
```

---

### Task 9: 승인 게이트 `engram review` + op별 적용기

pending 제안을 보여주고 승인 시 WikiEngine에 op를 적용한다.

**Files:**
- Create: `src/edge/proposal-applier.ts` (op→WikiEngine 매핑)
- Test: `src/edge/proposal-applier.spec.ts`
- Modify: `src/edge/cli.gateway.ts` (`engram review` 인터랙티브 루프)
- Modify: `src/edge/edge.module.ts` (ProposalApplier provider, KnowledgeCoreModule이 WikiEngine·ProposalStore export)

**Interfaces:**
- Consumes: `WikiEngine.{getPage,createPage,updatePage}`(기존), `ProposalStore.{markApproved,markRejected}`(T4).
- Produces:
  ```ts
  @Injectable() export class ProposalApplier {
    constructor(wiki: WikiEngine, proposals: ProposalStore)
    apply(p: Proposal): Promise<void>   // op별 위키 반영 + markApproved
    reject(p: Proposal): Promise<void>  // markRejected만
  }
  ```
- 매핑: `create`→`createPage({slug,title,category,body:payload,sources,status:'published'})`; `append`→getPage 후 `updatePage(slug,{body: 기존+'\n\n'+payload, sources: 합집합})`; `supersede`→getPage 후 `updatePage(slug,{body: 기존 + supersede 마커 + payload, sources: 합집합})`. 대상 없으면(append/supersede) create로 강등 + 경고.

- [ ] **Step 1: Write the failing test**

```ts
// src/edge/proposal-applier.spec.ts
import { ProposalApplier } from './proposal-applier';

const baseProp = (op: any, targetSlug: string) => ({
  id: 'id1', userId: 'default', createdTs: 't', op, targetSlug, title: 'T', category: 'general',
  payload: '새 내용', sources: ['conv:1'], importance: 4, verdict: { confidence: 1, reason: 'r' }, status: 'pending',
});

describe('ProposalApplier', () => {
  it('create는 published 페이지를 만든다', async () => {
    const calls: any = {};
    const wiki = { getPage: async () => null, createPage: async (i: any) => { calls.create = i; return {} as any; } } as any;
    const proposals = { markApproved: jest.fn() } as any;
    await new ProposalApplier(wiki, proposals).apply(baseProp('create', 'alpha') as any);
    expect(calls.create.status).toBe('published');
    expect(calls.create.slug).toBe('alpha');
    expect(proposals.markApproved).toHaveBeenCalledWith('id1');
  });
  it('append는 기존 본문에 이어붙인다', async () => {
    const calls: any = {};
    const wiki = {
      getPage: async () => ({ slug: 'alpha', frontmatter: { sources: ['old'] }, body: '기존' }),
      updatePage: async (_s: string, p: any) => { calls.update = p; return {} as any; },
    } as any;
    await new ProposalApplier(wiki, { markApproved: jest.fn() } as any).apply(baseProp('append', 'alpha') as any);
    expect(calls.update.body).toContain('기존');
    expect(calls.update.body).toContain('새 내용');
    expect(calls.update.sources).toEqual(expect.arrayContaining(['old', 'conv:1']));
  });
  it('reject는 위키를 안 건드리고 markRejected만', async () => {
    const wiki = { createPage: jest.fn(), updatePage: jest.fn() } as any;
    const proposals = { markRejected: jest.fn() } as any;
    await new ProposalApplier(wiki, proposals).reject(baseProp('create', 'a') as any);
    expect(wiki.createPage).not.toHaveBeenCalled();
    expect(proposals.markRejected).toHaveBeenCalledWith('id1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (모듈 없음)

- [ ] **Step 3: Implement applier**

```ts
// src/edge/proposal-applier.ts
import { Injectable } from '@nestjs/common';
import { WikiEngine } from '../knowledge-core/wiki/wiki-engine';
import { ProposalStore, Proposal } from '../knowledge-core/proposal-store';

@Injectable()
export class ProposalApplier {
  constructor(private readonly wiki: WikiEngine, private readonly proposals: ProposalStore) {}

  async apply(p: Proposal): Promise<void> {
    const existing = p.op === 'create' ? null : await this.wiki.getPage(p.targetSlug, p.userId);
    if ((p.op === 'append' || p.op === 'supersede') && !existing) {
      await this.create(p); // 대상 없으면 신규로 강등
    } else if (p.op === 'create') {
      await this.create(p);
    } else {
      const merged = [...new Set([...existing!.frontmatter.sources, ...p.sources])];
      const marker = p.op === 'supersede'
        ? `\n\n<!-- superseded by 제안 ${p.id} (출처: ${p.sources.join(', ')}) -->\n${p.payload}`
        : `\n\n${p.payload}`;
      await this.wiki.updatePage(p.targetSlug, { body: existing!.body + marker, sources: merged }, p.userId);
    }
    await this.proposals.markApproved(p.id);
  }

  private async create(p: Proposal): Promise<void> {
    await this.wiki.createPage(
      { slug: p.targetSlug, title: p.title, category: p.category, body: p.payload, sources: p.sources, status: 'published' },
      p.userId,
    );
  }

  async reject(p: Proposal): Promise<void> {
    await this.proposals.markRejected(p.id);
  }
}
```

```ts
// cli.gateway.ts — run() 분기에 추가, ProposalStore·ProposalApplier 주입
} else if (argv[0] === 'review') {
  await this.review();
}
// review(): readline으로 한 건씩 a/r/s
private async review(): Promise<void> {
  const pending = await this.proposals.listPending(DEFAULT_USER);
  if (pending.length === 0) { process.stdout.write('대기 중인 제안이 없습니다.\n'); return; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));
  for (const p of pending) {
    process.stdout.write(
      `\n[${p.op}] ${p.targetSlug} (중요도 ${p.importance}, 신뢰 ${p.verdict.confidence})\n` +
      `  내용: ${p.payload}\n  출처: ${p.sources.join(', ')}\n  판정: ${p.verdict.reason}\n`,
    );
    const a = (await ask('  [a]승인 / [r]거부 / [s]건너뜀 > ')).trim().toLowerCase();
    if (a === 'a') { await this.applier.apply(p); process.stdout.write('  → 반영됨\n'); }
    else if (a === 'r') { await this.applier.reject(p); process.stdout.write('  → 거부됨\n'); }
    else process.stdout.write('  → 건너뜀\n');
  }
  rl.close();
}
```

- [ ] **Step 4: Run test to verify it passes** — `npx jest src/edge/proposal-applier.spec.ts` → PASS (3 tests)
- [ ] **Step 5: Commit**

```bash
git add src/edge/proposal-applier.ts src/edge/proposal-applier.spec.ts src/edge/cli.gateway.ts src/edge/edge.module.ts
git commit -m "feat(edge): engram review 승인 게이트 + op별 위키 적용기"
```

---

### Task 10: Scheduler(@nestjs/schedule) @Cron — main.ts 한정

상주 프로세스에서만 주기 다이제스트를 돈다. cli.ts(원샷)엔 영향 없음.

**Files:**
- Create: `src/edge/digest.scheduler.ts`
- Test: `src/edge/digest.scheduler.spec.ts`
- Modify: `src/edge/edge.module.ts` (ScheduleModule.forRoot + DigestScheduler — main 전용이므로 별도 모듈로 분리하거나 env 가드)
- Modify: `src/main.ts` (스케줄 활성), `package.json`(`@nestjs/schedule` 의존)

**Interfaces:**
- Consumes: `Orchestrator.digest`(T8).
- Produces: `DigestScheduler.tick()` = digest 1회. `@Cron(ENGRAM_DIGEST_CRON ?? '0 3 * * *')`.
- main.ts(상주)에서만 ScheduleModule 활성. cli.ts는 digest 스케줄 없음(원샷이라 불필요) — DigestScheduler를 별도 `SchedulerModule`로 두고 main의 AppModule 변형에만 import, 또는 `ENGRAM_ENABLE_SCHEDULER` env 가드. **선택: env 가드**(`tick`은 가드와 무관하게 테스트 가능, @Cron 등록만 가드).

- [ ] **Step 1: Install dep**

```bash
npm install @nestjs/schedule
```

- [ ] **Step 2: Write the failing test**

```ts
// src/edge/digest.scheduler.spec.ts
import { DigestScheduler } from './digest.scheduler';

it('tick은 orchestrator.digest를 호출한다', async () => {
  const orch = { digest: jest.fn().mockResolvedValue({ extracted: 0, gated: 0, proposed: 2 }) } as any;
  const logger = { log: jest.fn(), error: jest.fn() } as any;
  await new DigestScheduler(orch, logger).tick();
  expect(orch.digest).toHaveBeenCalled();
});
```

- [ ] **Step 3: Run test to verify it fails** — FAIL (모듈 없음)

- [ ] **Step 4: Implement**

```ts
// src/edge/digest.scheduler.ts
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Orchestrator } from '../agent-layer/orchestrator';
import { PinoLogger } from '../pal/logger';
import { DEFAULT_USER } from '../pal/path-resolver';

// 주기 자율 다이제스트(설계 §9.2 in-process @Cron, OS cron 금지).
@Injectable()
export class DigestScheduler {
  constructor(private readonly orchestrator: Orchestrator, private readonly logger: PinoLogger) {}

  @Cron(process.env.ENGRAM_DIGEST_CRON ?? '0 3 * * *') // 기본 매일 03:00
  async tick(): Promise<void> {
    try {
      const s = await this.orchestrator.digest(DEFAULT_USER);
      this.logger.log(`자율 다이제스트: 제안 ${s.proposed}건`, 'DigestScheduler'); // PinoLogger.log(message, context)
    } catch (err) {
      this.logger.error('DigestScheduler.tick 실패', String(err), 'DigestScheduler');
    }
  }
}
```

```ts
// edge.module.ts — main 전용 스케줄은 ScheduleModule.forRoot() + DigestScheduler를 조건부로.
// ScheduleModule.forRoot()를 imports에 추가하고 DigestScheduler를 providers에 추가.
// (cli.ts는 app.close()로 즉시 종료되므로 @Cron이 발화하지 않음 — 가드 불필요. tick은 단위테스트로 커버.)
```

> 참고: `cli.ts`는 `run()` 직후 `app.close()`라 크론이 발화하기 전에 종료된다. 따라서 별도 가드 없이 ScheduleModule을 EdgeModule에 둬도 원샷 CLI에 영향 없음. main.ts(상주)에서만 실제 발화.

- [ ] **Step 5: Run test + build** — `npx jest src/edge/digest.scheduler.spec.ts` → PASS; `npm run build` → 클린
- [ ] **Step 6: Commit**

```bash
git add src/edge/digest.scheduler.ts src/edge/digest.scheduler.spec.ts src/edge/edge.module.ts package.json package-lock.json
git commit -m "feat(edge): DigestScheduler @Cron 주기 자율 다이제스트(in-process)"
```

---

### Task 11: 통합 스모크(opt-in) + 최종 전체-브랜치 리뷰

**Files:**
- Create: `scripts/digest-smoke.ts` (또는 기존 demo 패턴 따라)
- Modify: `package.json` (스크립트 추가 시)

- [ ] **Step 1: 전체 테스트·빌드 그린 확인**

Run: `npx jest` → 전부 PASS (스킵 제외)
Run: `npm run build` → tsc 클린

- [ ] **Step 2: 실 claude 스모크(수동, opt-in)** — runtime 임시 디렉토리에 대화 1~2턴 적재 → `engram digest` → `runtime/state/proposals/`에 제안 생성 확인 → `engram review`로 1건 승인 → `runtime/wiki/pages/default/`에 페이지 생성 + git 커밋 + RAG 재색인(워처 로그) 확인.

```powershell
$env:ENGRAM_DATA_DIR = "$env:TEMP\engram-smoke"
node dist/src/cli.js ask "엔그램은 윈도우 네이티브 우선이다"   # 대화 적재
node dist/src/cli.js digest                                    # 제안 생성
node dist/src/cli.js review                                    # 승인
```

- [ ] **Step 3: 최종 전체-브랜치 리뷰(opus)** — superpowers:requesting-code-review로 Phase 2 전체 diff 리뷰. Critical·머지차단 Important 0 확인.

- [ ] **Step 4: 메모리·문서 갱신** — `engram-project-state.md`에 Phase 2 완료·재개 포인터, `.superpowers/sdd/progress.md`에 Phase 2 섹션.

- [ ] **Step 5: finishing-a-development-branch** — main 머지 결정.

---

## Self-Review (작성자 점검 결과)

**스펙 커버리지:** §3 흐름(T1·T2 적재 → T6·T7 파이프라인 → T8 트리거 → T9 승인) · §4.1 ConversationStore(T1) · §4.2 ImportanceGate(T3) · §4.3 ProposalStore(T4) · §4.4 IngesterAgent(T6·T7) · §4.5 brain multi-profile(T5) · §4.6 digest seam(T8) · §4.7 review+적용기(T9) · §4.8 Scheduler(T10) · §5 RAG 재색인(기존 워처, T9 적용이 파일 쓰면 자동) · §6 테스트(각 태스크) · 통합·리뷰(T11). 빠진 스펙 항목 없음.

**플레이스홀더:** 없음(모든 step에 실제 코드/명령/기대결과).

**타입 일관성:** `ScoredFact`(T3 정의→T6·T7 사용), `Proposal`/`ProposalOp`/`NewProposal`(T4→T7·T9), `JUDGE_BRAIN`(T5→T6·T7), `IngesterAgent.run` 반환형 `{extracted,gated,proposed}`(T6 스텁→T7 완성→T8 위임→T10 사용) 일치. judge 출력 `verdict ∈ create|append|supersede|reject`가 `ProposalOp|'reject'`와 정합.

**비범위 확인:** 자동반영·다중투표·주기감사(⑧)·golden-question 미포함(스펙 §8과 일치).
