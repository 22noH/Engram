# Phase 6b-2 — `@Engram` 멘션 코딩 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 메신저에서 자연어로 코딩 위임 — repo를 경로로 해소(검색)→번호선택→완성조건 컨펌→`@Engram 승인`→백그라운드 `codeRun` 자율 코딩→진행 중계·결과 보고.

**Architecture:** 6b-1의 post 콜백 + 백그라운드 detach + MentionTracker 모델 위에, classify에 `code` 종류를 더하고 스레드별 pending 2단 머신(disambiguate→approve)을 둔다. repo 해소는 새 `coderepos.ts`(alias/경로/검색). 코딩 실행은 기존 `proposeProject`/`approveProject`/`codeRun`/PermissionFence 무변경 재사용.

**Tech Stack:** Node 22 · NestJS · TypeScript · jest(ts-jest)

## Global Constraints

- 새 의존성 0.
- 코어 중립성: `src/edge/core-message.ts`·bridge·`codeRun`·`proposeProject`·`approveProject`·`PermissionFence`·`MentionTracker` 무변경.
- 보안: 경로 해소가 무엇을 내놓든 `proposeProject`/`codeRun`은 `fence.assertWritable` 경유(자기repo·시스템 거부). 확인 답장 = 사람 동의. 코드는 격리 브랜치만.
- 상주 불사: 백그라운드 코딩은 자체 try/catch(6b-1 패턴), 진행만 게시(코드 에이전트 onChunk 미게시).
- repo 못 찾음·모호·fence 거부는 막다른 길 없이 안내 post 후 정상 반환.
- `PinoLogger`는 `info()` 없음(log/warn/error).
- 결정론 테스트: 실 네트워크/claude/codeRun 금지(스텁). 백그라운드는 `drainForTest()`(private, `(o as any)`로 호출)로 관측.

---

## File Structure

- 신규 `src/agent-layer/coderepos.ts` — `CodeReposConfig` 타입, `loadCodeRepos(configDir)`, `resolveRepo(repoRef, cfg)`.
- 신규 `src/agent-layer/coderepos.spec.ts`.
- 수정 `src/agent-layer/orchestrator.ts` — classify에 `code` 종류·handleMention 코딩 분기(pending 승인/취소/번호)·`startCoding`/`startProposal`/`launchCoding`/`resolveRepoPaths`/`codeRepos`/`codingResultMessage`·`pending` Map·`PathResolver` 옵셔널 주입.
- 신규 `src/agent-layer/orchestrator-coding.spec.ts` — 코딩 분기 단위테스트.
- 수정 `prompts/triage.md` — `code` 종류 설명.
- 수정 `src/agent-layer/agent-layer.module.ts` — Orchestrator 팩토리에 `PathResolver` 주입.

---

## Task 1: coderepos 모듈 (설정 로더 + repo 해소)

**Files:**
- Create: `src/agent-layer/coderepos.ts`
- Test: `src/agent-layer/coderepos.spec.ts`

**Interfaces:**
- Produces:
  - `interface CodeReposConfig { aliases: Record<string, string>; searchRoots: string[] }`
  - `loadCodeRepos(configDir: string): CodeReposConfig`
  - `resolveRepo(repoRef: string, cfg: CodeReposConfig): string[]`

- [ ] **Step 1: Write the failing test**

