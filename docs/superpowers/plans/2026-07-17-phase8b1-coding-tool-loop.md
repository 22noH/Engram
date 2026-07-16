# Phase 8b-1 — 엔그램 하네스 코딩 도구루프 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 엔그램 자체 하네스 두뇌(`anthropic-api`·`openai-api`)가 `opts.cwd`를 받으면 거부하는 대신 **파일 도구루프**(Read/Write/Edit/Glob/Grep)를 직접 돌아 코딩하게 한다.

**Architecture:** 8a 웹도구 루프와 동일 구조. 새 `coding-tools.ts`(src/brain)가 파일 I/O를 담당하고, 쓰기 허용 판정은 agent-layer가 `opts.codeGuard` 함수로 주입한다(`fence.assertCodingWrite` 바인딩). src/brain은 `PermissionFence`를 import하지 않는다. 채팅이면 웹도구, 코딩(`opts.cwd`)이면 파일도구로 갈래만 나뉜다.

**Tech Stack:** TypeScript/NestJS, Jest(HTTP·파일·두뇌 전부 주입/임시폴더 — 실 네트워크·실 두뇌 금지), 8a 산출물(`tool-loop.ts`·`sse.ts`·`web-tools.ts`의 `WebToolDef`).

## Global Constraints

- **never-throw**: 코딩 도구 실행(`executeCodingTool`)은 어떤 입력에도 예외를 던지지 않고 에러 텍스트를 반환한다.
- **자기수정 차단**: 엔그램 자기 저장소·시스템 폴더·denyPaths에는 절대 쓰지 못한다(`assertWritable` 백스톱 재사용).
- **읽기 유출 차단**: Read/Glob/Grep은 `cwd`(작업 대상 폴더) 밖을 못 읽는다.
- **가드 없으면 코딩 없음**: `opts.cwd`는 있는데 `opts.codeGuard`가 없으면 즉시 `isError`(무방비 쓰기 원천 차단).
- **셸 없음**: 명령 실행 도구를 주지 않는다.
- **회귀 0**: 채팅 경로·CLI 두뇌·기본 provider 값은 무변경. `opts.cwd`가 없으면 요청 body의 tools는 기존과 동일(`web_search`,`web_fetch`[,`ask_brain`]).
- **타임아웃 관통**: 하나의 `AbortController`가 모델 호출과 도구 실행까지 커버.
- 테스트: `npx jest <경로>`를 **PowerShell로 foreground 실행**(이 머신은 Bash 도구 깨짐, jest 백그라운드/워치 hang). jest 진행이 PowerShell에서 빨간 `NativeCommandError/RemoteException`로 감싸질 수 있음 — "Tests: N passed"로 판단. 실 네트워크 금지.
- 커밋 메시지 한국어, Co-Authored-By(공동작업자) 줄 넣지 말 것.

---

### Task 1: coding-tools.ts (파일 도구 5종 + 실행기) + CompleteOpts.codeGuard

**Files:**
- Modify: `src/brain/brain.port.ts` (CompleteOpts에 codeGuard 추가)
- Create: `src/brain/coding-tools.ts`
- Test: `src/brain/coding-tools.spec.ts`

**Interfaces:**
- Consumes: `WebToolDef`(`src/brain/web-tools.ts`, `{ name: string; description: string; parameters: Record<string, unknown> }`).
- Produces(Task 3·4·5가 소비):
  - `brain.port.ts`: `CompleteOpts.codeGuard?: (absPath: string) => void`.
  - `coding-tools.ts`: `MAX_CODING_ITERATIONS`(number, 30) · `type WriteGuard = (absPath: string) => void` · `CODING_TOOL_DEFS: WebToolDef[]` · `executeCodingTool(name: string, input: unknown, cwd: string, guard: WriteGuard, signal: AbortSignal): Promise<string>`(never-throw).

- [ ] **Step 1: 포트 필드 추가**

`src/brain/brain.port.ts`의 `CompleteOpts`에 `codeGuard` 필드를 더한다(기존 필드/주석 유지):

```ts
export interface CompleteOpts {
  cwd?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  delegate?: DelegateHandle;
  codeGuard?: (absPath: string) => void; // Phase 8b-1: 코딩 쓰기 허용 판정(주입). 있으면 API 두뇌가 코딩 루프.
}
```

- [ ] **Step 2: 실패 테스트 작성**

