# Phase 4 — 자율 코딩 협업 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 외부 프로젝트를 공유 블랙보드 경유로 협업해 자율 코딩하고, Engram이 직접 돌리는 하드 게이트로 검증해 완성조건 충족까지 반복하는 코딩 루프를 구현한다.

**Architecture:** Phase 3 위에 얹는다 — Orchestrator(유일 배정구)에 `codeRun` 루프를 추가하고, TaskStore(블랙보드 FSM)를 코딩 세션+티켓으로 확장하며, 새 컴포넌트(ProjectStore·CodingGit·VerificationGate·CodingSpecialist·ReviewerAgent·StuckDetector)를 더한다. 새 권한/위키/락 엔진은 안 만들고 PermissionFence·WikiEngine·KeyedLock을 재사용한다.

**Tech Stack:** NestJS · TypeScript · cross-spawn(claude/명령 spawn) · simple-git(타깃 repo git) · gray-matter(페르소나) · Jest. Windows 네이티브 우선.

## Global Constraints

- **언어/주석**: 기존 코드와 동일하게 한국어 주석. 자연스러운 한국어(영어 직역체 금지).
- **셸**: 개발 셸은 PowerShell. Bash 도구는 이 머신에서 rtk 훅으로 불안정.
- **테스트 격리**: 파일 IO 테스트는 `fs.mkdtemp`로 임시 디렉터리 사용, afterEach 정리.
- **결정론**: `Math.random()` 금지(TaskStore는 단조 시퀀스). 시간은 `new Date().toISOString()`.
- **두뇌**: 로직 테스트는 `FakeBrain`(기존). 실 `claude`/명령 실행은 opt-in 스모크(미설치 시 skip).
- **오염 0**: Engram의 어떤 메타도 타깃 repo에 커밋 금지. 코드는 타깃 격리 브랜치에만.
- **자기수정 차단**: 타깃이 Engram repo·denyPaths 내면 거부.
- **DI**: 새 provider는 `useFactory`로 등록(기존 KnowledgeCore/AgentLayer 패턴). FakeBrain override 관통 유지.
- **빌드 검증**: 각 태스크 끝에 `npm test` 관련 스펙 통과 + 최종 `npm run build`(tsc) 클린.

---

## File Structure

**신규 파일:**
- `src/agent-layer/parse-json-block.ts` — 기존 `ingester-agent.ts`의 `parseJsonBlock`를 공유 모듈로 추출(4 소비자 공유). ingester는 재export.
- `src/knowledge-core/project-store.ts` (+ `.spec.ts`) — 프로젝트 config CRUD.
- `src/knowledge-core/coding-git.ts` (+ `.spec.ts`) — 타깃 repo git 운전(브랜치·커밋·정리).
- `src/agent-layer/verification-gate.ts` (+ `.spec.ts`) — 게이트 명령 실행·종료코드 판정.
- `src/agent-layer/coding-specialist.ts` (+ `.spec.ts`) — 제네릭 코딩 워커.
- `src/agent-layer/reviewer-agent.ts` (+ `.spec.ts`) — 소프트 위층 리뷰어.
- `src/agent-layer/stuck-detector.ts` (+ `.spec.ts`) — 진전 멈춤 감지.
- `src/agent-layer/project-wiki.ts` (+ `.spec.ts`) — findings 위키 네임스페이스 헬퍼.
- `src/agent-layer/coding.integration.spec.ts` — FakeBrain 통합 루프.

**수정 파일:**
- `src/knowledge-core/task-store.ts` — coding kind + 티켓 + progress + 삭제.
- `src/brain/brain.port.ts` · `src/brain/claude-cli.brain.ts` · `src/brain/fake-brain.ts` — `complete(prompt, onChunk?, opts?)`.
- `src/agent-layer/permission-fence.ts` — `codingFlags()` + `assertWritable()`.
- `src/agent-layer/orchestrator.ts` — `decompose()` + `codeRun()` + run-state.
- `src/pal/path-resolver.ts` — `getProjectsDir()`.
- `src/edge/core-message.ts`(또는 신규 타입) · `src/edge/cli.gateway.ts` — `engram code/pause/resume/stop`.
- `src/agent-layer/agent-layer.module.ts` · `src/knowledge-core/knowledge-core.module.ts` · `src/edge/edge.module.ts` — DI 배선.

---

## Task 1: ProjectStore — 프로젝트 config CRUD

**Files:**
- Create: `src/knowledge-core/project-store.ts`, `src/knowledge-core/project-store.spec.ts`
- Modify: `src/pal/path-resolver.ts` (getProjectsDir 추가)

**Interfaces:**
- Consumes: `PathResolver.getConfigDir()`.
- Produces: `ProjectConfig` 인터페이스; `ProjectStore` with `create(input)`, `get(id)`, `list()`, `update(id, patch)`, `remove(id)`.

```ts
export interface GateCommands { test: string; build: string; typecheck: string; }
export interface ProjectConfig {
  id: string;
  targetPath: string;
  branch: string;
  gate: GateCommands;
  acceptanceCriteria: string[];
  writePaths: string[];
  concurrency: number;
  budget: { tokens: number | null };
  approved: boolean;            // 완성조건·게이트 사람 승인 여부(D 시작 게이트)
}
```

- [ ] **Step 1: PathResolver에 getProjectsDir 추가 + 실패 테스트**

`src/pal/path-resolver.spec.ts`에 추가:
```ts
it('getProjectsDir는 config/projects 아래를 반환한다', () => {
  const p = new PathResolver('C:/data');
  expect(p.getProjectsDir().replace(/\\/g, '/')).toBe('C:/data/config/projects');
});
```

- [ ] **Step 2: 실패 확인** — `npm test -- path-resolver` → FAIL(getProjectsDir 없음).

- [ ] **Step 3: 구현** — `src/pal/path-resolver.ts`의 getConfigDir 아래에:
```ts
  // 프로젝트별 코딩 config(Phase 4). config/projects/{id}.json.
  getProjectsDir(): string {
    return path.join(this.getConfigDir(), 'projects');
  }
```

- [ ] **Step 4: ProjectStore 실패 테스트** — `project-store.spec.ts`:
```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectStore } from './project-store';

describe('ProjectStore', () => {
  let dir: string;
  let store: ProjectStore;
  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'engram-proj-'));
    store = new ProjectStore(dir);
  });
  afterEach(async () => { await fs.promises.rm(dir, { recursive: true, force: true }); });

  const base = {
    id: 'proj_a', targetPath: 'C:/proj/a', branch: 'engram/x',
    gate: { test: 'npm test', build: 'npm run build', typecheck: 'tsc --noEmit' },
    acceptanceCriteria: ['c1'], writePaths: ['C:/proj/a'], concurrency: 1,
    budget: { tokens: null }, approved: false,
  };

  it('create→get 왕복', async () => {
    await store.create(base);
    expect(await store.get('proj_a')).toMatchObject({ id: 'proj_a', approved: false });
  });
  it('update는 부분 패치', async () => {
    await store.create(base);
    await store.update('proj_a', { approved: true });
    expect((await store.get('proj_a'))!.approved).toBe(true);
  });
  it('없는 id는 null', async () => { expect(await store.get('nope')).toBeNull(); });
  it('remove 후 없음', async () => {
    await store.create(base); await store.remove('proj_a');
    expect(await store.get('proj_a')).toBeNull();
  });
});
```

- [ ] **Step 5: 실패 확인** — `npm test -- project-store` → FAIL(모듈 없음).

- [ ] **Step 6: 구현** — `src/knowledge-core/project-store.ts`:
```ts
import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface GateCommands { test: string; build: string; typecheck: string; }
export interface ProjectConfig {
  id: string;
  targetPath: string;
  branch: string;
  gate: GateCommands;
  acceptanceCriteria: string[];
  writePaths: string[];
  concurrency: number;
  budget: { tokens: number | null };
  approved: boolean;
}

// 프로젝트별 코딩 config 저장(설계 §5.2). config/projects/{id}.json — 타깃 repo 미오염.
@Injectable()
export class ProjectStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string { return path.join(this.dir, `${id}.json`); }

  async create(cfg: ProjectConfig): Promise<ProjectConfig> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.writeFile(this.file(cfg.id), JSON.stringify(cfg, null, 2));
    return cfg;
  }

  async get(id: string): Promise<ProjectConfig | null> {
    try { return JSON.parse(await fs.promises.readFile(this.file(id), 'utf8')) as ProjectConfig; }
    catch { return null; }
  }

  async update(id: string, patch: Partial<ProjectConfig>): Promise<ProjectConfig> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`프로젝트 없음: ${id}`);
    const next = { ...cur, ...patch, id: cur.id };
    await fs.promises.writeFile(this.file(id), JSON.stringify(next, null, 2));
    return next;
  }

  async list(): Promise<ProjectConfig[]> {
    let files: string[];
    try { files = await fs.promises.readdir(this.dir); } catch { return []; }
    const out: ProjectConfig[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const c = await this.get(f.slice(0, -5));
      if (c) out.push(c);
    }
    return out;
  }

  async remove(id: string): Promise<void> {
    await fs.promises.rm(this.file(id), { force: true });
  }
}
```

- [ ] **Step 7: 통과 확인** — `npm test -- project-store path-resolver` → PASS.

- [ ] **Step 8: Commit**
```bash
git add src/knowledge-core/project-store.ts src/knowledge-core/project-store.spec.ts src/pal/path-resolver.ts src/pal/path-resolver.spec.ts
git commit -m "feat(phase4): ProjectStore — 프로젝트 코딩 config CRUD"
```

---

## Task 2: TaskStore 코딩 확장 — 세션 + 티켓 + progress

**Files:**
- Modify: `src/knowledge-core/task-store.ts`, `src/knowledge-core/task-store.spec.ts`

**Interfaces:**
- Consumes: 기존 `KeyedLock`, `TaskRecord`, `mutate()`, `create()`.
- Produces: `CodingTicket`, `TaskProgress` 타입; `TaskKind`에 `'coding'` 추가; `createCoding(input)`, `addTickets(id, tickets)`, `updateTicket(id, ticketId, patch)`, `recordProgress(id, patch)`, `remove(id)`. 진전키 `progressKey(rec)` 정적 헬퍼.