`src/agent-layer/coderepos.spec.ts`:
```ts
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { loadCodeRepos, resolveRepo } from './coderepos';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cr-')); }

it('파일 없으면 빈 설정', () => {
  expect(loadCodeRepos(tmp())).toEqual({ aliases: {}, searchRoots: [] });
});

it('coderepos.json을 읽는다', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'coderepos.json'), JSON.stringify({ aliases: { api: 'C:/repos/api' }, searchRoots: ['C:/repos'] }));
  expect(loadCodeRepos(dir)).toEqual({ aliases: { api: 'C:/repos/api' }, searchRoots: ['C:/repos'] });
});

it('깨진 json이면 빈 설정', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'coderepos.json'), '{not json');
  expect(loadCodeRepos(dir)).toEqual({ aliases: {}, searchRoots: [] });
});

it('resolveRepo: 존재하는 경로형 입력 → 그 경로', () => {
  const dir = tmp(); // dir 자체가 존재하는 디렉터리
  expect(resolveRepo(dir, { aliases: {}, searchRoots: [] })).toEqual([dir]);
});

it('resolveRepo: alias 적중(대소문자 무시)', () => {
  const cfg = { aliases: { api: 'C:/repos/api' }, searchRoots: [] };
  expect(resolveRepo('API', cfg)).toEqual(['C:/repos/api']);
});

it('resolveRepo: searchRoots 얕은 검색 — 정확 일치 1개', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'myapp'));
  fs.mkdirSync(path.join(root, 'other'));
  expect(resolveRepo('myapp', { aliases: {}, searchRoots: [root] })).toEqual([path.join(root, 'myapp')]);
});

it('resolveRepo: 부분 포함 다중 매칭 → 여러 개', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'app-web'));
  fs.mkdirSync(path.join(root, 'app-api'));
  const r = resolveRepo('app', { aliases: {}, searchRoots: [root] });
  expect(r.sort()).toEqual([path.join(root, 'app-api'), path.join(root, 'app-web')].sort());
});

it('resolveRepo: 매칭 없음 → 빈 배열', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'zzz'));
  expect(resolveRepo('nope', { aliases: {}, searchRoots: [root] })).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/agent-layer/coderepos.spec.ts`
Expected: FAIL — `Cannot find module './coderepos'`.

- [ ] **Step 3: Write coderepos.ts**

`src/agent-layer/coderepos.ts`:
```ts
import * as fs from 'fs';
import * as path from 'path';

// 메신저 코딩 대상 repo 설정(Phase 6b-2). runtime/config/coderepos.json.
export interface CodeReposConfig {
  aliases: Record<string, string>; // 별칭 → 절대경로
  searchRoots: string[];           // 별칭에 없으면 여기서 이름으로 검색
}

export function loadCodeRepos(configDir: string): CodeReposConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'coderepos.json'), 'utf8')) as Partial<CodeReposConfig>;
    return {
      aliases: raw.aliases && typeof raw.aliases === 'object' ? raw.aliases : {},
      searchRoots: Array.isArray(raw.searchRoots) ? raw.searchRoots.map(String) : [],
    };
  } catch {
    return { aliases: {}, searchRoots: [] };
  }
}

// repoRef → 후보 경로들(0/1/N). ① 경로형이고 디렉터리로 존재 → 그 경로 ② alias(대소문자 무시)
// ③ searchRoots 얕은(depth ≤ 2) 하위 디렉터리 이름 매칭(정확 우선, 없으면 부분 포함).
// ponytail: 얕은 글로브, 거대 트리 스캔 금지.
export function resolveRepo(repoRef: string, cfg: CodeReposConfig): string[] {
  const ref = repoRef.trim();
  if (!ref) return [];

  // ① 경로형(슬래시/역슬래시/드라이브) + 존재하는 디렉터리
  if (/[/\\]/.test(ref) || /^[a-zA-Z]:/.test(ref)) {
    try { if (fs.statSync(ref).isDirectory()) return [ref]; } catch { /* 없음 → 다음 */ }
  }

  // ② alias(대소문자 무시)
  const aliasKey = Object.keys(cfg.aliases).find((k) => k.toLowerCase() === ref.toLowerCase());
  if (aliasKey) return [cfg.aliases[aliasKey]];

  // ③ searchRoots 얕은 검색
  const lower = ref.toLowerCase();
  const exact: string[] = [];
  const partial: string[] = [];
  for (const root of cfg.searchRoots) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const name = e.name.toLowerCase();
      if (name === lower) exact.push(path.join(root, e.name));
      else if (name.includes(lower)) partial.push(path.join(root, e.name));
    }
  }
  return exact.length ? exact : partial;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/agent-layer/coderepos.spec.ts`