`src/brain/coding-tools.spec.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CODING_TOOL_DEFS, executeCodingTool, MAX_CODING_ITERATIONS, WriteGuard } from './coding-tools';

const NO_ABORT = { aborted: false } as AbortSignal;
const allow: WriteGuard = () => {}; // 항상 허용
const run = (name: string, input: unknown, cwd: string, guard: WriteGuard = allow) =>
  executeCodingTool(name, input, cwd, guard, NO_ABORT);

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ctools-'));
}

describe('CODING_TOOL_DEFS', () => {
  it('5종(Read/Write/Edit/Glob/Grep)을 노출', () => {
    expect(CODING_TOOL_DEFS.map((d) => d.name)).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
    expect(MAX_CODING_ITERATIONS).toBeGreaterThan(8);
  });
});

describe('executeCodingTool (never-throw)', () => {
  it('Write는 파일을 만들고 부모 폴더도 생성', async () => {
    const dir = tmp();
    try {
      const out = await run('Write', { path: 'sub/a.txt', content: 'hello' }, dir);
      expect(out).toContain('wrote');
      expect(fs.readFileSync(path.join(dir, 'sub/a.txt'), 'utf8')).toBe('hello');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('Read는 내용을 반환, cwd 밖이면 에러 텍스트', async () => {
    const dir = tmp();
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'body');
      expect(await run('Read', { path: 'a.txt' }, dir)).toBe('body');
      expect(await run('Read', { path: '../../etc/hosts' }, dir)).toContain('outside working directory');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('Edit는 정확 1곳만 치환, 없으면/여러곳이면 에러 텍스트', async () => {
    const dir = tmp();
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'x foo y foo z');
      expect(await run('Edit', { path: 'a.txt', old_string: 'nope', new_string: 'q' }, dir)).toContain('not found');
      expect(await run('Edit', { path: 'a.txt', old_string: 'foo', new_string: 'q' }, dir)).toContain('not unique');
      expect(await run('Edit', { path: 'a.txt', old_string: 'x foo y', new_string: 'X' }, dir)).toContain('edited');
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('X foo z');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('가드가 막으면 Write/Edit는 파일을 안 건드리고 에러 텍스트(never-throw)', async () => {
    const dir = tmp();
    const deny: WriteGuard = (p) => { throw new Error(`denied ${p}`); };
    try {
      const out = await run('Write', { path: 'a.txt', content: 'x' }, dir, deny);
      expect(out).toContain('blocked');
      expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('Glob는 cwd 하위 매치, Grep는 매치 라인(파일:줄) 반환', async () => {
    const dir = tmp();
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src/a.ts'), 'const x = 1;\nconst y = 2;');
      fs.writeFileSync(path.join(dir, 'src/b.js'), 'ignore');
      expect(await run('Glob', { pattern: 'src/**/*.ts' }, dir)).toContain('src/a.ts');
      expect(await run('Glob', { pattern: 'src/**/*.ts' }, dir)).not.toContain('b.js');
      const g = await run('Grep', { pattern: 'const y' }, dir);
      expect(g).toContain('src/a.ts:2:');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('오염 인자·미지 도구는 에러 텍스트(throw 아님)', async () => {
    const dir = tmp();
    try {
      expect(await run('Write', { path: 1 }, dir)).toContain('required');
      expect(await run('Nope', {}, dir)).toContain('unknown tool');
      expect(await run('Read', null, dir)).toContain('required');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx jest src/brain/coding-tools.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 4: 구현**

`src/brain/coding-tools.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { WebToolDef } from './web-tools';

// 코딩 도구루프(스펙 §4). web-tools와 같은 꼴 — provider 중립 스키마 + never-throw 실행기.
// 파일 I/O 기계만 담당하고, 쓰기 허용 판정은 주입받은 guard(=fence.assertCodingWrite)가 한다.
export const MAX_CODING_ITERATIONS = 30; // 코딩은 여러 파일을 고치므로 채팅(8)보다 높게

// 쓰기 허용 판정(막히면 throw). agent-layer가 fence.assertCodingWrite를 바인딩해 주입.
export type WriteGuard = (absPath: string) => void;

const READ_CHAR_LIMIT = 50_000;
const GLOB_LIMIT = 200;
const GREP_LIMIT = 100;
const LINE_CLIP = 200;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'coverage']);

export const CODING_TOOL_DEFS: WebToolDef[] = [
  { name: 'Read', description: 'Read a text file in the working directory. Returns its content (truncated if large).',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path (relative to the working directory)' } }, required: ['path'] } },
  { name: 'Write', description: 'Create or overwrite a file with the given content. Only allowed within writable paths.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'Edit', description: 'Replace an exact, unique occurrence of old_string with new_string in a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } },
  { name: 'Glob', description: 'List files under the working directory matching a glob pattern (e.g. src/**/*.ts).',
    parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'Grep', description: 'Search file contents under the working directory for a regex; returns matching lines.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Optional subdirectory to limit the search' } }, required: ['pattern'] } },
];