- [ ] **Step 1: 실패 테스트** — `task-store.spec.ts`에 describe 추가:
```ts
describe('TaskStore 코딩 확장', () => {
  let dir: string; let store: TaskStore;
  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'engram-task-'));
    store = new TaskStore(dir, new KeyedLock());
  });
  afterEach(async () => { await fs.promises.rm(dir, { recursive: true, force: true }); });

  it('createCoding은 coding kind + 빈 티켓 + progress', async () => {
    const r = await store.createCoding({ question: '목표', projectRef: 'proj_a', criteriaTotal: 2 });
    expect(r.kind).toBe('coding');
    expect(r.tickets).toEqual([]);
    expect(r.progress).toEqual({ landed: 0, criteriaMet: 0, criteriaTotal: 2 });
  });

  it('addTickets→updateTicket→recordProgress', async () => {
    const r = await store.createCoding({ question: 'q', projectRef: 'p', criteriaTotal: 1 });
    await store.addTickets(r.id, [{ id: 'tk1', area: 'src/a', instruction: 'do' }]);
    await store.updateTicket(r.id, 'tk1', { status: 'SUCCESS', gate: { pass: true, output: 'ok' } });
    await store.recordProgress(r.id, { landed: 1, criteriaMet: 1 });
    const fresh = await store.get(r.id);
    expect(fresh!.tickets![0]).toMatchObject({ status: 'SUCCESS', gate: { pass: true } });
    expect(fresh!.progress).toEqual({ landed: 1, criteriaMet: 1, criteriaTotal: 1 });
  });

  it('progressKey는 landed:criteriaMet', () => {
    expect(TaskStore.progressKey({ progress: { landed: 2, criteriaMet: 1, criteriaTotal: 3 } } as any)).toBe('2:1');
  });

  it('remove 후 get은 null', async () => {
    const r = await store.createCoding({ question: 'q', projectRef: 'p', criteriaTotal: 0 });
    await store.remove(r.id);
    expect(await store.get(r.id)).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인** — `npm test -- task-store` → FAIL.

- [ ] **Step 3: 타입 확장** — `task-store.ts` 상단:
```ts
export type TaskKind = 'collaboration' | 'board-decision' | 'coding';

export interface CodingTicket {
  id: string;
  area: string;
  instruction: string;
  status: TaskStatus;
  attempts: number;
  gate: { pass: boolean; output: string } | null;
}
export interface TaskProgress { landed: number; criteriaMet: number; criteriaTotal: number; }
```
`TaskRecord`에 옵셔널 필드 추가(collaboration 레코드는 생략):
```ts
  projectRef?: string;
  tickets?: CodingTicket[];
  progress?: TaskProgress;
```

- [ ] **Step 4: 메서드 구현** — `TaskStore` 클래스에:
```ts
  async createCoding(input: { question: string; projectRef: string; criteriaTotal: number }): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const id = `task_${now.replace(/[:.]/g, '-')}_${(this.seq++).toString(36)}_code`;
    const rec: TaskRecord = {
      id, kind: 'coding', status: 'PENDING', question: input.question,
      assignees: [], blackboard: {}, result: null, createdAt: now, updatedAt: now,
      projectRef: input.projectRef, tickets: [],
      progress: { landed: 0, criteriaMet: 0, criteriaTotal: input.criteriaTotal },
    };
    await this.lock.run(rec.id, () => this.write(rec));
    return rec;
  }

  addTickets(id: string, tickets: Array<{ id: string; area: string; instruction: string }>): Promise<TaskRecord> {
    return this.mutate(id, (rec) => {
      rec.tickets = rec.tickets ?? [];
      for (const t of tickets) rec.tickets.push({ ...t, status: 'PENDING', attempts: 0, gate: null });
    });
  }

  updateTicket(id: string, ticketId: string, patch: Partial<CodingTicket>): Promise<TaskRecord> {
    return this.mutate(id, (rec) => {
      const t = (rec.tickets ?? []).find((x) => x.id === ticketId);
      if (!t) throw new Error(`티켓 없음: ${ticketId}`);
      Object.assign(t, patch);
    });
  }

  recordProgress(id: string, patch: Partial<TaskProgress>): Promise<TaskRecord> {
    return this.mutate(id, (rec) => {
      rec.progress = { ...(rec.progress ?? { landed: 0, criteriaMet: 0, criteriaTotal: 0 }), ...patch };
    });
  }

  async remove(id: string): Promise<void> {
    await fs.promises.rm(this.file(id), { force: true });
  }

  // 진전 관측키(설계 §5.1 seam #4). 라운드 간 이 값이 안 바뀌면 stuck.
  static progressKey(rec: TaskRecord): string {
    const p = rec.progress ?? { landed: 0, criteriaMet: 0, criteriaTotal: 0 };
    return `${p.landed}:${p.criteriaMet}`;
  }
```

- [ ] **Step 5: 통과 확인** — `npm test -- task-store` → PASS(기존 + 신규).

- [ ] **Step 6: Commit**
```bash
git add src/knowledge-core/task-store.ts src/knowledge-core/task-store.spec.ts
git commit -m "feat(phase4): TaskStore 코딩 확장 — 세션·티켓·progress·삭제"
```

---

## Task 3: CodingGit — 타깃 repo git 운전

**Files:**
- Create: `src/knowledge-core/coding-git.ts`, `src/knowledge-core/coding-git.spec.ts`

**Interfaces:**
- Consumes: `simple-git`(기존 dep, WikiGit가 사용).
- Produces: `CodingGit` with `ensureBranch(targetPath, branch)`, `hasChanges(targetPath)`, `commitAll(targetPath, message)`, `currentBranch(targetPath)`.

- [ ] **Step 1: 실패 테스트** — `coding-git.spec.ts`(실 git, 임시 repo):
```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import { CodingGit } from './coding-git';

describe('CodingGit', () => {
  let repo: string; let cg: CodingGit;
  beforeEach(async () => {
    repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'engram-cg-'));
    const g = simpleGit(repo);
    await g.init();
    await g.addConfig('user.name', 'T'); await g.addConfig('user.email', 't@t');
    await fs.promises.writeFile(path.join(repo, 'a.txt'), 'hello');
    await g.add('.'); await g.commit('init');
    cg = new CodingGit();
  });
  afterEach(async () => { await fs.promises.rm(repo, { recursive: true, force: true }); });

  it('ensureBranch는 격리 브랜치로 전환', async () => {
    await cg.ensureBranch(repo, 'engram/x');
    expect(await cg.currentBranch(repo)).toBe('engram/x');
  });
  it('변경 없으면 hasChanges=false, 커밋 생략', async () => {
    await cg.ensureBranch(repo, 'engram/x');
    expect(await cg.hasChanges(repo)).toBe(false);
    await cg.commitAll(repo, 'noop'); // 던지지 않음
  });
  it('변경 있으면 커밋', async () => {
    await cg.ensureBranch(repo, 'engram/x');
    await fs.promises.writeFile(path.join(repo, 'b.txt'), 'new');
    expect(await cg.hasChanges(repo)).toBe(true);
    await cg.commitAll(repo, 'add b');
    const log = await simpleGit(repo).log({ maxCount: 1 });
    expect(log.latest!.message).toBe('add b');
  });
});
```

- [ ] **Step 2: 실패 확인** — `npm test -- coding-git` → FAIL.

- [ ] **Step 3: 구현** — `src/knowledge-core/coding-git.ts`:
```ts
import { Injectable } from '@nestjs/common';
import simpleGit from 'simple-git';

// 타깃 외부 repo의 git 운전(설계 §4, §7). WikiGit 패턴 재사용하되 경로는 호출자가 준다.
// 코드는 타깃 격리 브랜치에만 — 팀 main 무손상.
@Injectable()
export class CodingGit {
  // 격리 브랜치 보장: 있으면 전환, 없으면 현재 HEAD에서 생성(-B = reset/create).
  async ensureBranch(targetPath: string, branch: string): Promise<void> {
    await simpleGit(targetPath).checkout(['-B', branch]);
  }

  async currentBranch(targetPath: string): Promise<string> {
    return (await simpleGit(targetPath).revparse(['--abbrev-ref', 'HEAD'])).trim();
  }

  async hasChanges(targetPath: string): Promise<boolean> {
    const s = await simpleGit(targetPath).status();
    return !s.isClean();
  }

  // 작업트리 전체 스테이징 후 커밋. 변경 없으면 생략(빈 커밋 방지).
  async commitAll(targetPath: string, message: string): Promise<void> {
    const g = simpleGit(targetPath);
    await g.add('.');
    const s = await g.status();
    if (s.staged.length === 0) return;
    await g.commit(message);
  }
}
```

- [ ] **Step 4: 통과 확인** — `npm test -- coding-git` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/knowledge-core/coding-git.ts src/knowledge-core/coding-git.spec.ts
git commit -m "feat(phase4): CodingGit — 타깃 repo 격리 브랜치·커밋"
```

---

## Task 4: VerificationGate — 게이트 명령 실행·종료코드 판정

**Files:**
- Create: `src/agent-layer/verification-gate.ts`, `src/agent-layer/verification-gate.spec.ts`

**Interfaces:**
- Consumes: `GateCommands`(ProjectStore, Task 1), `cross-spawn`(기존 dep).
- Produces: `GateResult { pass: boolean; failed: 'test'|'build'|'typecheck'|null; output: string }`; `VerificationGate.run(targetPath, gate)`. 하드 바닥 순서 = typecheck → build → test, 첫 실패에서 멈춤.

- [ ] **Step 1: 실패 테스트** — `verification-gate.spec.ts`(실 명령, OS 무관하게 `node -e`):
```ts
import { VerificationGate } from './verification-gate';

describe('VerificationGate', () => {
  const gate = new VerificationGate();
  const ok = 'node -e "process.exit(0)"';
  const fail = 'node -e "process.exit(1)"';

  it('전부 0이면 pass', async () => {
    const r = await gate.run(process.cwd(), { typecheck: ok, build: ok, test: ok });
    expect(r).toMatchObject({ pass: true, failed: null });
  });
  it('typecheck 실패면 거기서 멈춤', async () => {
    const r = await gate.run(process.cwd(), { typecheck: fail, build: ok, test: ok });
    expect(r).toMatchObject({ pass: false, failed: 'typecheck' });
  });
  it('test만 실패', async () => {
    const r = await gate.run(process.cwd(), { typecheck: ok, build: ok, test: fail });
    expect(r).toMatchObject({ pass: false, failed: 'test' });
  });
});
```

- [ ] **Step 2: 실패 확인** — `npm test -- verification-gate` → FAIL.