Expected: PASS (8 passing).

- [ ] **Step 5: Commit**

```bash
git add src/agent-layer/coderepos.ts src/agent-layer/coderepos.spec.ts
git commit -m "feat(phase6b2): coderepos — alias/경로/얕은검색 repo 해소 + 설정 로더"
```

---

## Task 2: Orchestrator 코딩 분기 (classify code + pending + launch)

**Files:**
- Modify: `src/agent-layer/orchestrator.ts`
- Create: `src/agent-layer/orchestrator-coding.spec.ts`
- Modify: `prompts/triage.md`

**Interfaces:**
- Consumes: `loadCodeRepos`/`resolveRepo`/`CodeReposConfig`(Task 1), 기존 `proposeProject(targetPath, goal): Promise<ProjectConfig>`(반환 `{ id, acceptanceCriteria: string[], gate: { test, build, typecheck }, ... }`), `approveProject(id)`, `codeRun(id, { onProgress }): Promise<{ status: 'SUCCESS'|'STUCK'|'STOPPED'|'BUDGET'; sessionId: string }>`, `PermissionFence.assertWritable(path)`, `this.tracker`/`this.inflight`(6b-1), `PathResolver.getConfigDir()`.
- Produces: classify가 `{ kind: 'chat'|'collaborate'|'code'; team: string[]; repoRef?: string; goal?: string }` 반환. handleMention이 코딩 위임/승인/취소/번호선택 처리.

- [ ] **Step 1: Write the failing test**