// 도구 실행 — never-throw. 실패는 에러 텍스트로 되먹임.
export async function executeCodingTool(name: string, input: unknown, cwd: string, guard: WriteGuard, signal: AbortSignal): Promise<string> {
  try {
    if (signal.aborted) return 'aborted';
    const arg = (input ?? {}) as Record<string, unknown>;
    switch (name) {
      case 'Read': return readFile(cwd, arg);
      case 'Write': return writeFile(cwd, arg, guard);
      case 'Edit': return editFile(cwd, arg, guard);
      case 'Glob': return glob(cwd, arg, signal);
      case 'Grep': return grep(cwd, arg, signal);
      default: return `coding tool error: unknown tool "${name}"`;
    }
  } catch (e) {
    return `coding tool error: ${String(e)}`;
  }
}

// cwd 안으로 정규화. 밖이면 null.
function resolveWithin(cwd: string, p: string): string | null {
  const abs = path.resolve(cwd, p);
  const a = norm(abs), b = norm(cwd);
  return a === b || a.startsWith(b + '/') ? abs : null;
}
function norm(p: string): string {
  return path.normalize(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function readFile(cwd: string, arg: Record<string, unknown>): string {
  if (typeof arg.path !== 'string') return 'Read error: path(string) required';
  const abs = resolveWithin(cwd, arg.path);
  if (!abs) return `Read error: path outside working directory: ${arg.path}`;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return `Read error: not a file: ${arg.path}`;
  const text = fs.readFileSync(abs, 'utf8');
  return text.length > READ_CHAR_LIMIT ? text.slice(0, READ_CHAR_LIMIT) + '\n… (truncated)' : text;
}

function writeFile(cwd: string, arg: Record<string, unknown>, guard: WriteGuard): string {
  if (typeof arg.path !== 'string' || typeof arg.content !== 'string') return 'Write error: path(string) and content(string) required';
  const abs = path.resolve(cwd, arg.path);
  try { guard(abs); } catch (e) { return `Write blocked: ${String(e)}`; }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, arg.content, 'utf8');
  return `wrote ${arg.path} (${arg.content.length} chars)`;
}

function editFile(cwd: string, arg: Record<string, unknown>, guard: WriteGuard): string {
  if (typeof arg.path !== 'string' || typeof arg.old_string !== 'string' || typeof arg.new_string !== 'string')
    return 'Edit error: path, old_string, new_string (all strings) required';
  const abs = path.resolve(cwd, arg.path);
  try { guard(abs); } catch (e) { return `Edit blocked: ${String(e)}`; } // 가드 먼저 — 못 쓰는 파일은 읽지도 않음
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return `Edit error: not a file: ${arg.path}`;
  const text = fs.readFileSync(abs, 'utf8');
  const parts = text.split(arg.old_string);
  if (parts.length === 1) return `Edit error: old_string not found in ${arg.path}`;
  if (parts.length > 2) return `Edit error: old_string not unique in ${arg.path} (${parts.length - 1} matches) — add more surrounding context`;
  fs.writeFileSync(abs, parts.join(arg.new_string), 'utf8');
  return `edited ${arg.path}`;
}

function glob(cwd: string, arg: Record<string, unknown>, signal: AbortSignal): string {
  if (typeof arg.pattern !== 'string') return 'Glob error: pattern(string) required';
  const re = globToRegExp(arg.pattern);
  const out: string[] = [];
  walk(cwd, cwd, signal, (rel) => { if (out.length < GLOB_LIMIT && re.test(rel)) out.push(rel); });
  return out.length ? out.join('\n') : '(no matches)';
}

function grep(cwd: string, arg: Record<string, unknown>, signal: AbortSignal): string {
  if (typeof arg.pattern !== 'string') return 'Grep error: pattern(string) required';
  let re: RegExp;
  try { re = new RegExp(arg.pattern); } catch { return 'Grep error: invalid regex'; }
  const base = typeof arg.path === 'string' ? resolveWithin(cwd, arg.path) : cwd;
  if (!base) return 'Grep error: path outside working directory';
  const out: string[] = [];
  walk(base, cwd, signal, (rel, abs) => {
    if (out.length >= GREP_LIMIT) return;
    let content: string;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { return; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && out.length < GREP_LIMIT; i++) {
      if (re.test(lines[i])) out.push(`${rel}:${i + 1}:${lines[i].slice(0, LINE_CLIP)}`);
    }
  });
  return out.length ? out.join('\n') : '(no matches)';
}

// cwd 하위 재귀 walk(상대 posix 경로). node_modules/.git 등은 건너뜀. signal 관통.
function walk(dir: string, cwd: string, signal: AbortSignal, onFile: (rel: string, abs: string) => void): void {
  if (signal.aborted) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (signal.aborted) return;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs, cwd, signal, onFile); }
    else if (e.isFile()) onFile(path.relative(cwd, abs).replace(/\\/g, '/'), abs);
  }
}