- [ ] **Step 3: 구현** — `src/agent-layer/verification-gate.ts`:
```ts
import { Injectable } from '@nestjs/common';
import spawn from 'cross-spawn';
import { GateCommands } from '../knowledge-core/project-store';

export interface GateResult {
  pass: boolean;
  failed: 'typecheck' | 'build' | 'test' | null;
  output: string;
}

// 하드 바닥 게이트(설계 §8.1). Engram이 직접 실행 — 에이전트 자기보고 불신.
// 종료코드 0=통과. 순서: typecheck → build → test, 첫 빨강에서 멈춤.
@Injectable()
export class VerificationGate {
  async run(targetPath: string, gate: GateCommands): Promise<GateResult> {
    for (const stage of ['typecheck', 'build', 'test'] as const) {
      const cmd = gate[stage];
      if (!cmd || !cmd.trim()) continue; // 빈 명령은 스킵(해당 검사 없음)
      const { code, output } = await this.exec(cmd, targetPath);
      if (code !== 0) return { pass: false, failed: stage, output: `[${stage}] exit ${code}\n${output}` };
    }
    return { pass: true, failed: null, output: '' };
  }

  // ponytail: shell:true로 명령 문자열 그대로 실행 — 명령은 사람 승인된 config에서만 옴.
  private exec(cmd: string, cwd: string): Promise<{ code: number; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(cmd, [], { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('error', (e) => resolve({ code: 1, output: String(e) }));
      child.on('close', (code) => resolve({ code: code ?? 1, output: out.slice(-4000) }));
    });
  }
}
```

- [ ] **Step 4: 통과 확인** — `npm test -- verification-gate` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/agent-layer/verification-gate.ts src/agent-layer/verification-gate.spec.ts
git commit -m "feat(phase4): VerificationGate — 하드 바닥 게이트(종료코드 판정)"
```

---

## Task 5: BrainProvider.complete 옵션 확장 — cwd·extraArgs·timeoutMs

**Files:**
- Modify: `src/brain/brain.port.ts`, `src/brain/claude-cli.brain.ts`, `src/brain/claude-cli.brain.spec.ts`, `src/brain/fake-brain.ts`

**Interfaces:**
- Consumes: 기존 `BrainProvider`, `ClaudeCliBrain.spawnOnce`.
- Produces: `CompleteOpts { cwd?: string; extraArgs?: string[]; timeoutMs?: number }`; `complete(prompt, onChunk?, opts?)`. ClaudeCliBrain이 opts.cwd→spawn cwd, opts.extraArgs→args 말미, opts.timeoutMs→타임아웃 덮어쓰기.

- [ ] **Step 1: 포트 확장** — `brain.port.ts`:
```ts
export interface CompleteOpts {
  cwd?: string;          // 코딩 시 타깃 작업 디렉터리
  extraArgs?: string[];  // 도구 플래그 등 추가 인수
  timeoutMs?: number;    // 호출별 타임아웃(코딩은 길다)
}