`src/agent-layer/orchestrator-coding.spec.ts`:
```ts
import { Orchestrator } from './orchestrator';

const logger = { warn() {}, error() {}, log() {} } as any;

// 생성자 18인자: (reader, conversations, logger, ingester, tasks, specialist, synth, sem,
//   projects, gate, codingGit, coder, reviewer, codeBrain, fence, reporter, registry, paths)
function orc(classifyJson: string) {
  const brain = { complete: async () => ({ text: classifyJson, costUsd: 0, isError: false }) } as any;
  const registry = { all: () => [] } as any;
  const conversations = { append: async () => {} } as any;
  const projects = {} as any;                 // truthy (startProposal 가드 통과)
  const fence = { assertWritable() {} } as any; // 기본 허용
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    projects, null as any, null as any, null as any, null as any,
    brain, fence, null as any, registry, null as any,
  );
  return o;
}

it('code 1개 매칭 → proposeProject 후 완성조건·대상 게시(승인 대기)', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"버그 고쳐"}');
  (o as any).resolveRepoPaths = () => ['C:/repos/api'];
  (o as any).proposeProject = async () => ({ id: 'p1', acceptanceCriteria: ['로그인 통과'], gate: { test: true, build: false, typecheck: true } });
  const posts: string[] = [];
  await o.handleMention({ text: 'api에 버그 고쳐', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts[0]).toContain('C:/repos/api');
  expect(posts[0]).toContain('로그인 통과');
  expect(posts[0]).toContain('승인');
});

it('code 여러 매칭 → 번호 목록, 번호 답장으로 선택→제안', async () => {
  const o = orc('{"kind":"code","repo":"app","goal":"고쳐"}');
  (o as any).resolveRepoPaths = () => ['C:/a/app-web', 'C:/a/app-api'];
  const proposed: string[] = [];
  (o as any).proposeProject = async (p: string) => { proposed.push(p); return { id: 'p1', acceptanceCriteria: ['x'], gate: { test: false, build: false, typecheck: false } }; };
  const posts: string[] = [];
  await o.handleMention({ text: 'app 고쳐', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts[0]).toContain('1.');
  expect(posts[0]).toContain('2.');
  await o.handleMention({ text: '2', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(proposed).toEqual(['C:/a/app-api']);
});

it('승인 → approveProject + codeRun 호출, 성공 메시지', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  (o as any).resolveRepoPaths = () => ['C:/repos/api'];
  (o as any).proposeProject = async () => ({ id: 'p1', acceptanceCriteria: ['x'], gate: { test: true, build: false, typecheck: false } });
  let approved = ''; let ran = '';
  (o as any).approveProject = async (id: string) => { approved = id; };
  (o as any).codeRun = async (id: string) => { ran = id; return { status: 'SUCCESS', sessionId: 's1' }; };
  const posts: string[] = [];
  await o.handleMention({ text: 'api에 g', userId: 'c1' }, async (t) => { posts.push(t); });
  await o.handleMention({ text: '승인', userId: 'c1' }, async (t) => { posts.push(t); });
  await (o as any).drainForTest();
  expect(approved).toBe('p1');
  expect(ran).toBe('p1');
  expect(posts.some((p) => p.includes('✅'))).toBe(true);
});

it('취소 → 대기 폐기', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  (o as any).resolveRepoPaths = () => ['C:/repos/api'];
  (o as any).proposeProject = async () => ({ id: 'p1', acceptanceCriteria: ['x'], gate: { test: false, build: false, typecheck: false } });
  let ran = false; (o as any).approveProject = async () => { ran = true; }; (o as any).codeRun = async () => { ran = true; return { status: 'SUCCESS', sessionId: 's' }; };
  const posts: string[] = [];
  await o.handleMention({ text: 'api에 g', userId: 'c1' }, async () => {});
  await o.handleMention({ text: '취소', userId: 'c1' }, async (t) => { posts.push(t); });
  await o.handleMention({ text: '승인', userId: 'c1' }, async () => {}); // 이제 대기 없음 → 무시(chat 폴백)
  expect(posts.some((p) => p.includes('취소'))).toBe(true);
  expect(ran).toBe(false);
});

it('repo 못 찾음 → 안내', async () => {
  const o = orc('{"kind":"code","repo":"nope","goal":"g"}');
  (o as any).resolveRepoPaths = () => [];
  const posts: string[] = [];
  await o.handleMention({ text: 'nope에 g', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts[0]).toContain('못 찾');
});

it('fence 거부 → 안내(proposeProject 호출 안 함)', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  (o as any).resolveRepoPaths = () => ['C:/Windows'];
  (o as any).fence = { assertWritable() { throw new Error('denied'); } };
  let proposed = false; (o as any).proposeProject = async () => { proposed = true; return {} as any; };
  const posts: string[] = [];
  await o.handleMention({ text: 'api에 g', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(proposed).toBe(false);
  expect(posts[0]).toContain('쓸 수 없');
});

it('escape hatch "code <repo> <goal>" → startCoding', async () => {
  const o = orc('{"kind":"chat","team":[]}'); // 분류 무시돼야
  const seen: any = {};
  (o as any).startCoding = async (repoRef: string, goal: string) => { seen.repoRef = repoRef; seen.goal = goal; };
  await o.handleMention({ text: 'code api 로그인 고쳐', userId: 'c1' }, async () => {});
  expect(seen).toEqual({ repoRef: 'api', goal: '로그인 고쳐' });
});

it('codeRun STUCK → 경고 메시지', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  (o as any).resolveRepoPaths = () => ['C:/repos/api'];
  (o as any).proposeProject = async () => ({ id: 'p1', acceptanceCriteria: ['x'], gate: { test: false, build: false, typecheck: false } });
  (o as any).approveProject = async () => {};
  (o as any).codeRun = async () => ({ status: 'STUCK', sessionId: 's1' });
  const posts: string[] = [];
  await o.handleMention({ text: 'api에 g', userId: 'c1' }, async () => {});
  await o.handleMention({ text: '승인', userId: 'c1' }, async (t) => { posts.push(t); });
  await (o as any).drainForTest();
  expect(posts.some((p) => p.includes('⚠️'))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/agent-layer/orchestrator-coding.spec.ts`