// 최소 glob → RegExp. **/ = 0개 이상 폴더, ** = 아무거나, * = 슬래시 제외, ? = 한 글자.
// ponytail: 완전한 glob 아님(중괄호 확장 등 미지원) — 필요해지면 라이브러리로.
function globToRegExp(pattern: string): RegExp {
  const esc = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) { re += '(?:.*/)?'; i += 3; }
    else if (pattern.startsWith('**', i)) { re += '.*'; i += 2; }
    else if (pattern[i] === '*') { re += '[^/]*'; i++; }
    else if (pattern[i] === '?') { re += '[^/]'; i++; }
    else { re += esc(pattern[i]); i++; }
  }
  return new RegExp('^' + re + '$');
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx jest src/brain/coding-tools.spec.ts`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add src/brain/brain.port.ts src/brain/coding-tools.ts src/brain/coding-tools.spec.ts
git commit -m "feat(phase8b1): coding-tools 파일 도구 5종·never-throw 실행기 + CompleteOpts.codeGuard 포트"
```

---

### Task 2: PermissionFence.assertCodingWrite

**Files:**
- Modify: `src/agent-layer/permission-fence.ts`
- Test: `src/agent-layer/permission-fence.spec.ts`

**Interfaces:**
- Consumes: 기존 `assertWritable`·`isWithin`(private static).
- Produces(Task 5가 소비): `PermissionFence.assertCodingWrite(targetPath: string, projectWritePaths: string[]): void`(막히면 throw).

- [ ] **Step 1: 실패 테스트 추가**

`src/agent-layer/permission-fence.spec.ts` 끝에 append(상단 `tmpFence`·fs/os/path 재사용):

```ts
describe('assertCodingWrite (API 코딩 쓰기 판정)', () => {
  it('엔그램 자기 저장소는 백스톱으로 거부', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-root-'));
    try {
      const fence = new PermissionFence(tmpFence(null), root);
      await fence.load();
      expect(() => fence.assertCodingWrite(path.join(root, 'src/x.ts'), [])).toThrow();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('projectWritePaths 지정 시 그 안이면 통과, 밖이면 throw', async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-proj-'));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-other-'));
    try {
      const fence = new PermissionFence(tmpFence(null)); // engramRoot 없음
      await fence.load();
      expect(() => fence.assertCodingWrite(path.join(proj, 'a.ts'), [proj])).not.toThrow();
      expect(() => fence.assertCodingWrite(path.join(other, 'a.ts'), [proj])).toThrow('쓰기 스코프 밖');
    } finally { fs.rmSync(proj, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
  });

  it('projectWritePaths 비면 백스톱 밖은 통과(자동모드)', async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-proj2-'));
    try {
      const fence = new PermissionFence(tmpFence(null));
      await fence.load();
      expect(() => fence.assertCodingWrite(path.join(proj, 'a.ts'), [])).not.toThrow();
    } finally { fs.rmSync(proj, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/agent-layer/permission-fence.spec.ts -t "assertCodingWrite"`
Expected: FAIL — 메서드 없음.

- [ ] **Step 3: 구현**

`src/agent-layer/permission-fence.ts`의 `codingAutoFlags` 메서드 아래(마지막 `}` 앞)에 추가:

```ts
  // API 코딩 루프용 쓰기 판정(스펙 §5.1): 백스톱 + 프로젝트 쓰기 스코프. 막히면 throw.
  // CLI는 --add-dir로 스코프를 강제하지만 API 두뇌는 이 판정을 주입받아(codeGuard) 쓴다.
  assertCodingWrite(targetPath: string, projectWritePaths: string[]): void {
    this.assertWritable(targetPath); // 백스톱(자기repo·시스템·denyPaths) + cfg writePaths
    if (
      projectWritePaths.length > 0 &&
      !projectWritePaths.some((w) => PermissionFence.isWithin(targetPath, w))
    ) {
      throw new Error(`프로젝트 쓰기 스코프 밖: ${targetPath}`);
    }
  }
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/agent-layer/permission-fence.spec.ts`
Expected: PASS(신규 3 + 기존 전부)

- [ ] **Step 5: 커밋**

```bash
git add src/agent-layer/permission-fence.ts src/agent-layer/permission-fence.spec.ts
git commit -m "feat(phase8b1): PermissionFence.assertCodingWrite — 백스톱+프로젝트 쓰기 스코프"
```

---

### Task 3: AnthropicApiBrain 코딩 갈래 + turn 리팩터

**Files:**
- Modify: `src/brain/anthropic-api.brain.ts`
- Test: `src/brain/anthropic-api.brain.spec.ts`

**Interfaces:**
- Consumes: Task 1 `CODING_TOOL_DEFS`·`executeCodingTool`·`MAX_CODING_ITERATIONS`·`WriteGuard`·`CompleteOpts.codeGuard`; `WebToolDef`(web-tools); `MAX_TOOL_ITERATIONS`(tool-loop).
- Produces: `opts.cwd`+`opts.codeGuard` 있으면 코딩 도구루프. `opts.cwd`만 있고 `codeGuard` 없으면 isError. 채팅 경로 무변경.

- [ ] **Step 1: 실패 테스트 추가**