export interface BrainProvider {
  complete(prompt: string, onChunk?: (text: string) => void, opts?: CompleteOpts): Promise<BrainResult>;
}
```

- [ ] **Step 2: 실패 테스트** — `claude-cli.brain.spec.ts`에 추가(spawn mock 검증):
```ts
it('opts.cwd·extraArgs·timeoutMs를 spawn에 반영', async () => {
  const calls: any[] = [];
  jest.doMock('cross-spawn', () => (cmd: string, args: string[], options: any) => {
    calls.push({ cmd, args, options });
    return { stdout: { on() {} }, stderr: { on() {} }, on(ev: string, cb: any) { if (ev === 'close') setImmediate(() => cb(0)); }, kill() {} } as any;
  });
  jest.resetModules();
  const { ClaudeCliBrain } = require('./claude-cli.brain');
  const brain = new ClaudeCliBrain({ provider: 'claude-cli', cli: 'claude', model: '', concurrency: 1, timeoutMs: 1000, extraArgs: [], env: {} });
  await brain.complete('p', undefined, { cwd: 'C:/proj', extraArgs: ['--allowedTools', 'Bash'], timeoutMs: 99999 });
  expect(calls[0].options.cwd).toBe('C:/proj');
  expect(calls[0].args).toContain('--allowedTools');
  expect(calls[0].args).toContain('Bash');
});
```
> 주: 기존 spec의 mock 패턴을 따른다. 위는 형태 예시 — 기존 파일의 mock 스타일에 맞춰 조정.

- [ ] **Step 3: 실패 확인** — `npm test -- claude-cli` → FAIL(cwd 미반영).

- [ ] **Step 4: 구현** — `claude-cli.brain.ts`:
```ts
import { BrainProvider, BrainResult, CompleteOpts } from './brain.port';
// ...
  complete(prompt: string, onChunk?: (text: string) => void, opts?: CompleteOpts): Promise<BrainResult> {
    return this.sem.run(() => this.spawnOnce(prompt, onChunk, opts));
  }

  private spawnOnce(prompt: string, onChunk?: (text: string) => void, opts?: CompleteOpts): Promise<BrainResult> {
    return new Promise<BrainResult>((resolve) => {
      const args = [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        ...(this.profile.model ? ['--model', this.profile.model] : []),
        ...this.profile.extraArgs,
        ...(opts?.extraArgs ?? []),
      ];
      const child = spawn(this.profile.cli, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...this.profile.env },
        cwd: opts?.cwd,
      });
      // ...(이하 기존 동일, timer만 opts.timeoutMs 우선)
      const timer = setTimeout(
        () => finish({ text, costUsd, isError: true, raw: 'timeout' }),
        opts?.timeoutMs ?? this.profile.timeoutMs,
      );
```

- [ ] **Step 5: FakeBrain 시그니처 맞춤** — `fake-brain.ts`의 `complete`도 `opts?: CompleteOpts` 받게(무시). 기존 테스트 호환.

- [ ] **Step 6: 통과 확인** — `npm test -- brain` → PASS(기존 + 신규).

- [ ] **Step 7: Commit**
```bash
git add src/brain/brain.port.ts src/brain/claude-cli.brain.ts src/brain/claude-cli.brain.spec.ts src/brain/fake-brain.ts
git commit -m "feat(phase4): BrainProvider.complete 옵션(cwd·extraArgs·timeoutMs)"
```

---

## Task 6: PermissionFence 코딩 확장 — codingFlags + assertWritable

**Files:**
- Modify: `src/agent-layer/permission-fence.ts`, `src/agent-layer/permission-fence.spec.ts`

**Interfaces:**
- Consumes: 기존 `FenceConfig`, `cfg.allow.{tools,writePaths,denyPaths}`.
- Produces: `codingFlags(persona, writePaths)` → `string[]`(--allowedTools + --add-dir); `assertWritable(targetPath)` → denyPaths 내거나 writePaths 밖이면 throw.

- [ ] **Step 1: 실패 테스트** — `permission-fence.spec.ts`에 추가:
```ts
it('assertWritable는 denyPaths 내 타깃을 거부', () => {
  const f = new PermissionFence('x');
  (f as any).cfg = { default: 'deny', allow: { tools: {}, writePaths: ['C:/proj'], denyPaths: ['C:/engram'] } };
  expect(() => f.assertWritable('C:/engram')).toThrow();
  expect(() => f.assertWritable('C:/proj')).not.toThrow();
  expect(() => f.assertWritable('C:/other')).toThrow(); // writePaths 밖
});

it('codingFlags는 allowedTools + add-dir', () => {
  const f = new PermissionFence('x');
  (f as any).cfg = { default: 'deny', allow: { tools: { Dev: ['Bash', 'Edit', 'Write'] }, writePaths: [], denyPaths: [] } };
  const persona = { name: 'Dev', brain: 'claude', tools: ['Bash', 'Edit', 'Write'] } as any;
  const flags = f.codingFlags(persona, ['C:/proj']);
  expect(flags).toEqual(['--allowedTools', 'Bash,Edit,Write', '--add-dir', 'C:/proj']);
});
```

- [ ] **Step 2: 실패 확인** — `npm test -- permission-fence` → FAIL.

- [ ] **Step 3: 구현** — `permission-fence.ts`에 추가:
```ts
  // 타깃 경로 쓰기 가능 검증(설계 §9, ③). denyPaths 내거나 writePaths 밖이면 거부.
  // 자기수정·자기파괴 차단: Engram repo는 denyPaths에 등록.
  assertWritable(targetPath: string): void {
    const t = targetPath.replace(/\\/g, '/');
    const within = (base: string) => t === base.replace(/\\/g, '/') || t.startsWith(base.replace(/\\/g, '/') + '/');
    if (this.cfg.allow.denyPaths.some(within)) throw new Error(`쓰기 금지 경로(denyPaths): ${targetPath}`);
    if (!this.cfg.allow.writePaths.some(within)) throw new Error(`허용되지 않은 경로(writePaths 밖): ${targetPath}`);
  }

  // 코딩 스페셜리스트 spawn 플래그(설계 §9). allowedTools ∩ + 타깃 쓰기 폴더.
  codingFlags(persona: Persona, writePaths: string[]): string[] {
    const tools = this.allowedTools(persona);
    const flags: string[] = [];
    if (tools.length) flags.push('--allowedTools', tools.join(','));
    for (const w of writePaths.filter((p) => !this.cfg.allow.denyPaths.includes(p))) flags.push('--add-dir', w);
    return flags;
  }
```

- [ ] **Step 4: 통과 확인** — `npm test -- permission-fence` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/agent-layer/permission-fence.ts src/agent-layer/permission-fence.spec.ts
git commit -m "feat(phase4): PermissionFence — codingFlags·assertWritable(자기수정 차단)"
```

---

## Task 7: CodingSpecialist — 제네릭 코딩 워커

**Files:**
- Create: `src/agent-layer/coding-specialist.ts`, `src/agent-layer/coding-specialist.spec.ts`

**Interfaces:**
- Consumes: `PersonaRegistry`, `PermissionFence.codingFlags`, `resolveBrain(key)`, `BrainProvider.complete(prompt, onChunk?, opts)`, `ProjectConfig`.
- Produces: `CodingSpecialist.work(personaName, ticket, project)` → `Promise<string>`(에이전트 작업 요약 텍스트). 코드 변경은 부수효과(타깃 cwd에 도구로 직접). 게이트는 호출자(Orchestrator)가 별도 실행.

- [ ] **Step 1: 실패 테스트** — `coding-specialist.spec.ts`(FakeBrain, spawn 안 함):
```ts
import { CodingSpecialist } from './coding-specialist';
import { FakeBrain } from '../brain/fake-brain';

describe('CodingSpecialist', () => {
  const registry = { get: (n: string) => n === 'Dev' ? { name: 'Dev', brain: 'claude', tools: ['Bash','Edit','Write'], prompt: 'You code.' } : undefined } as any;
  const fence = { codingFlags: () => ['--allowedTools', 'Bash,Edit,Write', '--add-dir', 'C:/proj'] } as any;
  const project = { targetPath: 'C:/proj', writePaths: ['C:/proj'] } as any;

  it('페르소나+티켓을 두뇌에 넘기고 cwd·플래그로 호출', async () => {
    const captured: any = {};
    const brain = { complete: (p: string, _c: any, opts: any) => { captured.prompt = p; captured.opts = opts; return Promise.resolve({ text: '작업함', costUsd: 0, isError: false }); } };
    const spec = new CodingSpecialist(registry, fence, () => brain as any, { warn() {}, log() {} } as any);
    const out = await spec.work('Dev', { id: 'tk1', area: 'src/a', instruction: '로그인 고쳐', status: 'PENDING', attempts: 0, gate: null }, project);
    expect(out).toBe('작업함');
    expect(captured.opts.cwd).toBe('C:/proj');
    expect(captured.opts.extraArgs).toContain('--allowedTools');
    expect(captured.prompt).toContain('로그인 고쳐');
  });

  it('알 수 없는 페르소나는 throw', async () => {
    const spec = new CodingSpecialist(registry, fence, () => new FakeBrain() as any, { warn() {}, log() {} } as any);
    await expect(spec.work('Ghost', {} as any, project)).rejects.toThrow();
  });

  it('두뇌 isError면 throw', async () => {
    const brain = { complete: () => Promise.resolve({ text: '', costUsd: 0, isError: true }) };
    const spec = new CodingSpecialist(registry, fence, () => brain as any, { warn() {}, log() {} } as any);
    await expect(spec.work('Dev', { id: 'tk1', area: 'src/a', instruction: 'x', status: 'PENDING', attempts: 0, gate: null }, project)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 실패 확인** — `npm test -- coding-specialist` → FAIL.

- [ ] **Step 3: 구현** — `src/agent-layer/coding-specialist.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { PersonaRegistry } from './persona-registry';
import { PermissionFence } from './permission-fence';
import { BrainProvider } from '../brain/brain.port';
import { PinoLogger } from '../pal/logger';
import { CodingTicket } from '../knowledge-core/task-store';
import { ProjectConfig } from '../knowledge-core/project-store';

// 제네릭 코딩 워커(설계 §3, §9). stateless. 코드 변경은 도구 부수효과(타깃 cwd).
// 게이트는 호출자가 별도로 돌린다(에이전트 자기보고 불신, §8.1).
@Injectable()
export class CodingSpecialist {
  constructor(
    private readonly registry: PersonaRegistry,
    private readonly fence: PermissionFence,
    private readonly resolveBrain: (brainKey: string) => BrainProvider,
    private readonly logger: PinoLogger,
  ) {}

  async work(personaName: string, ticket: CodingTicket, project: ProjectConfig, onChunk?: (t: string) => void): Promise<string> {
    const persona = this.registry.get(personaName);
    if (!persona) throw new Error(`알 수 없는 페르소나: ${personaName}`);
    const failNote = ticket.gate && !ticket.gate.pass ? `\n# 직전 게이트 실패(고쳐라)\n${ticket.gate.output}` : '';
    const prompt = [
      persona.prompt,
      `\n# 작업 영역\n${ticket.area}`,
      `\n# 할 일\n${ticket.instruction}`,
      failNote,
      '\n타깃 작업 디렉터리에서 코드를 직접 수정하라. 다른 에이전트와 대화하지 말고 네 조각만 끝내라.',
    ].join('\n');
    const flags = this.fence.codingFlags(persona, project.writePaths);
    const brain = this.resolveBrain(persona.brain);
    const r = await brain.complete(prompt, onChunk, { cwd: project.targetPath, extraArgs: flags });
    if (r.isError) throw new Error(`코딩 두뇌 호출 실패: ${personaName}/${ticket.id}`);
    return r.text;
  }
}
```

- [ ] **Step 4: 통과 확인** — `npm test -- coding-specialist` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/agent-layer/coding-specialist.ts src/agent-layer/coding-specialist.spec.ts
git commit -m "feat(phase4): CodingSpecialist — 도구 배선 코딩 워커(타깃 cwd)"
```

---

## Task 8: ReviewerAgent — 소프트 위층(작성자≠검증자)

**Files:**
- Create: `src/agent-layer/reviewer-agent.ts`, `src/agent-layer/reviewer-agent.spec.ts`

**Interfaces:**
- Consumes: `JUDGE_BRAIN`(BrainProvider), `ProjectConfig.acceptanceCriteria`, 착지 요약(블랙보드).
- Produces: `ReviewerAgent.review(criteria, landedSummary)` → `Promise<{ approved: boolean; extraTickets: Array<{ area: string; instruction: string }> }>`. JSON 파싱은 **기존 `parseJsonBlock`(ingester-agent.ts:20) 재사용** — 본 태스크에서 공유 모듈로 추출.

> 결정: 파싱 실패 시 **approved=false + 추가티켓 0**(소프트 층은 "통과 강제 불가"이므로, 모호하면 보류가 안전). 단 하드 게이트가 이미 초록이면 루프는 진행 — 리뷰어는 *추가 거부만*.

- [ ] **Step 0: parseJsonBlock 공유 모듈 추출**

`src/agent-layer/parse-json-block.ts` 생성 — `ingester-agent.ts`의 `parseJsonBlock<T>` 함수 본문을 그대로 옮긴다(객체·배열·코드펜스 처리, 문자열 인식 깊이 스캐너). 그 다음 `ingester-agent.ts`에서 인라인 정의를 제거하고 `export { parseJsonBlock } from './parse-json-block';`로 재export(기존 `ingester-agent.spec.ts`의 import 호환 유지). `npm test -- ingester-agent` → 기존 parseJsonBlock 테스트 PASS 확인.

- [ ] **Step 1: 실패 테스트** — `reviewer-agent.spec.ts`:
```ts
import { ReviewerAgent } from './reviewer-agent';

describe('ReviewerAgent', () => {
  const make = (text: string) => new ReviewerAgent({ complete: () => Promise.resolve({ text, costUsd: 0, isError: false }) } as any);

  it('승인 JSON 파싱', async () => {
    const r = await make('{"approved":true,"extraTickets":[]}').review(['c1'], '착지요약');
    expect(r).toEqual({ approved: true, extraTickets: [] });
  });
  it('추가 티켓 파싱', async () => {
    const r = await make('앞말 {"approved":false,"extraTickets":[{"area":"src/x","instruction":"엣지케이스"}]} 뒷말').review(['c1'], 's');
    expect(r.approved).toBe(false);
    expect(r.extraTickets[0]).toMatchObject({ area: 'src/x' });
  });
  it('파싱 실패는 approved=false + 빈 티켓', async () => {
    const r = await make('JSON 없음').review(['c1'], 's');
    expect(r).toEqual({ approved: false, extraTickets: [] });
  });
  it('두뇌 에러도 approved=false', async () => {
    const r = await new ReviewerAgent({ complete: () => Promise.resolve({ text: '', costUsd: 0, isError: true }) } as any).review(['c1'], 's');
    expect(r.approved).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인** — `npm test -- reviewer-agent` → FAIL.

- [ ] **Step 3: 구현** — `src/agent-layer/reviewer-agent.ts`:
```ts
import { Injectable, Inject } from '@nestjs/common';
import { BrainProvider, JUDGE_BRAIN } from '../brain/brain.port';
import { parseJsonBlock } from './parse-json-block';

export interface ReviewResult {
  approved: boolean;
  extraTickets: Array<{ area: string; instruction: string }>;
}

// 소프트 위층(설계 §8.2, seam #5). 작성자≠검증자 → JUDGE_BRAIN.
// 추가 거부만 가능: 빨간 게이트를 못 덮고, 모호하면 보류(approved=false).
@Injectable()
export class ReviewerAgent {
  constructor(@Inject(JUDGE_BRAIN) private readonly brain: BrainProvider) {}

  async review(criteria: string[], landedSummary: string): Promise<ReviewResult> {
    const prompt = [
      '너는 코드 리뷰어다. 아래 완성조건 대비 착지된 변경을 설계·의도 관점에서 본다.',
      '테스트가 못 잡는 누락·위험만 지적하라. 추가 작업이 필요하면 티켓으로 제안하라.',
      `\n# 완성조건\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
      `\n# 착지된 변경 요약\n${landedSummary}`,
      '\n반드시 이 JSON만 출력: {"approved": boolean, "extraTickets": [{"area": "...", "instruction": "..."}]}',
    ].join('\n');
    const r = await this.brain.complete(prompt);
    if (r.isError) return { approved: false, extraTickets: [] };
    const o = parseJsonBlock<{ approved?: unknown; extraTickets?: unknown }>(r.text);
    if (!o) return { approved: false, extraTickets: [] }; // 파싱 실패 → 보수적 보류
    return {
      approved: o.approved === true,
      extraTickets: Array.isArray(o.extraTickets)
        ? o.extraTickets.filter((t: any) => t && typeof t.area === 'string' && typeof t.instruction === 'string')
            .map((t: any) => ({ area: t.area, instruction: t.instruction }))
        : [],
    };
  }
}
```

- [ ] **Step 4: 통과 확인** — `npm test -- reviewer-agent` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/agent-layer/reviewer-agent.ts src/agent-layer/reviewer-agent.spec.ts
git commit -m "feat(phase4): ReviewerAgent — 소프트 위층(추가 거부만, JUDGE_BRAIN)"
```

---

## Task 9: StuckDetector — 진전 멈춤 감지

**Files:**
- Create: `src/agent-layer/stuck-detector.ts`, `src/agent-layer/stuck-detector.spec.ts`

**Interfaces:**
- Consumes: 진전키 문자열(`TaskStore.progressKey`).
- Produces: `StuckDetector` with `observe(progressKey)` → `boolean`(stuck 여부). K(기본 3) 연속 동일 키면 true. 진전 시 카운터 리셋.

- [ ] **Step 1: 실패 테스트** — `stuck-detector.spec.ts`:
```ts
import { StuckDetector } from './stuck-detector';

describe('StuckDetector(K=3)', () => {
  it('연속 무변화 3회면 stuck', () => {
    const d = new StuckDetector(3);
    expect(d.observe('0:0')).toBe(false); // 1회
    expect(d.observe('0:0')).toBe(false); // 2회
    expect(d.observe('0:0')).toBe(true);  // 3회 → stuck
  });
  it('진전하면 리셋', () => {
    const d = new StuckDetector(3);
    d.observe('0:0'); d.observe('0:0');
    expect(d.observe('1:0')).toBe(false); // 진전 → 리셋
    expect(d.observe('1:0')).toBe(false);
    expect(d.observe('1:0')).toBe(true);
  });
});
```

- [ ] **Step 2: 실패 확인** — `npm test -- stuck-detector` → FAIL.

- [ ] **Step 3: 구현** — `src/agent-layer/stuck-detector.ts`:
```ts
// 진전 멈춤 감지(설계 §6, 씨앗 ②). K라운드 연속 progressKey 무변화 → stuck.
// 시간/횟수 상한 아님 — 오직 "진전이 멈췄나"만 본다(정상 장기작업 보호).
export class StuckDetector {
  private last: string | null = null;
  private streak = 0;
  constructor(private readonly k: number = 3) {}

  // 관측 후 stuck 여부 반환. 같은 키 K회 연속이면 true.
  observe(progressKey: string): boolean {
    if (progressKey === this.last) this.streak++;
    else { this.last = progressKey; this.streak = 1; }
    return this.streak >= this.k;
  }
}
```

- [ ] **Step 4: 통과 확인** — `npm test -- stuck-detector` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/agent-layer/stuck-detector.ts src/agent-layer/stuck-detector.spec.ts
git commit -m "feat(phase4): StuckDetector — K라운드 진전 무변화 감지"
```

---

## Task 10: Orchestrator.decompose — 분해=설계 단계

**Files:**
- Modify: `src/agent-layer/orchestrator.ts`, `src/agent-layer/orchestrator.spec.ts`

**Interfaces:**
- Consumes: 협업 두뇌(주입된 `BRAIN` 또는 specialist 경유). 본 태스크는 Orchestrator에 `decompose` 추가하되, 두뇌는 생성자에 이미 있는 협업 경로 재사용(아래 Task 12에서 codeRun이 묶음). 여기서는 **순수 분해 로직만** 추가하고 두뇌는 인자로 받는다(테스트 용이).
- Produces: `Orchestrator.decompose(goal, brain)` → `Promise<Array<{ id: string; area: string; instruction: string }>>`. 두뇌가 안 겹치는 영역으로 분할(JSON), 파싱 실패 시 단일 티켓 폴백.

- [ ] **Step 1: 실패 테스트** — `orchestrator.spec.ts`에 describe 추가:
```ts
describe('Orchestrator.decompose', () => {
  const make = () => new Orchestrator({} as any, {} as any, { warn() {}, log() {} } as any, {} as any);
  it('JSON 티켓 분할 파싱', async () => {
    const brain = { complete: () => Promise.resolve({ text: '{"tickets":[{"area":"src/a","instruction":"i1"},{"area":"src/b","instruction":"i2"}]}', costUsd: 0, isError: false }) };
    const t = await make().decompose('목표', brain as any);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ area: 'src/a', instruction: 'i1' });
    expect(t[0].id).toBeTruthy();
  });
  it('파싱 실패는 단일 티켓 폴백', async () => {
    const brain = { complete: () => Promise.resolve({ text: 'JSON 아님', costUsd: 0, isError: false }) };
    const t = await make().decompose('목표', brain as any);
    expect(t).toHaveLength(1);
    expect(t[0].instruction).toContain('목표');
  });
});
```

- [ ] **Step 2: 실패 확인** — `npm test -- orchestrator` → FAIL.

- [ ] **Step 3: 구현** — `orchestrator.ts`에 메서드 추가(import `BrainProvider`):
```ts
  // 분해=설계(설계 §4-1). 안 겹치는 영역으로 분할 → 티켓. 직접호출 0(seam #1).
  async decompose(goal: string, brain: BrainProvider): Promise<Array<{ id: string; area: string; instruction: string }>> {
    const prompt = [
      '아래 목표를 서로 겹치지 않는(다른 파일/영역) 작업 조각으로 분할하라.',
      '각 조각은 독립적으로 코딩·검증 가능해야 한다.',
      `\n# 목표\n${goal}`,
      '\n반드시 이 JSON만: {"tickets":[{"area":"디렉터리/영역","instruction":"할 일"}]}',
    ].join('\n');
    const r = await brain.complete(prompt);
    const tickets = this.parseTickets(r.isError ? '' : r.text);
    if (tickets.length === 0) return [{ id: this.ticketId(0), area: '.', instruction: goal }];
    return tickets.map((t, i) => ({ id: this.ticketId(i), area: t.area, instruction: t.instruction }));
  }

  private ticketId(i: number): string {
    return `tk_${new Date().toISOString().replace(/[:.]/g, '-')}_${i}`;
  }

  // 기존 parseJsonBlock(Task 8에서 parse-json-block.ts로 추출) 재사용 — 새 스캐너 안 만듦.
  private parseTickets(text: string): Array<{ area: string; instruction: string }> {
    const o = parseJsonBlock<{ tickets?: unknown }>(text);
    return o && Array.isArray(o.tickets)
      ? o.tickets.filter((t: any) => t && typeof t.area === 'string' && typeof t.instruction === 'string')
          .map((t: any) => ({ area: t.area, instruction: t.instruction }))
      : [];
  }