Expected: FAIL — 생성자 18인자/`code` 분기/`resolveRepoPaths` 미존재로 컴파일·런타임 에러.

- [ ] **Step 3: Add imports + PathResolver param + pending/codeRepos fields**

`src/agent-layer/orchestrator.ts`:

(a) import 추가(coderepos + PathResolver). 기존 `import { DEFAULT_USER } from '../pal/path-resolver';`를 다음으로 교체:
```ts
import { DEFAULT_USER, PathResolver } from '../pal/path-resolver';
```
그리고 import 블록 끝(`PersonaRegistry` import 옆)에 추가:
```ts
import { loadCodeRepos, resolveRepo, CodeReposConfig } from './coderepos';
```

(b) 생성자 마지막에 옵셔널 인자 추가(`@Optional() private readonly registry?: PersonaRegistry,` 다음 줄):
```ts
    @Optional() private readonly paths?: PathResolver,
```

(c) 클래스 필드(기존 `tracker`/`inflight` 옆)에 추가:
```ts
  // 코딩 위임 대기(스레드별 2단: 후보 선택 → 승인). 6b-2.
  private readonly pending = new Map<string, PendingCode>();
  private codeReposCache?: CodeReposConfig;
```

(d) 파일 상단(클래스 위, TRIAGE_DEFAULT 근처)에 타입 추가:
```ts
type PendingCode =
  | { kind: 'disambiguate'; candidates: string[]; goal: string }
  | { kind: 'approve'; projectId: string; path: string };
```

- [ ] **Step 4: Extend TRIAGE_DEFAULT + prompts/triage.md for code**

`src/agent-layer/orchestrator.ts` — `TRIAGE_DEFAULT` 배열에 줄 추가(‘확실치 않으면 chat’ 앞):
```ts
  '(3) 특정 레포(코드 저장소)에 코드를 쓰거나 고치거나 구현하라는 일이면 "code" — repo에 레포 참조(이름/별칭/경로), goal에 할 일을 넣어라.',
```

`prompts/triage.md` — 파일 끝에 추가:
```markdown

- 특정 레포에 코드를 쓰거나 고치거나 구현하라는 일이면 → "code". repo에 레포 참조(이름/별칭/경로), goal에 할 일을 넣는다.
```

- [ ] **Step 5: Rewrite classify to include code + alias list**

`src/agent-layer/orchestrator.ts` — 기존 `classify` 메서드 전체를 교체:
```ts
  // 멘션 분류 + 로스터/코딩대상 추출(두뇌 1콜). 실패는 전부 chat 폴백(상주를 막지 않음).
  private async classify(text: string): Promise<{ kind: 'chat' | 'collaborate' | 'code'; team: string[]; repoRef?: string; goal?: string }> {
    if (!this.codeBrain) return { kind: 'chat', team: [] };
    const roster = (this.registry?.all() ?? []).map((p) => `- ${p.name}: ${p.role}`).join('\n');
    const aliases = Object.keys(this.codeRepos().aliases);
    const prompt = [
      loadPrompt('triage', TRIAGE_DEFAULT),
      `\n# 사용 가능한 전문가\n${roster || '(없음)'}`,
      `\n# 코딩 가능한 레포(alias)\n${aliases.join(', ') || '(없음)'}`,
      `\n# 사용자 메시지\n${text}`,
      '\n반드시 이 JSON만: {"kind":"chat"|"collaborate"|"code","team":["이름",...],"repo":"레포참조","goal":"할 일"}',
    ].join('\n');
    try {
      const r = await this.codeBrain.complete(prompt);
      if (r.isError) return { kind: 'chat', team: [] };
      const o = parseJsonBlock<{ kind?: unknown; team?: unknown; repo?: unknown; goal?: unknown }>(r.text);
      const kind = o && (o.kind === 'collaborate' || o.kind === 'code') ? o.kind : 'chat';
      const team = o && Array.isArray(o.team) ? o.team.map(String) : [];
      const repoRef = o && typeof o.repo === 'string' ? o.repo : undefined;
      const goal = o && typeof o.goal === 'string' ? o.goal : undefined;
      return { kind, team, repoRef, goal };
    } catch {
      return { kind: 'chat', team: [] };
    }
  }