`src/brain/anthropic-api.brain.spec.ts` 상단 import 아래에 fs/os/path 추가:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
```

파일 끝(마지막 `});` 앞)에 append(상단 `PROFILE`·`sse`·`TEXT_TURN` 재사용):

```ts
  it('opts.cwd+codeGuard면 코딩 루프: Write 도구가 파일을 만든다', async () => {
    const WRITE_TURN = [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'w1', name: 'Write' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt","content":"hi"}' } },
      { type: 'message_delta', usage: { output_tokens: 2 } },
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-abrain-'));
    try {
      let call = 0;
      const fetchFn = jest.fn(async () => { call++; return call === 1 ? sse(WRITE_TURN) : sse(TEXT_TURN); }) as unknown as typeof fetch;
      const guarded: string[] = [];
      const codeGuard = (p: string) => { guarded.push(p); };
      const r = await new AnthropicApiBrain(PROFILE, fetchFn).complete('do', undefined, { cwd: dir, codeGuard });
      expect(r.isError).toBe(false);
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('hi');
      expect(guarded).toContain(path.resolve(dir, 'a.txt'));
      const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
      expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('opts.cwd 있고 codeGuard 없으면 isError(모델 호출 안 함)', async () => {
    const fetchFn = jest.fn() as unknown as typeof fetch;
    const r = await new AnthropicApiBrain(PROFILE, fetchFn).complete('do', undefined, { cwd: 'C:/x' });
    expect(r.isError).toBe(true);
    expect((fetchFn as jest.Mock)).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/brain/anthropic-api.brain.spec.ts -t "opts.cwd"`
Expected: FAIL — 아직 `opts.cwd`를 거부함.

- [ ] **Step 3: 구현 — import 교체**

`src/brain/anthropic-api.brain.ts`의 import를 교체:

```ts
import { BrainProvider, BrainResult, CompleteOpts } from './brain.port';
import { BrainProfile } from './brain.config';
import { Semaphore } from './semaphore';
import { sseJson } from './sse';
import { runToolLoop, ToolCall, TurnResult, MAX_TOOL_ITERATIONS } from './tool-loop';
import { WEB_TOOL_DEFS, WebToolDef, executeWebTool } from './web-tools';
import { askBrainDef, runAskBrain } from './brain-tools';
import { CODING_TOOL_DEFS, executeCodingTool, MAX_CODING_ITERATIONS } from './coding-tools';
```

(`DelegateHandle`는 더 이상 안 쓰므로 제거 — turn이 toolDefs를 받게 바뀜.)

- [ ] **Step 4: 구현 — complete() 갈래**

`complete()`의 `return this.sem.run(async () => { ... });` 안 본문을, 기존 `if (opts?.cwd) return fail(...)`부터 `runToolLoop(...)` 반환까지를 아래로 교체:

```ts
    return this.sem.run(async () => {
      const coding = !!opts?.cwd;
      if (coding && !opts!.codeGuard) return fail('coding requires an injected codeGuard (PermissionFence)');
      if (!this.profile.apiKey) return fail('anthropic-api: apiKey missing in brains.json profile');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? this.profile.timeoutMs);
      const history: AnthropicMsg[] = [{ role: 'user', content: prompt }];
      const toolDefs: WebToolDef[] = coding
        ? CODING_TOOL_DEFS
        : [...WEB_TOOL_DEFS, ...(opts?.delegate ? [askBrainDef(opts.delegate.brains)] : [])];
      const executor = coding
        ? (name: string, input: unknown) => executeCodingTool(name, input, opts!.cwd!, opts!.codeGuard!, ctrl.signal)
        : (name: string, input: unknown) =>
            name === 'ask_brain' ? runAskBrain(input, opts?.delegate) : executeWebTool(name, input, this.profile, this.fetchFn, ctrl.signal);
      try {
        const r = await runToolLoop(
          () => this.turn(history, onChunk, ctrl.signal, toolDefs),
          (results) => history.push({
            role: 'user',
            content: results.map((t) => ({ type: 'tool_result', tool_use_id: t.id, content: t.output })),
          }),
          executor,
          coding ? MAX_CODING_ITERATIONS : MAX_TOOL_ITERATIONS,
        );
        return {
          text: r.text,
          costUsd: this.cost(r.inputTokens, r.outputTokens),
          isError: false,
          ...(r.hitLimit ? { raw: 'tool-loop-limit' } : {}),
        };
      } catch (e) {
        return fail(ctrl.signal.aborted ? 'timeout' : String(e));
      } finally {
        clearTimeout(timer);
      }
    });
```

- [ ] **Step 5: 구현 — turn() 시그니처**

`turn()`가 도구 목록을 인자로 받게 바꾸고 내부 `const toolDefs = [...]` 줄을 삭제:

```ts
  private async turn(history: AnthropicMsg[], onChunk: ((t: string) => void) | undefined, signal: AbortSignal, toolDefs: WebToolDef[]): Promise<TurnResult> {
    const res = await this.fetchFn(`${this.profile.baseUrl || DEFAULT_BASE}/v1/messages`, {
```

(그 아래 `tools: toolDefs.map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters }))`는 그대로. SSE 순회 이하 전부 무변경.)

- [ ] **Step 6: 통과 확인**

Run: `npx jest src/brain/anthropic-api.brain.spec.ts`
Expected: PASS(신규 2 + 기존 전부 — 특히 "delegate 없으면 web 도구만" 회귀 테스트)

- [ ] **Step 7: 커밋**

```bash
git add src/brain/anthropic-api.brain.ts src/brain/anthropic-api.brain.spec.ts
git commit -m "feat(phase8b1): AnthropicApiBrain 코딩 도구루프 갈래(opts.cwd+codeGuard) + turn toolDefs 인자화"
```

---

### Task 4: OpenAiApiBrain 코딩 갈래 + turn 리팩터

**Files:**
- Modify: `src/brain/openai-api.brain.ts`
- Test: `src/brain/openai-api.brain.spec.ts`

**Interfaces:**
- Consumes: Task 1·Task 3과 동일(`CODING_TOOL_DEFS`·`executeCodingTool`·`MAX_CODING_ITERATIONS`·`WebToolDef`·`MAX_TOOL_ITERATIONS`).
- Produces: Anthropic과 동일(OpenAI 와이어 형식).

- [ ] **Step 1: 실패 테스트 추가**

`src/brain/openai-api.brain.spec.ts` 상단 import 아래에 fs/os/path 추가:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
```

파일 끝에 append(상단 `PROFILE`·`sse`·`TEXT_CHUNKS` 재사용):

```ts
  it('opts.cwd+codeGuard면 코딩 루프: Write 도구가 파일을 만든다', async () => {
    const WRITE_CHUNKS = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'w1', type: 'function', function: { name: 'Write', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt","content":"hi"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } },
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-obrain-'));
    try {
      let call = 0;
      const fetchFn = jest.fn(async () => { call++; return call === 1 ? sse(WRITE_CHUNKS) : sse(TEXT_CHUNKS); }) as unknown as typeof fetch;
      const guarded: string[] = [];
      const codeGuard = (p: string) => { guarded.push(p); };
      const r = await new OpenAiApiBrain(PROFILE, fetchFn).complete('do', undefined, { cwd: dir, codeGuard });
      expect(r.isError).toBe(false);
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('hi');
      expect(guarded).toContain(path.resolve(dir, 'a.txt'));
      const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
      expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('opts.cwd 있고 codeGuard 없으면 isError(모델 호출 안 함)', async () => {
    const fetchFn = jest.fn() as unknown as typeof fetch;
    const r = await new OpenAiApiBrain(PROFILE, fetchFn).complete('do', undefined, { cwd: 'C:/x' });
    expect(r.isError).toBe(true);
    expect((fetchFn as jest.Mock)).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/brain/openai-api.brain.spec.ts -t "opts.cwd"`
Expected: FAIL.

- [ ] **Step 3: 구현 — import 교체**

```ts
import { BrainProvider, BrainResult, CompleteOpts } from './brain.port';
import { BrainProfile } from './brain.config';
import { Semaphore } from './semaphore';
import { sseJson } from './sse';
import { runToolLoop, ToolCall, TurnResult, MAX_TOOL_ITERATIONS } from './tool-loop';
import { WEB_TOOL_DEFS, WebToolDef, executeWebTool } from './web-tools';
import { askBrainDef, runAskBrain } from './brain-tools';
import { CODING_TOOL_DEFS, executeCodingTool, MAX_CODING_ITERATIONS } from './coding-tools';
```

(`DelegateHandle` 제거.)

- [ ] **Step 4: 구현 — complete() 갈래**

`complete()`의 `return this.sem.run(async () => { ... });` 본문을, 기존 `if (opts?.cwd) return fail(...)`부터 `runToolLoop(...)` 반환까지를 교체:

```ts
    return this.sem.run(async () => {
      const coding = !!opts?.cwd;
      if (coding && !opts!.codeGuard) return fail('coding requires an injected codeGuard (PermissionFence)');
      if (!this.profile.baseUrl) return fail('openai-api: baseUrl missing in brains.json profile');
      if (!this.profile.model) return fail('openai-api: model missing in brains.json profile');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? this.profile.timeoutMs);
      const history: OpenAiMsg[] = [{ role: 'user', content: prompt }];
      const toolDefs: WebToolDef[] = coding
        ? CODING_TOOL_DEFS
        : [...WEB_TOOL_DEFS, ...(opts?.delegate ? [askBrainDef(opts.delegate.brains)] : [])];
      const executor = coding
        ? (name: string, input: unknown) => executeCodingTool(name, input, opts!.cwd!, opts!.codeGuard!, ctrl.signal)
        : (name: string, input: unknown) =>
            name === 'ask_brain' ? runAskBrain(input, opts?.delegate) : executeWebTool(name, input, this.profile, this.fetchFn, ctrl.signal);
      try {
        const r = await runToolLoop(
          () => this.turn(history, onChunk, ctrl.signal, toolDefs),
          (results) => {
            for (const t of results) history.push({ role: 'tool', content: t.output, tool_call_id: t.id });
          },
          executor,
          coding ? MAX_CODING_ITERATIONS : MAX_TOOL_ITERATIONS,
        );
        return {
          text: r.text,
          costUsd: this.cost(r.inputTokens, r.outputTokens),
          isError: false,
          ...(r.hitLimit ? { raw: 'tool-loop-limit' } : {}),
        };
      } catch (e) {
        return fail(ctrl.signal.aborted ? 'timeout' : String(e));
      } finally {
        clearTimeout(timer);
      }
    });
```

- [ ] **Step 5: 구현 — turn() 시그니처**

```ts
  private async turn(history: OpenAiMsg[], onChunk: ((t: string) => void) | undefined, signal: AbortSignal, toolDefs: WebToolDef[]): Promise<TurnResult> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
```

(내부 `const toolDefs = [...]` 줄 삭제. `tools: toolDefs.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } }))`는 그대로. 나머지 무변경.)

- [ ] **Step 6: 통과 확인**

Run: `npx jest src/brain/openai-api.brain.spec.ts`
Expected: PASS(신규 2 + 기존 전부)

- [ ] **Step 7: 커밋**

```bash
git add src/brain/openai-api.brain.ts src/brain/openai-api.brain.spec.ts
git commit -m "feat(phase8b1): OpenAiApiBrain 코딩 도구루프 갈래(opts.cwd+codeGuard) + turn toolDefs 인자화"
```

---

### Task 5: CodingSpecialist codeGuard 배선

**Files:**
- Modify: `src/agent-layer/coding-specialist.ts`
- Test: `src/agent-layer/coding-specialist.spec.ts`

**Interfaces:**
- Consumes: Task 2 `fence.assertCodingWrite(targetPath, projectWritePaths)`; `ProjectConfig`(`targetPath`·`writePaths`).
- Produces: `brain.complete`에 `codeGuard: (p) => fence.assertCodingWrite(p, project.writePaths)`를 함께 전달.

- [ ] **Step 1: 실패 테스트 추가**

`src/agent-layer/coding-specialist.spec.ts`의 `describe('CodingSpecialist', ...)` 안에 append. 상단 `fence` 스텁에 `assertCodingWrite`가 없으니, 이 테스트는 자체 스텁을 만든다:

```ts
  it('brain.complete에 codeGuard(=fence.assertCodingWrite 바인딩)를 함께 넘긴다', async () => {
    const calls: Array<{ target: string; scope: string[] }> = [];
    const fence2 = {
      codingAutoFlags: () => ['--allowedTools', 'Edit', '--add-dir', 'C:/proj'],
      assertCodingWrite: (target: string, scope: string[]) => { calls.push({ target, scope }); },
    } as any;
    const captured: any = {};
    const brain = { complete: (_p: string, _c: any, opts: any) => { captured.opts = opts; return Promise.resolve({ text: 'ok', costUsd: 0, isError: false }); } };
    const spec = new CodingSpecialist(registry, fence2, () => brain as any, logger);
    await spec.work('Dev', { id: 'tk1', area: 'src/a', instruction: 'i', status: 'PENDING', attempts: 0, gate: null }, project);
    expect(typeof captured.opts.codeGuard).toBe('function');
    expect(captured.opts.cwd).toBe('C:/proj');
    expect(captured.opts.extraArgs).toContain('--allowedTools'); // CLI용도 그대로
    captured.opts.codeGuard('C:/proj/a.ts'); // 호출 시 fence.assertCodingWrite로 위임
    expect(calls).toEqual([{ target: 'C:/proj/a.ts', scope: ['C:/proj'] }]);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/agent-layer/coding-specialist.spec.ts -t "codeGuard"`
Expected: FAIL — `opts.codeGuard`가 undefined.

- [ ] **Step 3: 구현**

`src/agent-layer/coding-specialist.ts`의 `brain.complete(...)` 호출을 교체:

```ts
    const r = await brain.complete(prompt, onChunk, {
      cwd: project.targetPath,
      extraArgs: flags, // CLI 두뇌용(무변경)
      codeGuard: (p) => this.fence.assertCodingWrite(p, project.writePaths), // API 두뇌용(Phase 8b-1)
    });
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/agent-layer/coding-specialist.spec.ts`
Expected: PASS(신규 1 + 기존 전부)

- [ ] **Step 5: 커밋**

```bash
git add src/agent-layer/coding-specialist.ts src/agent-layer/coding-specialist.spec.ts
git commit -m "feat(phase8b1): CodingSpecialist가 codeGuard(assertCodingWrite)도 함께 전달 — API 두뇌 코딩 활성"
```

---

### Task 6: 전체 회귀 + 빌드

**Files:** 없음(검증만)

**Interfaces:** Consumes: 전 Task.

- [ ] **Step 1: 백엔드 전체 스위트**

Run: `npx jest`
Expected: PASS. 만약 fs/git 무거운 스위트(rag-store·coding-git·wiki-* 등)가 병렬 실행에서 flaky하게 몇 개 실패하면, 그 스위트만 in-band로 재확인: `npx jest coding-git wiki-git rag-store --runInBand` → 통과면 병렬 flake로 간주(이 머신 알려진 현상). 실제 회귀면 해당 Task로 복귀.

- [ ] **Step 2: 타입/빌드**

Run: `npm run build`
Expected: nest/tsc 에러 0. (특히 두 API 두뇌의 `DelegateHandle` import 제거·`WebToolDef`/`MAX_TOOL_ITERATIONS`/`MAX_CODING_ITERATIONS` import·turn 시그니처 변경이 깨끗한지.)

- [ ] **Step 3: 렌더러(무변경 확인)**

Run: `npm --prefix renderer test`
Expected: PASS(8b-1은 렌더러 무변경).

---

## Self-Review

**Spec coverage:**
- §4 coding-tools.ts(5종·never-throw·MAX_CODING_ITERATIONS·WriteGuard) → Task 1. ✅
- §4.1 도구별 동작(Read cwd제한·Write mkdir·Edit 정확1곳·Glob/Grep 상한) → Task 1 구현+테스트. ✅
- §5 보안(읽기 cwd·쓰기 guard·셸없음) → Task 1(cwd resolveWithin·guard 호출) + Task 2(assertCodingWrite). ✅
- §5.1 assertCodingWrite → Task 2. ✅
- §6.1 CompleteOpts.codeGuard → Task 1 Step 1. ✅
- §6.2 complete 갈래 + turn 리팩터 → Task 3(anthropic)·Task 4(openai). ✅
- §7 CodingSpecialist 배선 → Task 5. ✅
- §8 루프 한도(MAX_CODING_ITERATIONS·hitLimit 비에러) → Task 1(상수)·Task 3/4(coding?MAX_CODING:MAX_TOOL). resume=기존 재시도(무변경). ✅
- §9 기본 provider 값 무변경 → 어느 Task도 brains.json default를 안 건드림. ✅
- §10 재사용 무변경(Gate·Git·Orchestrator·PersonaRegistry) → 건드리는 Task 없음. ✅
- §11 테스트 전략 전 항목 → 각 Task 테스트. ✅
- §12 불변식 1~7 → Task 1(1·3·5·7)·Task 2(2)·Task 3/4(4·6). ✅

**Placeholder scan:** "적절히"류 없음. 상한값(50k·200·100)·MAX_CODING_ITERATIONS(30)은 상수로 확정. ✅

**Type consistency:**
- `WriteGuard = (absPath: string) => void` — Task 1 정의, Task 3/4 executor(`opts.codeGuard`), Task 5(`(p) => fence.assertCodingWrite(...)`) 동일. ✅
- `executeCodingTool(name, input, cwd, guard, signal)` — Task 1 정의, Task 3/4 호출 동일 인자순. ✅
- `CODING_TOOL_DEFS: WebToolDef[]`·`WebToolDef`(name/description/parameters) — Task 1, Task 3/4 turn 인자·`tools.map` 동일. ✅
- `assertCodingWrite(targetPath, projectWritePaths)` — Task 2 정의, Task 5 `assertCodingWrite(p, project.writePaths)` 동일. ✅
- `CompleteOpts.codeGuard?: (absPath: string) => void` — Task 1, Task 3/4/5 사용 동일. ✅
- `MAX_TOOL_ITERATIONS`(tool-loop)·`MAX_CODING_ITERATIONS`(coding-tools) — Task 3/4 `coding ? MAX_CODING_ITERATIONS : MAX_TOOL_ITERATIONS`. ✅

**주의(구현자용):**
- Task 3/4에서 `DelegateHandle` import를 **반드시 제거**(turn이 delegate 대신 toolDefs를 받으므로 미사용 → 빌드 경고/에러). 대신 `WebToolDef`·`MAX_TOOL_ITERATIONS`·coding-tools 3종 import 추가.
- 코딩 테스트의 목 fetch는 **첫 호출=Write tool_use 턴, 둘째 호출=최종 텍스트 턴**으로 분기(call 카운터). `codeGuard`는 파일 경로만 기록하는 순수 스텁(실제 fence 아님).
- `opts.cwd`만 있고 `codeGuard` 없는 케이스는 모델을 호출하기 전에 `fail` → fetch 미호출 검증.