```
> `orchestrator.ts` 상단에 `import { parseJsonBlock } from './parse-json-block';` 추가.

- [ ] **Step 4: 통과 확인** — `npm test -- orchestrator` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator.spec.ts
git commit -m "feat(phase4): Orchestrator.decompose — 분해=설계(영역 분할)"
```

---

## Task 11: ProjectWiki — findings 위키 네임스페이스

**Files:**
- Create: `src/agent-layer/project-wiki.ts`, `src/agent-layer/project-wiki.spec.ts`

**Interfaces:**
- Consumes: `WikiEngine.createPage/getPage/updatePage`(userId 네임스페이스). 프로젝트 findings는 `userId = projects/{projectId}`로 격리(기존 멀티유저 격리 재사용, §5.3).
- Produces: `ProjectWiki.record(projectId, slug, title, body)` → findings 페이지 생성/추가(published로 → RAG 검색됨). 보존(삭제 안 함).

> 주: `WikiEngine`은 userId를 `getWikiPagesDir(userId)`로 경로화하므로 `projects/{id}` 같은 슬래시 포함 userId도 하위 폴더로 동작. createPage는 'wx'(중복 실패) → 이미 있으면 updatePage로 append.

- [ ] **Step 1: 실패 테스트** — `project-wiki.spec.ts`(실 WikiEngine, 임시 dir + FakeEmbedder 불요 — published 색인은 indexer optional이라 생략 가능):
```ts
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { PathResolver } from '../pal/path-resolver';
import { WikiEngine } from '../knowledge-core/wiki/wiki-engine';
import { WikiGit } from '../knowledge-core/wiki/wiki-git';
import { KeyedLock } from '../knowledge-core/keyed-lock';
import { ProjectWiki } from './project-wiki';

describe('ProjectWiki', () => {
  let dir: string; let pw: ProjectWiki; let wiki: WikiEngine; let paths: PathResolver;
  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'engram-pw-'));
    paths = new PathResolver(dir);
    const git = new WikiGit(paths); await git.ensureRepo();
    wiki = new WikiEngine(paths, git, new KeyedLock()); // indexer 생략(optional)
    pw = new ProjectWiki(wiki);
  });
  afterEach(async () => { await fs.promises.rm(dir, { recursive: true, force: true }); });

  it('record는 projects/{id} 네임스페이스에 페이지', async () => {
    await pw.record('proj_a', 'auth-notes', '인증 노트', '토큰은 JWT');
    const page = await wiki.getPage('auth-notes', 'projects/proj_a');
    expect(page!.body).toContain('토큰은 JWT');
  });
  it('같은 slug 재호출은 append(보존)', async () => {
    await pw.record('proj_a', 'auth-notes', '인증 노트', '첫 사실');
    await pw.record('proj_a', 'auth-notes', '인증 노트', '둘째 사실');
    const page = await wiki.getPage('auth-notes', 'projects/proj_a');
    expect(page!.body).toContain('첫 사실');
    expect(page!.body).toContain('둘째 사실');
  });
});
```

- [ ] **Step 2: 실패 확인** — `npm test -- project-wiki` → FAIL.

- [ ] **Step 3: 구현** — `src/agent-layer/project-wiki.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { WikiEngine } from '../knowledge-core/wiki/wiki-engine';

// 프로젝트 findings 저장(설계 §5.3). 기존 위키 멀티유저 격리를 projects/{id} 네임스페이스로 재사용.
// 진행 중 알아낸 사실을 보존(자산) — 진행상태(TaskStore)와 달리 삭제하지 않는다.
@Injectable()
export class ProjectWiki {
  constructor(private readonly wiki: WikiEngine) {}

  private ns(projectId: string): string { return `projects/${projectId}`; }

  // findings 기록. 없으면 published 생성(RAG 검색 대상), 있으면 본문에 append(보존).
  async record(projectId: string, slug: string, title: string, body: string): Promise<void> {
    const userId = this.ns(projectId);
    const existing = await this.wiki.getPage(slug, userId);
    if (!existing) {
      await this.wiki.createPage({ slug, title, category: 'project', status: 'published', sources: [], body }, userId);
    } else {
      await this.wiki.updatePage(slug, { body: `${existing.body}\n\n${body}` }, userId);
    }
  }
}
```