```

- [ ] **Step 6: Add coding branches to handleMention**

`src/agent-layer/orchestrator.ts` — handleMention의 `상태` 블록 다음, `team ` escape hatch 앞에 삽입:
```ts
    // 코딩 위임 대기 처리(pending 있을 때만 — 없으면 통과해 일반 대화로).
    const p = this.pending.get(threadKey);
    if (p) {
      if (p.kind === 'disambiguate' && /^\d+$/.test(trimmed)) {
        const n = parseInt(trimmed, 10);
        if (n < 1 || n > p.candidates.length) { await post(`1~${p.candidates.length} 중에서 골라주세요.`); return; }
        this.pending.delete(threadKey);
        await this.startProposal(p.candidates[n - 1], p.goal, threadKey, post);
        return;
      }
      if (p.kind === 'approve' && (trimmed === '승인' || trimmed === 'approve')) {
        this.pending.delete(threadKey);
        await this.approveProject(p.projectId);
        this.launchCoding(p.projectId, p.path, threadKey, post);
        return;
      }
      if (trimmed === '취소' || trimmed === '아니오' || trimmed === 'cancel') {
        this.pending.delete(threadKey);
        await post('취소했어요.');
        return;
      }
    }
    // escape hatch: code <repoRef> <goal>
    if (trimmed.startsWith('code ')) {
      const rest = trimmed.slice('code '.length);
      const sp = rest.indexOf(' ');
      const repoRef = sp < 0 ? rest : rest.slice(0, sp);
      const goal = sp < 0 ? '' : rest.slice(sp + 1);
      await this.startCoding(repoRef, goal, threadKey, post);
      return;
    }