- [ ] **Step 4: 통과 확인** — `npm test -- project-wiki` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/agent-layer/project-wiki.ts src/agent-layer/project-wiki.spec.ts
git commit -m "feat(phase4): ProjectWiki — findings 위키 네임스페이스(보존)"
```

---

## Task 12: Orchestrator.codeRun — 코딩 루프 + run-state

**Files:**
- Modify: `src/agent-layer/orchestrator.ts`, `src/agent-layer/orchestrator-coderun.spec.ts`(신규 spec 파일)

**Interfaces:**
- Consumes: `ProjectStore`, `TaskStore`(코딩 확장), `CodingSpecialist`, `VerificationGate`, `CodingGit`, `ReviewerAgent`, `StuckDetector`, `Semaphore`, `decompose`. 협업 두뇌는 specialist resolveBrain('claude') 경유 → Orchestrator는 분해용 브레인을 `@Optional() codeBrain?: BrainProvider`로 주입(테스트는 FakeBrain).
- Produces: `Orchestrator.codeRun(projectId, opts?)` → `Promise<{ status: 'SUCCESS'|'STUCK'|'STOPPED'|'BUDGET'; sessionId: string }>`. run-state 스위치(`runState`)로 stop·stuck·budget 통합.

> **루프 구조(설계 §4)**: createCoding → decompose → addTickets → (라운드 반복) { 각 PENDING/실패 티켓을 Semaphore로 코딩 → 게이트 → 초록=커밋+착지+progress, 빨강=티켓에 실패기록(다음 라운드 재시도) → 리뷰어가 추가티켓 → progress 관측해 stuck/budget/done 판정 }. 동시성 N=project.concurrency(공유 체크아웃, 분할로 충돌 회피, 게이트 안전망).

- [ ] **Step 1: 생성자에 협력자 주입(옵셔널)** — `orchestrator.ts` 생성자에 추가(@Optional):
```ts
    @Optional() private readonly projects?: ProjectStore,
    @Optional() private readonly gate?: VerificationGate,
    @Optional() private readonly codingGit?: CodingGit,
    @Optional() private readonly coder?: CodingSpecialist,
    @Optional() private readonly reviewer?: ReviewerAgent,
    @Optional() @Inject(BRAIN) private readonly codeBrain?: BrainProvider,
```

- [ ] **Step 2: 실패 테스트** — `orchestrator-coderun.spec.ts`(전부 Fake, 게이트는 항상 초록 → 1라운드 성공):
```ts
import { Orchestrator } from './orchestrator';
import { StuckDetector } from './stuck-detector';

function fakeBrain(text: string) { return { complete: () => Promise.resolve({ text, costUsd: 0, isError: false }) }; }

describe('Orchestrator.codeRun', () => {
  const project = { id: 'p', targetPath: 'C:/proj', branch: 'engram/x', writePaths: ['C:/proj'],
    gate: { test: 't', build: 'b', typecheck: 'tc' }, acceptanceCriteria: ['c1'], concurrency: 1, budget: { tokens: null }, approved: true };

  function build(gateResults: any[]) {
    const ticketsUpdated: any[] = [];
    const tasks = {
      createCoding: async () => ({ id: 's1', tickets: [], progress: { landed: 0, criteriaMet: 0, criteriaTotal: 1 } }),
      transition: async () => {}, addTickets: async () => {}, recordProgress: async () => {},
      updateTicket: async (_i: string, t: string, p: any) => { ticketsUpdated.push({ t, p }); },
      get: async () => ({ id: 's1', tickets: [{ id: 'tk0', area: '.', instruction: 'i', status: 'PENDING', attempts: 0, gate: null }], progress: { landed: 1, criteriaMet: 1, criteriaTotal: 1 } }),
      setResult: async () => {}, remove: async () => {},
    };
    let gi = 0;
    const gate = { run: async () => gateResults[Math.min(gi++, gateResults.length - 1)] };
    const coder = { work: async () => '코딩함' };
    const codingGit = { ensureBranch: async () => {}, commitAll: async () => {}, hasChanges: async () => true };
    const reviewer = { review: async () => ({ approved: true, extraTickets: [] }) };
    const projects = { get: async () => project };
    const sem = { run: (fn: any) => fn() };
    const o = new Orchestrator({} as any, {} as any, { warn() {}, log() {} } as any, {} as any,
      tasks as any, undefined, undefined, sem as any, projects as any, gate as any, codingGit as any, coder as any, reviewer as any, fakeBrain('{"tickets":[{"area":".","instruction":"i"}]}') as any);
    return { o, ticketsUpdated };
  }

  it('게이트 초록이면 착지하고 완성조건 충족 시 SUCCESS', async () => {
    const { o } = build([{ pass: true, failed: null, output: '' }]);
    const r = await o.codeRun('p', { maxRounds: 5 });
    expect(r.status).toBe('SUCCESS');
  });

  it('게이트 계속 빨강 + 진전 없으면 STUCK', async () => {
    // get이 progress 무변화를 주도록 별도 구성
    const tasks = {
      createCoding: async () => ({ id: 's1' }), transition: async () => {}, addTickets: async () => {},
      recordProgress: async () => {}, updateTicket: async () => {},
      get: async () => ({ id: 's1', tickets: [{ id: 'tk0', area: '.', instruction: 'i', status: 'PENDING', attempts: 1, gate: { pass: false, output: 'red' } }], progress: { landed: 0, criteriaMet: 0, criteriaTotal: 1 } }),
      setResult: async () => {}, remove: async () => {},
    };
    const o = new Orchestrator({} as any, {} as any, { warn() {}, log() {} } as any, {} as any,
      tasks as any, undefined, undefined, { run: (f: any) => f() } as any,
      { get: async () => project } as any, { run: async () => ({ pass: false, failed: 'test', output: 'red' }) } as any,
      { ensureBranch: async () => {}, commitAll: async () => {}, hasChanges: async () => true } as any,
      { work: async () => 'x' } as any, { review: async () => ({ approved: false, extraTickets: [] }) } as any,
      fakeBrain('{"tickets":[{"area":".","instruction":"i"}]}') as any);
    const r = await o.codeRun('p', { maxRounds: 10, stuckK: 3 });
    expect(r.status).toBe('STUCK');
  });
});
```

- [ ] **Step 3: 실패 확인** — `npm test -- orchestrator-coderun` → FAIL.

- [ ] **Step 4: 구현** — `orchestrator.ts`에 run-state 필드 + codeRun:
```ts
  private runState: 'running' | 'paused' | 'stopped' = 'running';
  setRunState(s: 'running' | 'paused' | 'stopped'): void { this.runState = s; }
  getRunState(): string { return this.runState; }

  // 코딩 루프(설계 §4). 유일 배정구(seam #1). run-state로 stop·stuck·budget 통합(§6).
  async codeRun(
    projectId: string,
    opts: { maxRounds?: number; stuckK?: number; onChunk?: (t: string) => void } = {},
  ): Promise<{ status: 'SUCCESS' | 'STUCK' | 'STOPPED' | 'BUDGET'; sessionId: string }> {
    if (!this.projects || !this.gate || !this.codingGit || !this.coder || !this.reviewer || !this.sem || !this.codeBrain) {
      throw new Error('코딩 협력자가 주입되지 않음(Orchestrator.codeRun)');
    }
    const project = await this.projects.get(projectId);
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`);
    if (!project.approved) throw new Error(`완성조건 미승인 — engram code 승인 먼저: ${projectId}`);

    await this.codingGit.ensureBranch(project.targetPath, project.branch);
    const session = await this.tasks!.createCoding({
      question: project.acceptanceCriteria.join(' / '), projectRef: projectId,
      criteriaTotal: project.acceptanceCriteria.length,
    });
    await this.tasks!.transition(session.id, 'RUNNING');
    const initial = await this.decompose(project.acceptanceCriteria.join('\n'), this.codeBrain);
    await this.tasks!.addTickets(session.id, initial);

    const stuck = new StuckDetector(opts.stuckK ?? 3);
    const maxRounds = opts.maxRounds ?? 100;
    let budgetSpent = 0;

    for (let round = 0; round < maxRounds; round++) {
      if (this.runState !== 'running') return this.exit(session, 'STOPPED');

      const fresh = await this.tasks!.get(session.id);
      const open = (fresh?.tickets ?? []).filter((t) => t.status !== 'SUCCESS');
      if (open.length === 0) { return this.exit(session, 'SUCCESS'); }

      // 동시 코딩(공유 체크아웃, N=concurrency). 게이트는 착지 직전 직렬(머지 일관성).
      await Promise.all(open.map((ticket) => this.sem!.run(async () => {
        if (this.runState !== 'running') return;
        try {
          await this.tasks!.updateTicket(session.id, ticket.id, { status: 'RUNNING', attempts: ticket.attempts + 1 });
          const summary = await this.coder!.work(this.pickPersona(project), ticket, project, opts.onChunk);
          budgetSpent += 1; // ponytail: 호출 수 근사. 실토큰 회계는 §14 후속.
          const result = await this.gate!.run(project.targetPath, project.gate);
          if (result.pass) {
            await this.codingGit!.commitAll(project.targetPath, `engram: ${ticket.id} ${ticket.area}`);
            await this.tasks!.updateTicket(session.id, ticket.id, { status: 'SUCCESS', gate: { pass: true, output: summary } });
            await this.tasks!.contribute(session.id, ticket.id, summary);
          } else {
            await this.tasks!.updateTicket(session.id, ticket.id, { status: 'PENDING', gate: { pass: false, output: result.output } });
          }
        } catch (err) {
          this.logger.warn(`코딩 티켓 실패(재시도 대기) ${ticket.id}: ${String(err)}`, 'Orchestrator');
          await this.tasks!.updateTicket(session.id, ticket.id, { status: 'PENDING' });
        }
      })));

      // progress 갱신 + 리뷰어 + 종료 판정
      const after = await this.tasks!.get(session.id);
      const landed = (after?.tickets ?? []).filter((t) => t.status === 'SUCCESS').length;
      await this.tasks!.recordProgress(session.id, { landed, criteriaMet: landed >= (after?.tickets?.length ?? 0) ? project.acceptanceCriteria.length : 0 });

      const allLanded = (after?.tickets ?? []).every((t) => t.status === 'SUCCESS') && (after?.tickets?.length ?? 0) > 0;
      if (allLanded) {
        const review = await this.reviewer!.review(project.acceptanceCriteria, Object.values(after?.blackboard ?? {}).join('\n'));
        if (review.approved) return this.exit(session, 'SUCCESS');
        await this.tasks!.addTickets(session.id, review.extraTickets.map((t, i) => ({ id: `tk_rev_${round}_${i}`, area: t.area, instruction: t.instruction })));
      }

      if (project.budget.tokens !== null && budgetSpent >= project.budget.tokens) { this.runState = 'paused'; return this.exit(session, 'BUDGET'); }
      const key = TaskStore.progressKey(after ?? ({} as any));
      if (stuck.observe(key)) { this.runState = 'paused'; return this.exit(session, 'STUCK'); }
    }
    return this.exit(session, 'STUCK');
  }

  private pickPersona(project: ProjectConfig): string {
    return 'Infra'; // ponytail: 코딩 페르소나 1개로 시작. 영역별 라우팅은 §14 후속.
  }

  private async exit(session: { id: string }, status: 'SUCCESS' | 'STUCK' | 'STOPPED' | 'BUDGET'): Promise<{ status: typeof status; sessionId: string }> {
    if (status === 'SUCCESS') {
      await this.tasks!.setResult(session.id, '완성조건 충족 — 사람 머지 대기');
      await this.tasks!.transition(session.id, 'SUCCESS');
      await this.tasks!.remove(session.id); // 진행상태 일회용 — 완료 시 삭제(findings는 위키에 보존)
    } else {
      this.logger.warn(`코딩 세션 ${status}: ${session.id} — 사람 알림`, 'Orchestrator');
    }
    return { status, sessionId: session.id };
  }
```
필요한 import 추가: `ProjectStore, ProjectConfig`, `VerificationGate`, `CodingGit`, `CodingSpecialist`, `ReviewerAgent`, `StuckDetector`, `TaskStore`, `BrainProvider, BRAIN`, `Inject`.

> 주: 위 progress의 criteriaMet 근사는 단순화. 정확한 완성조건↔테스트 매핑은 §14 후속. 루프 종료의 1차 진실은 "모든 티켓 SUCCESS + 리뷰어 승인".

- [ ] **Step 5: 통과 확인** — `npm test -- orchestrator-coderun orchestrator` → PASS.

- [ ] **Step 6: Commit**
```bash
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator-coderun.spec.ts
git commit -m "feat(phase4): Orchestrator.codeRun — 코딩 루프 + run-state(stop·stuck·budget)"
```

---

## Task 13: 완성조건 초안 + 승인 — engram code 시작 게이트

**Files:**
- Modify: `src/agent-layer/orchestrator.ts`, `src/agent-layer/orchestrator-coderun.spec.ts`

**Interfaces:**
- Consumes: `codeBrain`(분해와 동일), `ProjectStore.create`, `PermissionFence.assertWritable`.
- Produces: `Orchestrator.proposeProject(targetPath, goal)` → 완성조건·게이트 명령 추정 → `ProjectConfig`(approved=false) 저장 후 반환. `Orchestrator.approveProject(projectId)` → approved=true. 타깃이 denyPaths/writePaths 밖이면 거부(자기수정 차단).

- [ ] **Step 1: 실패 테스트** — `orchestrator-coderun.spec.ts`에 추가:
```ts
describe('proposeProject/approveProject', () => {
  it('완성조건 초안 추정 + approved=false 저장', async () => {
    let saved: any;
    const projects = { create: async (c: any) => { saved = c; return c; }, update: async (id: string, p: any) => ({ ...saved, ...p }), get: async () => saved };
    const fence = { assertWritable: () => {} };
    const o = new Orchestrator({} as any, {} as any, { warn() {}, log() {} } as any, {} as any,
      { } as any, undefined, undefined, { run: (f: any) => f() } as any, projects as any,
      {} as any, {} as any, {} as any, {} as any,
      fakeBrain('{"acceptanceCriteria":["로그인 토큰 발급"],"gate":{"test":"npm test","build":"npm run build","typecheck":"tsc --noEmit"}}') as any, fence as any);
    const cfg = await o.proposeProject('C:/proj', '로그인 고쳐');
    expect(cfg.approved).toBe(false);
    expect(cfg.acceptanceCriteria).toContain('로그인 토큰 발급');
    expect(cfg.gate.test).toBe('npm test');
    await o.approveProject(cfg.id);
  });
  it('denyPaths 타깃은 거부', async () => {
    const fence = { assertWritable: () => { throw new Error('금지'); } };
    const o = new Orchestrator({} as any, {} as any, { warn() {}, log() {} } as any, {} as any,
      {} as any, undefined, undefined, { run: (f: any) => f() } as any, { create: async (c:any)=>c } as any,
      {} as any, {} as any, {} as any, {} as any, fakeBrain('{}') as any, fence as any);
    await expect(o.proposeProject('C:/engram', 'x')).rejects.toThrow();
  });
});
```
> 생성자에 `@Optional() fence?: PermissionFence`를 마지막 인자로 추가(코드런 협력자 뒤).

- [ ] **Step 2: 실패 확인** — `npm test -- orchestrator-coderun` → FAIL.

- [ ] **Step 3: 구현** — `orchestrator.ts`:
```ts
  // 시작 게이트(설계 §4-0, D). 완성조건·게이트 명령 추정 → approved=false 저장(사람 승인 대기).
  async proposeProject(targetPath: string, goal: string): Promise<ProjectConfig> {
    if (!this.projects || !this.codeBrain || !this.fence) throw new Error('proposeProject 협력자 미주입');
    this.fence.assertWritable(targetPath); // denyPaths/writePaths 밖 거부(자기수정 차단 ③)
    const prompt = [
      '아래 목표에 대한 완성조건(검증 가능한 항목)과 이 프로젝트의 게이트 명령을 추정하라.',
      `\n# 목표\n${goal}\n# 타깃 경로\n${targetPath}`,
      '\n반드시 이 JSON만: {"acceptanceCriteria":["..."],"gate":{"test":"...","build":"...","typecheck":"..."}}',
    ].join('\n');
    const r = await this.codeBrain.complete(prompt);
    const draft = this.parseProposal(r.isError ? '' : r.text);
    const id = `proj_${targetPath.replace(/[^a-zA-Z0-9]/g, '_').slice(-32)}`;
    const cfg: ProjectConfig = {
      id, targetPath, branch: `engram/${id}`,
      gate: draft.gate, acceptanceCriteria: draft.acceptanceCriteria,
      writePaths: [targetPath], concurrency: 1, budget: { tokens: null }, approved: false,
    };
    await this.projects.create(cfg);
    return cfg;
  }

  async approveProject(projectId: string): Promise<void> {
    if (!this.projects) throw new Error('projects 미주입');
    await this.projects.update(projectId, { approved: true });
  }

  // 기존 parseJsonBlock 재사용(Task 8 추출). 새 스캐너 안 만듦.
  private parseProposal(text: string): { acceptanceCriteria: string[]; gate: GateCommands } {
    const o = parseJsonBlock<{ acceptanceCriteria?: unknown; gate?: any }>(text);
    if (!o) return { acceptanceCriteria: [], gate: { test: '', build: '', typecheck: '' } };
    return {
      acceptanceCriteria: Array.isArray(o.acceptanceCriteria) ? o.acceptanceCriteria.map(String) : [],
      gate: { test: String(o.gate?.test ?? ''), build: String(o.gate?.build ?? ''), typecheck: String(o.gate?.typecheck ?? '') },
    };
  }
```
import 추가: `GateCommands`(project-store), `PermissionFence`, `parseJsonBlock`(./parse-json-block, Task 10에서 이미 추가됐으면 생략).

- [ ] **Step 4: 통과 확인** — `npm test -- orchestrator-coderun` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator-coderun.spec.ts
git commit -m "feat(phase4): proposeProject/approveProject — 완성조건 초안→사람 승인 게이트"
```

---

## Task 14: CLI 명령 — engram code / pause / resume / stop

**Files:**
- Modify: `src/edge/cli.gateway.ts`, `src/edge/cli.gateway.spec.ts`

**Interfaces:**
- Consumes: `Orchestrator.proposeProject/approveProject/codeRun/setRunState`.
- Produces: `engram code <path> "goal"`(초안→stdout 출력→승인 프롬프트→codeRun), `engram pause|resume|stop`(setRunState). 인터랙티브 승인은 기존 review() readline 패턴 재사용.

- [ ] **Step 1: 실패 테스트** — `cli.gateway.spec.ts`에 추가(orchestrator mock):
```ts
it('engram pause는 orchestrator.setRunState(paused) 호출', async () => {
  const calls: string[] = [];
  const orch = { setRunState: (s: string) => calls.push(s) } as any;
  const gw = new CliGateway(orch, {} as any, {} as any);
  await gw.run(['pause']);
  expect(calls).toEqual(['paused']);
});
it('engram stop은 stopped', async () => {
  const calls: string[] = [];
  const gw = new CliGateway({ setRunState: (s: string) => calls.push(s) } as any, {} as any, {} as any);
  await gw.run(['stop']);
  expect(calls).toEqual(['stopped']);
});
```
> code 명령의 인터랙티브 승인은 통합 스모크(Task 16)로 커버 — readline은 단위테스트 어려움(기존 review 주석과 동일 사유).

- [ ] **Step 2: 실패 확인** — `npm test -- cli.gateway` → FAIL.

- [ ] **Step 3: 구현** — `cli.gateway.ts`의 `run()` 분기에 추가:
```ts
    } else if (argv[0] === 'code' && argv[1]) {
      await this.code(argv[1], argv.slice(2).join(' '));
    } else if (argv[0] === 'pause') {
      this.orchestrator.setRunState('paused'); process.stdout.write('일시정지\n');
    } else if (argv[0] === 'resume') {
      this.orchestrator.setRunState('running'); process.stdout.write('재개\n');
    } else if (argv[0] === 'stop') {
      this.orchestrator.setRunState('stopped'); process.stdout.write('정지\n');
```
그리고 메서드:
```ts
  // engram code <path> "goal": 완성조건 초안 → 사람 승인 → 코딩 루프(설계 §4-0).
  private async code(targetPath: string, goal: string): Promise<void> {
    const cfg = await this.orchestrator.proposeProject(targetPath, goal);
    process.stdout.write(`완성조건 초안:\n${cfg.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}\n`);
    process.stdout.write(`게이트: test=${cfg.gate.test} | build=${cfg.gate.build} | typecheck=${cfg.gate.typecheck}\n`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await new Promise<string>((res) => rl.question('이대로 시작? [y/N] > ', res));
    rl.close();
    if (ans.trim().toLowerCase() !== 'y') { process.stdout.write('취소\n'); return; }
    await this.orchestrator.approveProject(cfg.id);
    const r = await this.orchestrator.codeRun(cfg.id, { onChunk: (t) => process.stdout.write(t) });
    process.stdout.write(`\n코딩 종료: ${r.status} (세션 ${r.sessionId})\n`);
  }
```
사용법 문자열에 `engram code <path> "goal" | pause | resume | stop` 추가.