```

그리고 handleMention의 classify 분기에 code 처리 추가 — 기존:
```ts
    const decision = await this.classify(trimmed);
    if (decision.kind === 'collaborate') {
```
를 다음으로 교체:
```ts
    const decision = await this.classify(trimmed);
    if (decision.kind === 'code') {
      await this.startCoding(decision.repoRef ?? '', decision.goal ?? msg.text, threadKey, post);
      return;
    }
    if (decision.kind === 'collaborate') {
```

- [ ] **Step 7: Add coding helper methods**

`src/agent-layer/orchestrator.ts` — `launchCollaboration` 다음에 추가:
```ts
  private codeRepos(): CodeReposConfig {
    if (!this.codeReposCache) {
      this.codeReposCache = this.paths ? loadCodeRepos(this.paths.getConfigDir()) : { aliases: {}, searchRoots: [] };
    }
    return this.codeReposCache;
  }

  // 테스트에서 override 가능하도록 메서드로 감쌈(모듈 resolveRepo는 coderepos.spec이 커버).
  private resolveRepoPaths(repoRef: string): string[] {
    return resolveRepo(repoRef, this.codeRepos());
  }

  // 멘션 코딩 진입: repo 해소 → 0/1/N 분기.
  private async startCoding(repoRef: string, goal: string, threadKey: string, post: (t: string) => Promise<void>): Promise<void> {
    const matches = this.resolveRepoPaths(repoRef);
    if (matches.length === 0) {
      await post(`'${repoRef}' 레포를 못 찾았어요. coderepos.json의 alias나 정확한 경로로 불러주세요.`);
      return;
    }
    if (matches.length > 1) {
      this.pending.set(threadKey, { kind: 'disambiguate', candidates: matches, goal });
      await post(`여러 개 찾았어요:\n${matches.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n@Engram <번호>로 골라주세요.`);
      return;
    }
    await this.startProposal(matches[0], goal, threadKey, post);
  }

  // 완성조건 초안 → 대상·조건 게시 → 승인 대기.
  private async startProposal(targetPath: string, goal: string, threadKey: string, post: (t: string) => Promise<void>): Promise<void> {
    if (!this.fence || !this.projects) { await post('코딩 기능이 준비되지 않았어요.'); return; }
    try { this.fence.assertWritable(targetPath); }
    catch { await post('그 경로엔 쓸 수 없어요(보호 경로).'); return; }
    const cfg = await this.proposeProject(targetPath, goal);
    this.pending.set(threadKey, { kind: 'approve', projectId: cfg.id, path: targetPath });
    const crit = cfg.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
    await post(
      `📁 대상: ${targetPath}\n📋 완성조건:\n${crit}\n` +
      `게이트: test=${cfg.gate.test}|build=${cfg.gate.build}|typecheck=${cfg.gate.typecheck}\n` +
      `맞으면 @Engram 승인 / 취소는 @Engram 취소`,
    );
  }

  // codeRun을 백그라운드로 detach(6b-1 패턴). 진행만 중계, 코드 에이전트 onChunk는 미게시.
  private launchCoding(projectId: string, targetPath: string, threadKey: string, post: (t: string) => Promise<void>): void {
    const t = this.tracker.start(threadKey, { question: `코딩: ${targetPath}`, team: ['Coder'] });
    const work: Promise<void> = (async (): Promise<void> => {
      try {
        await post('자율 코딩 시작할게요. 진행은 여기 올릴게요.');
        const r = await this.codeRun(projectId, { onProgress: (m) => { void post(`· ${m}`); } });
        this.tracker.finish(threadKey, t.id, r.status === 'SUCCESS' ? 'done' : 'failed');
        await post(this.codingResultMessage(r, targetPath));
      } catch (err) {
        this.tracker.finish(threadKey, t.id, 'failed');
        this.logger.warn(`백그라운드 코딩 실패: ${String(err)}`, 'Orchestrator');
        try { await post('코딩 중 문제가 생겼어요 🙏'); } catch { /* post도 실패하면 포기 */ }
      }
    })().finally(() => {
      const idx = this.inflight.indexOf(work);
      if (idx !== -1) this.inflight.splice(idx, 1);
    });
    this.inflight.push(work);
  }

  private codingResultMessage(r: { status: string; sessionId: string }, targetPath: string): string {
    if (r.status === 'SUCCESS') return `✅ 코딩 완료: ${targetPath} (격리 브랜치에 착지 — 사람 머지 대기)`;
    const why: Record<string, string> = { STUCK: '막힘(진전 정체)', STOPPED: '정지됨', BUDGET: '예산 소진' };
    return `⚠️ 코딩 종료: ${why[r.status] ?? r.status} (세션 ${r.sessionId})`;
  }
```

- [ ] **Step 8: Run coding tests to verify they pass**

Run: `npx jest src/agent-layer/orchestrator-coding.spec.ts`
Expected: PASS (8 passing).

- [ ] **Step 9: Regression + typecheck**

Run: `npx jest src/agent-layer/orchestrator-handle-mention.spec.ts src/agent-layer/orchestrator-coding.spec.ts`
Expected: PASS (기존 11 handleMention + 8 coding = 19). classify 반환 확장이 기존 chat/collaborate 분기를 깨지 않음(union 넓힘만).
Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 10: Commit**

```bash
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator-coding.spec.ts prompts/triage.md
git commit -m "feat(phase6b2): handleMention 코딩 분기 — classify code·pending·검색/번호선택·백그라운드 codeRun"
```

---

## Task 3: DI 배선 (Orchestrator 팩토리에 PathResolver)

**Files:**
- Modify: `src/agent-layer/agent-layer.module.ts`

**Interfaces:**
- Consumes: Task 2의 새 Orchestrator 생성자(18번째 인자 `paths?: PathResolver`). `PathResolver`는 AgentLayerModule에서 이미 주입 가능(SpecialistAgent 팩토리가 사용 중).

- [ ] **Step 1: Add PathResolver to Orchestrator factory**

`src/agent-layer/agent-layer.module.ts` — Orchestrator `useFactory`:

(a) 시그니처 끝(`registry: PersonaRegistry,` 다음)에 추가:
```ts
        registry: PersonaRegistry,
        paths: PathResolver,
```
(b) `new Orchestrator(...)` 호출 끝(`..., fence, reporter, registry,` → ) 마지막 인자 추가:
```ts
          projects, gate, codingGit, coder, reviewer, codeBrain, fence, reporter, registry, paths,
```
(c) `inject` 배열 끝(`InsightReporter, PersonaRegistry,` 다음)에 추가:
```ts
        BRAIN, PermissionFence, InsightReporter, PersonaRegistry, PathResolver,
```
(`PathResolver`는 `agent-layer.module.ts`에 이미 import됨 — 확인만, 중복 추가 금지.)

- [ ] **Step 2: Full suite + typecheck + DI smoke**

Run: `npx jest --runInBand`
Expected: 전체 PASS(신규 coderepos 8 + coding 8 포함). (병렬 시 wiki-engine publishPage 타임아웃은 `--runInBand`로 회피; 의심되면 단독 16/16 확인.)
Run: `npx tsc --noEmit`
Expected: 0 errors.
Run: `npx jest src/app.module.spec.ts`
Expected: PASS — Nest DI 그래프가 Orchestrator를 PathResolver 주입과 함께 구성(생성자 18인자 정합).

- [ ] **Step 3: Commit**

```bash
git add src/agent-layer/agent-layer.module.ts
git commit -m "feat(phase6b2): Orchestrator 팩토리에 PathResolver 주입(coderepos 로드)"
```

---

## Self-Review

**Spec coverage (스펙 §4 ↔ 태스크):**
- §4.2 coderepos.json 로더 → Task 1(loadCodeRepos). §4.3 resolveRepo(경로형/alias/검색) → Task 1. §4.4 pending 2단 머신 → Task 2(PendingCode + Map). §4.5 classify code·handleMention 분기(번호/승인/취소/escape hatch) → Task 2 Step 5·6. §4.6 startCoding/startProposal → Task 2 Step 7. §4.7 launchCoding 백그라운드 → Task 2 Step 7. §4.9 보안(fence) → Task 2(startProposal assertWritable). §4.10 오류처리 → Task 2(안내 post·백그라운드 try/catch). §4.11 테스트 → Task 1·2 spec. §4.12 영향파일 + PathResolver 주입 → Task 2(field)·Task 3(DI).
- 비범위(자가스케줄·ambient·run-state) 미구현 확인. ✅

**Placeholder scan:** "TBD/적절히" 없음. 모든 코드 스텝 실제 코드. ✅

**Type consistency:** classify 반환 `{kind:'chat'|'collaborate'|'code'; team; repoRef?; goal?}` — Task 2 정의·handleMention 사용 일치. `PendingCode` union(disambiguate/approve) — set/get 일치. `proposeProject` 반환 `{id, acceptanceCriteria, gate:{test,build,typecheck}}`·`codeRun` 반환 `{status, sessionId}`·`resolveRepoPaths(): string[]`·`CodeReposConfig{aliases,searchRoots}` — Task 1·2·테스트 동일. 생성자 18인자(paths 18번째 옵셔널)·DI inject 정합 — Task 2 정의·Task 3 배선·테스트(18인자 구성) 일치. ✅

**알아둘 점:** Task 2 단독에선 DI 모듈 미갱신이라 런타임 Nest 구성은 Task 3 후 정상(테스트는 직접 생성자라 무관, tsc는 옵셔널이라 통과). 태스크 순서 1→2→3.