- [ ] **Step 4: 통과 확인** — `npm test -- cli.gateway` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/edge/cli.gateway.ts src/edge/cli.gateway.spec.ts
git commit -m "feat(phase4): engram code/pause/resume/stop CLI 명령"
```

---

## Task 15: DI 배선 — 모듈 등록

**Files:**
- Modify: `src/knowledge-core/knowledge-core.module.ts`, `src/agent-layer/agent-layer.module.ts`

**Interfaces:**
- Produces: ProjectStore·CodingGit를 KnowledgeCore에, VerificationGate·CodingSpecialist·ReviewerAgent·ProjectWiki를 AgentLayer에 등록. Orchestrator useFactory에 신규 협력자 주입. `engram` 실행 시 정상 부팅.

- [ ] **Step 1: KnowledgeCore 등록** — `knowledge-core.module.ts` providers/exports에:
```ts
    {
      provide: ProjectStore,
      useFactory: (paths: PathResolver) => new ProjectStore(paths.getProjectsDir()),
      inject: [PathResolver],
    },
    CodingGit,
```
import + exports 배열에 `ProjectStore, CodingGit` 추가.

- [ ] **Step 2: AgentLayer 등록** — `agent-layer.module.ts` providers에 `VerificationGate`, `ReviewerAgent`(JUDGE_BRAIN 주입), `ProjectWiki`(WikiEngine 주입), `CodingSpecialist`(useFactory — SpecialistAgent의 resolveBrain 패턴 복제) 추가. Orchestrator useFactory와 inject에 신규 협력자 추가:
```ts
{
  provide: CodingSpecialist,
  useFactory: (registry: PersonaRegistry, fence: PermissionFence, logger: PinoLogger, paths: PathResolver, defaultBrain: BrainProvider) => {
    const cache = new Map<string, BrainProvider>([['claude', defaultBrain]]);
    const resolveBrain = (key: string): BrainProvider => {
      if (!cache.has(key)) cache.set(key, createBrain(loadBrainProfile(paths.getConfigDir(), key)));
      return cache.get(key)!;
    };
    return new CodingSpecialist(registry, fence, resolveBrain, logger);
  },
  inject: [PersonaRegistry, PermissionFence, PinoLogger, PathResolver, BRAIN],
},
{ provide: ReviewerAgent, useFactory: (jb: BrainProvider) => new ReviewerAgent(jb), inject: [JUDGE_BRAIN] },
{ provide: ProjectWiki, useFactory: (w: WikiEngine) => new ProjectWiki(w), inject: [WikiEngine] },
VerificationGate,
```
Orchestrator useFactory: 인자·inject에 `ProjectStore, VerificationGate, CodingGit, CodingSpecialist, ReviewerAgent, BRAIN, PermissionFence` 추가, 생성자 호출에 순서대로 전달(reader, conversations, logger, ingester, tasks, specialist, synthesizer, sem, projects, gate, codingGit, coder, reviewer, codeBrain, fence).

> 주: WikiEngine을 AgentLayer가 쓰려면 KnowledgeCoreModule이 이미 export함(확인됨). ProjectStore·CodingGit export도 Step 1에서 추가.

- [ ] **Step 3: 부팅 검증 테스트** — `app.module.spec.ts`(기존)에 Orchestrator 해소 확인이 있으면 통과 유지. 없으면 추가:
```ts
it('Orchestrator가 코딩 협력자와 함께 해소된다', async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EMBEDDER).useValue(new FakeEmbedder())
    .overrideProvider(BRAIN).useValue(new FakeBrain())
    .overrideProvider(JUDGE_BRAIN).useValue(new FakeBrain())
    .compile();
  expect(moduleRef.get(Orchestrator)).toBeDefined();
});
```

- [ ] **Step 4: 통과 확인** — `npm test -- app.module` + `npm run build` → PASS, tsc 클린.

- [ ] **Step 5: Commit**
```bash
git add src/knowledge-core/knowledge-core.module.ts src/agent-layer/agent-layer.module.ts src/app.module.spec.ts
git commit -m "feat(phase4): DI 배선 — 코딩 협력자 모듈 등록"
```

---

## Task 16: 통합 루프 테스트(FakeBrain) + opt-in 실 스모크

**Files:**
- Create: `src/agent-layer/coding.integration.spec.ts`
- Modify: `package.json`(필요 시 스모크 스크립트)

**Interfaces:**
- Consumes: 전체 코딩 경로. FakeBrain으로 결정론, 게이트는 실제 `node -e` 명령(임시 git repo).
- Produces: end-to-end 회귀 — proposeProject→approve→codeRun→타깃 repo 격리 브랜치 커밋→완성조건 충족→SUCCESS→세션 삭제.

- [ ] **Step 1: 통합 테스트 작성** — `coding.integration.spec.ts`:
  - `fs.mkdtemp`로 임시 타깃 git repo 생성(init + 첫 커밋).
  - PathResolver(임시 data dir), ProjectStore, TaskStore(KeyedLock), CodingGit, VerificationGate(게이트 = `node -e "process.exit(0)"`), PersonaRegistry(임시 personas/Infra.md 1개), PermissionFence(임시 permissions.json: tools.Infra=[Bash,Edit,Write], writePaths=[타깃], denyPaths=[]), CodingSpecialist(FakeBrain), ReviewerAgent(FakeBrain → `{"approved":true,"extraTickets":[]}`), Orchestrator 직접 조립.
  - FakeBrain이 decompose에 `{"tickets":[{"area":".","instruction":"x"}]}`, proposal에 완성조건 JSON 반환하도록 설정(FakeBrain의 응답 주입 방식은 기존 fake-brain.ts 시그니처 따름).
  - 코딩 스페셜리스트의 `work`는 실제 파일을 안 만져도 OK(게이트가 항상 초록). 단 커밋이 일어나려면 `codingGit.commitAll` 전에 작업트리 변경이 있어야 하므로, 테스트용으로 FakeBrain work가 타깃에 더미 파일을 쓰도록 CodingSpecialist를 우회하거나, 통합에선 `coder.work`를 "타깃에 파일 1개 추가하는" stub으로 대체.
  - 검증: `codeRun` 반환 status='SUCCESS', 타깃 repo 격리 브랜치에 engram 커밋 존재, TaskStore 세션 파일 삭제됨.

```ts
// 핵심 단언 예시
const r = await orch.codeRun(cfg.id, { maxRounds: 5 });
expect(r.status).toBe('SUCCESS');
expect(await codingGit.currentBranch(targetRepo)).toBe(cfg.branch);
const log = await simpleGit(targetRepo).log();
expect(log.all.some((c) => c.message.startsWith('engram:'))).toBe(true);
expect(await tasks.get(r.sessionId)).toBeNull(); // 진행상태 삭제
```

- [ ] **Step 2: 실행** — `npm test -- coding.integration` → PASS.

- [ ] **Step 3: opt-in 실 스모크(문서화)** — `package.json`에 스크립트 추가(선택):
```json
"smoke:code": "node dist/src/cli.js code <샘플repo경로> \"작은 변경\""
```
실제 `claude` + 작은 외부 샘플 repo로 1티켓 코딩→게이트→착지 수동 확인(미설치 시 skip). 결과는 SDD 원장에 기록.

- [ ] **Step 4: 전체 회귀 + 빌드** — `npm test` 전체 PASS(기존 188 + 신규), `npm run build` tsc 클린.

- [ ] **Step 5: Commit**
```bash
git add src/agent-layer/coding.integration.spec.ts package.json
git commit -m "test(phase4): 코딩 루프 통합 테스트(FakeBrain) + 실 스모크 스크립트"
```

---

## Self-Review

**Spec coverage (설계 §3~§9):**
- §3 컴포넌트: ProjectStore(T1)·TaskStore확장(T2)·CodingGit(T3)·VerificationGate(T4)·CodingSpecialist(T7)·ReviewerAgent(T8)·StuckDetector(T9)·decompose(T10)·ProjectWiki(T11)·codeRun(T12). ✓
- §4 루프: T12(분해→배정→게이트→착지/수정→반복→stuck/budget/done). ✓
- §5 데이터: TaskStore(T2)·ProjectStore(T1)·findings 네임스페이스(T11). ✓
- §6 제어: run-state(T12)·StuckDetector(T9·T12)·budget(T12)·CLI(T14). ✓
- §7 병렬: 공유 체크아웃 + N=concurrency(T12 Promise.all+Semaphore). worktree/sparse는 안 지음(설계 §12 YAGNI 일치). ✓
- §8 게이트: 하드(T4)·소프트(T8)·자기기만 차단(assertWritable T6 + 완성조건 ProjectStore 불변 T1·T13). 특성화 테스트(C-2)는 §14 후속으로 명시 — **갭**: 특성화 자동생성 미구현. 아래 처리.
- §9 울타리: codingFlags·assertWritable(T6)·CodingSpecialist 배선(T7). ✓

**갭 처리:**
- **C-2 특성화 테스트 자동생성**: 설계 §8.3은 "테스트 없는 프로젝트"용. v1은 게이트 명령이 비면(빈 문자열) 해당 검사 스킵(T4)으로 *동작은 안전*(빨간불 없음=막지 않음)하되, 회귀 그물이 없다. 특성화 *자동생성*은 별도 큰 작업이라 본 플랜 범위에서 **명시 보류**(설계 §14 "C-2 자동생성에 사람 흘끗검토" 미해결과 일치). codeRun은 게이트 명령이 있으면 사용, 없으면 리뷰어+사람 머지로 안전. → 플랜 범위 외 기록, 별도 후속 플랜.
- **completion criteria↔테스트 매핑**: T12의 criteriaMet은 근사. 정확 매핑은 설계 §14 후속. 루프 종료의 1차 진실은 "전 티켓 SUCCESS + 리뷰어 승인"으로 충족.

**Placeholder scan:** 각 태스크에 실제 코드·실제 테스트·실제 명령 포함. "적절히 처리" 류 없음. ✓

**Type consistency:** `complete(prompt, onChunk?, opts?)`(T5)를 CodingSpecialist(T7)·ReviewerAgent(T8)·decompose(T10)·proposeProject(T13)가 일관 사용. `GateResult`(T4)를 codeRun(T12)이 `.pass`로 소비. `CodingTicket`(T2)을 T7·T12가 동일 필드로 사용. `ProjectConfig`(T1)를 T7·T12·T13이 동일 사용. `TaskStore.progressKey`(T2)를 StuckDetector 호출부(T12)가 사용. ✓

---

## Execution Handoff

(브레인스토밍→플랜 완료. 실행 방식은 사용자 선택.)
