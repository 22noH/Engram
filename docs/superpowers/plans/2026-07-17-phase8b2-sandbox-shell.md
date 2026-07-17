# Phase 8b-2 — 엔그램 하네스 명령 실행(Bash) 도구 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 엔그램 하네스 두뇌(anthropic-api·openai-api)가 코딩 중 `Bash` 도구로 셸 명령을 실행하게 한다(기본 auto=아무 명령이나, Claude Code 자동모드 parity). 설정창에 코딩 명령 모드 토글 + 기본 두뇌(하네스) 드롭다운을 더한다.

**Architecture:** 8b-1과 동일한 주입 패턴. 새 `shell-tool.ts`(src/brain)가 `shell:true`로 명령을 실행하고, 명령 허용 판정은 `opts.cmdGuard`(=`fence.assertCommandAllowed`, auto면 no-op)로 주입한다. 안전장치는 "제한"이 아니라 사고 방지 — 타임아웃 트리종료·출력상한·never-throw + 이미 있는 git 브랜치 격리. 설정 UI는 순수 파일 read/write 함수 + IPC 핸들러 + settings.html.

**Tech Stack:** TypeScript/NestJS, cross-spawn(기존), Electron 설정창, Jest(명령은 `node -e`로 크로스플랫폼·실 위험 없음).

## Global Constraints

- **기본 auto** — 기본값에선 두뇌가 아무 셸 명령이나 실행(shell:true). 제한(allowlist)·끔(off)은 opt-in.
- **never-throw** — `runShellTool`은 어떤 입력·실패에도 예외 대신 텍스트(종료코드+출력) 반환.
- **타임아웃 관통** — 명령별 타임아웃(`MAX_SHELL_TIMEOUT_MS`=120000) 또는 루프 `signal` abort, 먼저 오는 쪽에 프로세스 트리 강제종료(Win=`taskkill /T /F`, POSIX=프로세스그룹 kill).
- **출력 상한** — 종료코드 + 출력 마지막 `SHELL_OUTPUT_LIMIT`(20000)자.
- **가드 없으면 Bash 없음** — `opts.cmdGuard` 미주입이면 Bash 도구 미노출.
- **셸 끄기** — `commandMode: 'off'`면 CodingSpecialist가 cmdGuard 미주입 → Bash 미노출(8b-1 상태).
- **회귀 0** — 채팅 경로·CLI 두뇌·8b-1 파일도구·기본 provider 값 무변경. cmdGuard 없는 8b-1 코딩 테스트(`tools=['Read','Write','Edit','Glob','Grep']`)는 그대로 통과.
- **되돌림은 git** — 주 안전망은 CodingGit 격리 브랜치(무변경 재사용). VerificationGate 최종검증도 무변경.
- 테스트: `npx jest <경로>`를 **PowerShell로 foreground 실행**(이 머신 Bash 도구 깨짐; jest 백그라운드/워치 hang). "Tests: N passed"로 판단(빨간 RemoteException 래퍼는 겉치레). 실 네트워크 금지.
- 커밋 메시지 한국어, Co-Authored-By(공동작업자) 줄 넣지 말 것.

---

### Task 1: shell-tool.ts (Bash 도구 + 트리종료) + CompleteOpts.cmdGuard

**Files:**
- Modify: `src/brain/brain.port.ts`
- Create: `src/brain/shell-tool.ts`
- Test: `src/brain/shell-tool.spec.ts`

**Interfaces:**
- Consumes: `WebToolDef`(`src/brain/web-tools.ts`).
- Produces(Task 3·4·5): `MAX_SHELL_TIMEOUT_MS`·`SHELL_OUTPUT_LIMIT`(number) · `type CommandGuard = (command: string) => void` · `BASH_TOOL_DEF: WebToolDef` · `runShellTool(input: unknown, cwd: string, guard: CommandGuard, signal: AbortSignal): Promise<string>`(never-throw) · `CompleteOpts.cmdGuard?: (command: string) => void`.

- [ ] **Step 1: 포트 필드 추가**

`src/brain/brain.port.ts`의 `CompleteOpts`에 `cmdGuard` 추가(기존 필드/주석 유지):
```ts
export interface CompleteOpts {
  cwd?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  delegate?: DelegateHandle;
  codeGuard?: (absPath: string) => void;
  cmdGuard?: (command: string) => void; // Phase 8b-2: 명령 판정(주입). 있으면 coding 루프가 Bash 노출. auto면 무조건 통과.
}
```

- [ ] **Step 2: 실패 테스트 작성**

`src/brain/shell-tool.spec.ts`:
```ts
import { BASH_TOOL_DEF, runShellTool, MAX_SHELL_TIMEOUT_MS, SHELL_OUTPUT_LIMIT, CommandGuard } from './shell-tool';

const NO_ABORT = new AbortController().signal;
const allow: CommandGuard = () => {};
const cwd = process.cwd();

describe('BASH_TOOL_DEF', () => {
  it('name Bash, command 필수', () => {
    expect(BASH_TOOL_DEF.name).toBe('Bash');
    expect((BASH_TOOL_DEF.parameters as any).required).toEqual(['command']);
    expect(MAX_SHELL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SHELL_OUTPUT_LIMIT).toBeGreaterThan(0);
  });
});

describe('runShellTool (never-throw)', () => {
  it('정상 명령 → [exit 0] + stdout', async () => {
    const r = await runShellTool({ command: `node -e "console.log('hi')"` }, cwd, allow, NO_ABORT);
    expect(r).toContain('[exit 0]');
    expect(r).toContain('hi');
  });

  it('셸 기능(체이닝) 동작 — auto', async () => {
    const r = await runShellTool({ command: `node -e "console.log(1)" && node -e "console.log(2)"` }, cwd, allow, NO_ABORT);
    expect(r).toContain('1');
    expect(r).toContain('2');
  });

  it('비영 종료코드 → [exit N] (에러 아님)', async () => {
    const r = await runShellTool({ command: `node -e "process.exit(3)"` }, cwd, allow, NO_ABORT);
    expect(r).toContain('[exit 3]');
  });

  it('가드가 막으면 spawn 안 하고 blocked 텍스트', async () => {
    const deny: CommandGuard = (c) => { throw new Error(`denied ${c}`); };
    const r = await runShellTool({ command: `node -e "1"` }, cwd, deny, NO_ABORT);
    expect(r).toContain('Bash blocked');
  });

  it('오염 인자(command 누락) → 에러 텍스트', async () => {
    expect(await runShellTool({}, cwd, allow, NO_ABORT)).toContain('required');
    expect(await runShellTool(null, cwd, allow, NO_ABORT)).toContain('required');
  });

  it('abort 시 트리종료 + [timeout]', async () => {
    const ctrl = new AbortController();
    const p = runShellTool({ command: `node -e "setTimeout(()=>{}, 999999)"` }, cwd, allow, ctrl.signal);
    setTimeout(() => ctrl.abort(), 100);
    const r = await p;
    expect(r).toContain('[timeout]');
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx jest src/brain/shell-tool.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 4: 구현**

`src/brain/shell-tool.ts`:
```ts
import spawn from 'cross-spawn';
import { WebToolDef } from './web-tools';

// 명령 실행 도구(스펙 §6.1). shell:true로 실행 — 기본 auto(아무 명령이나). 안전은 타임아웃 트리종료·출력상한·never-throw.
export const MAX_SHELL_TIMEOUT_MS = 120_000; // 명령별 타임아웃
export const SHELL_OUTPUT_LIMIT = 20_000;    // 반환 출력 마지막 N자

// 명령 판정(막히면 throw). agent-layer가 fence.assertCommandAllowed를 바인딩해 주입. auto 모드면 사실상 no-op.
export type CommandGuard = (command: string) => void;

export const BASH_TOOL_DEF: WebToolDef = {
  name: 'Bash',
  description:
    'Run a shell command in the working directory and return its combined output and exit code. ' +
    'Use it to run tests, builds, linters, or any command needed to verify your changes.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string', description: 'The shell command to run' } },
    required: ['command'],
  },
};

// 프로세스 트리 강제종료(자식까지). Win=taskkill /T /F, POSIX=프로세스그룹 kill(detached로 그룹 생성).
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F']); } catch { /* best effort */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 종료 */ } }
  }
}

// 실행 — never-throw. 타임아웃/abort 시 트리종료, 출력 상한.
export function runShellTool(input: unknown, cwd: string, guard: CommandGuard, signal: AbortSignal): Promise<string> {
  const arg = (input ?? {}) as Record<string, unknown>;
  if (typeof arg.command !== 'string' || !arg.command.trim()) return Promise.resolve('Bash error: command(string) required');
  try { guard(arg.command); } catch (e) { return Promise.resolve(`Bash blocked: ${String(e)}`); }

  return new Promise<string>((resolve) => {
    const child = spawn(arg.command as string, [], {
      cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', // POSIX: 자기 프로세스그룹 → -pid로 트리 kill
    });
    let out = '';
    let done = false;
    const finish = (text: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(text);
    };
    const onAbort = (): void => { if (child.pid) killTree(child.pid); finish('[timeout] aborted'); };
    const timer = setTimeout(() => { if (child.pid) killTree(child.pid); finish(`[timeout] exceeded ${MAX_SHELL_TIMEOUT_MS}ms`); }, MAX_SHELL_TIMEOUT_MS);
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort);
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', (e) => finish(`Bash error: ${String(e)}`));
    child.on('close', (code) => finish(`[exit ${code ?? 1}]\n${out.slice(-SHELL_OUTPUT_LIMIT)}`));
  });
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx jest src/brain/shell-tool.spec.ts`
Expected: PASS

- [ ] **Step 6: 커밋**

```
git add src/brain/brain.port.ts src/brain/shell-tool.ts src/brain/shell-tool.spec.ts
git commit -m "feat(phase8b2): shell-tool Bash 도구(shell:true·타임아웃 트리종료·never-throw) + CompleteOpts.cmdGuard 포트"
```

---

### Task 2: PermissionFence commandMode + assertCommandAllowed

**Files:**
- Modify: `src/agent-layer/permission-fence.ts`
- Test: `src/agent-layer/permission-fence.spec.ts`

**Interfaces:**
- Consumes: 기존 `FenceConfig`·`EMPTY()`·private static `isWithin`(불필요), `cfg.allow`.
- Produces(Task 5): `PermissionFence.shellEnabled(): boolean` · `PermissionFence.assertCommandAllowed(command: string): void` · `DEFAULT_COMMANDS`.

- [ ] **Step 1: 실패 테스트 추가**

`src/agent-layer/permission-fence.spec.ts` 끝에 append(상단 `tmpFence`·fs/os/path 재사용):
```ts
describe('commandMode / assertCommandAllowed (Phase 8b-2)', () => {
  it('기본(미지정) = auto → 아무 명령이나 통과 + shellEnabled true', async () => {
    const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } }));
    await fence.load();
    expect(fence.shellEnabled()).toBe(true);
    expect(() => fence.assertCommandAllowed('rm -rf /')).not.toThrow(); // auto=제한 안 함
  });

  it('off → shellEnabled false + assertCommandAllowed throw', async () => {
    const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [], commandMode: 'off' } }));
    await fence.load();
    expect(fence.shellEnabled()).toBe(false);
    expect(() => fence.assertCommandAllowed('npm test')).toThrow();
  });

  it('allowlist → 기본목록 통과·목록 밖 throw·연산자 throw', async () => {
    const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [], commandMode: 'allowlist' } }));
    await fence.load();
    expect(() => fence.assertCommandAllowed('npm test')).not.toThrow(); // 기본목록에 npm
    expect(() => fence.assertCommandAllowed('curl http://x')).toThrow(); // 목록 밖
    expect(() => fence.assertCommandAllowed('npm test && rm -rf /')).toThrow('연산자'); // 체이닝 금지
    expect(() => fence.assertCommandAllowed('msbuild.exe App.sln')).not.toThrow(); // .exe 정규화
  });

  it('allowlist + 사용자 지정 commands → 그것만', async () => {
    const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [], commandMode: 'allowlist', commands: ['pytest'] } }));
    await fence.load();
    expect(() => fence.assertCommandAllowed('pytest -q')).not.toThrow();
    expect(() => fence.assertCommandAllowed('npm test')).toThrow(); // 지정 목록에 npm 없음
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/agent-layer/permission-fence.spec.ts -t "commandMode"` → FAIL(메서드 없음).

- [ ] **Step 3: 구현**

`src/agent-layer/permission-fence.ts` 수정.

**(a)** `FenceConfig`의 `allow`에 필드 추가(기존 필드 유지):
```ts
export interface FenceConfig {
  default: 'deny';
  allow: {
    tools: Record<string, string[]>;
    writePaths: string[];
    denyPaths: string[];
    commandMode?: 'auto' | 'allowlist' | 'off'; // Phase 8b-2: 기본 auto
    commands?: string[];                         // allowlist 모드용(없으면 DEFAULT_COMMANDS)
  };
}
```

**(b)** 파일 상단(클래스 밖)에 상수 추가:
```ts
// allowlist 모드에서 쓰는 내장 기본 허용목록(사용자가 allow.commands 지정 안 하면 이걸 씀).
export const DEFAULT_COMMANDS = [
  'npm', 'pnpm', 'yarn', 'npx', 'node', 'deno', 'bun', 'python', 'python3', 'pytest', 'go', 'cargo', 'rustc',
  'dotnet', 'msbuild', 'cmake', 'make', 'nmake', 'qmake', 'tsc', 'jest', 'vitest', 'eslint', 'prettier', 'gradle', 'mvn',
];
```

**(c)** `codingAutoFlags` 아래(클래스 마지막 `}` 앞)에 메서드 추가:
```ts
  // 셸 켜짐 여부(off면 Bash 도구 미노출). CodingSpecialist가 cmdGuard 주입 판단에 사용.
  shellEnabled(): boolean {
    return (this.cfg.allow.commandMode ?? 'auto') !== 'off';
  }

  // 명령 판정(스펙 §6.3). auto=무조건 통과, off=거부, allowlist=연산자 거부+실행파일 목록 검사.
  assertCommandAllowed(command: string): void {
    const mode = this.cfg.allow.commandMode ?? 'auto';
    if (mode === 'auto') return;
    if (mode === 'off') throw new Error('셸이 비활성화됨(commandMode: off)');
    if (/[&|;<>`]|\$\(/.test(command)) throw new Error(`allowlist 모드에선 셸 연산자 금지: ${command}`);
    const exe = command.trim().split(/\s+/)[0];
    const base = exe.replace(/.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
    const allow = (this.cfg.allow.commands ?? DEFAULT_COMMANDS).map((c) => c.toLowerCase());
    if (!allow.includes(base)) {
      throw new Error(`허용되지 않은 명령: ${command} (permissions.json allow.commands에 "${base}" 추가 필요)`);
    }
  }
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/agent-layer/permission-fence.spec.ts` → PASS(신규 4 + 기존 전부).

- [ ] **Step 5: 커밋**

```
git add src/agent-layer/permission-fence.ts src/agent-layer/permission-fence.spec.ts
git commit -m "feat(phase8b2): PermissionFence commandMode(auto/allowlist/off)+assertCommandAllowed+shellEnabled+DEFAULT_COMMANDS"
```

---

### Task 3: AnthropicApiBrain — Bash 도구 배선

**Files:**
- Modify: `src/brain/anthropic-api.brain.ts`
- Test: `src/brain/anthropic-api.brain.spec.ts`

**Interfaces:**
- Consumes: Task 1 `BASH_TOOL_DEF`·`runShellTool`·`CompleteOpts.cmdGuard`.
- Produces: coding 모드에서 `opts.cmdGuard` 있으면 도구셋에 Bash 추가, 모델이 부르면 `runShellTool`로 라우팅.

- [ ] **Step 1: 실패 테스트 추가**

`src/brain/anthropic-api.brain.spec.ts` 끝(마지막 `});` 앞)에 append(상단 `PROFILE`·`sse`·`TEXT_TURN`·fs/os/path 재사용):
```ts
  it('coding + cmdGuard면 Bash 도구 노출 + 실행', async () => {
    const BASH_TURN = [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'b1', name: 'Bash' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: `{"command":"node -e \\"console.log('ran')\\""}` } },
      { type: 'message_delta', usage: { output_tokens: 2 } },
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-abash-'));
    try {
      let call = 0;
      const fetchFn = jest.fn(async () => { call++; return call === 1 ? sse(BASH_TURN) : sse(TEXT_TURN); }) as unknown as typeof fetch;
      const seen: string[] = [];
      const r = await new AnthropicApiBrain(PROFILE, fetchFn).complete('do', undefined, {
        cwd: dir, codeGuard: () => {}, cmdGuard: (c: string) => { seen.push(c); },
      });
      expect(r.isError).toBe(false);
      expect(seen.length).toBe(1); // cmdGuard 호출됨
      const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
      expect(body.tools.map((t: { name: string }) => t.name)).toContain('Bash');
      expect(JSON.stringify((fetchFn as jest.Mock).mock.calls[1][1].body)).toContain('ran'); // 실행 결과 되먹임
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('coding인데 cmdGuard 없으면 Bash 미노출(파일도구만)', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_TURN)) as unknown as typeof fetch;
    await new AnthropicApiBrain(PROFILE, fetchFn).complete('do', undefined, { cwd: 'C:/x', codeGuard: () => {} });
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/brain/anthropic-api.brain.spec.ts -t "Bash"` → FAIL.

- [ ] **Step 3: 구현**

`src/brain/anthropic-api.brain.ts` 수정.

**(a)** import 추가:
```ts
import { CODING_TOOL_DEFS, executeCodingTool, MAX_CODING_ITERATIONS } from './coding-tools';
import { BASH_TOOL_DEF, runShellTool } from './shell-tool';
```
(기존 coding-tools import 줄에 shell-tool import 한 줄 추가.)

**(b)** `complete()`의 `toolDefs`·`executor`(coding 갈래)를 교체:
```ts
      const toolDefs: WebToolDef[] = coding
        ? [...CODING_TOOL_DEFS, ...(opts!.cmdGuard ? [BASH_TOOL_DEF] : [])]
        : [...WEB_TOOL_DEFS, ...(opts?.delegate ? [askBrainDef(opts.delegate.brains)] : [])];
      const executor = coding
        ? (name: string, input: unknown) => name === 'Bash'
            ? runShellTool(input, opts!.cwd!, opts!.cmdGuard!, ctrl.signal)
            : executeCodingTool(name, input, opts!.cwd!, opts!.codeGuard!, ctrl.signal)
        : (name: string, input: unknown) =>
            name === 'ask_brain' ? runAskBrain(input, opts?.delegate) : executeWebTool(name, input, this.profile, this.fetchFn, ctrl.signal);
```
(나머지 complete()·turn()·runToolLoop 인자는 무변경.)

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/brain/anthropic-api.brain.spec.ts` → PASS(신규 2 + 기존 전부, 특히 8b-1 코딩 테스트 `tools=['Read'..'Grep']`가 cmdGuard 없어 그대로).
`npm run build` → 에러 0.

- [ ] **Step 5: 커밋**

```
git add src/brain/anthropic-api.brain.ts src/brain/anthropic-api.brain.spec.ts
git commit -m "feat(phase8b2): AnthropicApiBrain 코딩 루프에 Bash 도구 배선(cmdGuard 있을 때)"
```

---

### Task 4: OpenAiApiBrain — Bash 도구 배선

**Files:**
- Modify: `src/brain/openai-api.brain.ts`
- Test: `src/brain/openai-api.brain.spec.ts`

**Interfaces:** Consumes Task 1·3과 동일.

- [ ] **Step 1: 실패 테스트 추가**

`src/brain/openai-api.brain.spec.ts` 끝에 append(상단 `PROFILE`·`sse`·`TEXT_CHUNKS`·fs/os/path 재사용):
```ts
  it('coding + cmdGuard면 Bash 도구 노출 + 실행', async () => {
    const BASH_CHUNKS = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'b1', type: 'function', function: { name: 'Bash', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `{"command":"node -e \\"console.log('ran')\\""}` } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } },
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-obash-'));
    try {
      let call = 0;
      const fetchFn = jest.fn(async () => { call++; return call === 1 ? sse(BASH_CHUNKS) : sse(TEXT_CHUNKS); }) as unknown as typeof fetch;
      const seen: string[] = [];
      const r = await new OpenAiApiBrain(PROFILE, fetchFn).complete('do', undefined, {
        cwd: dir, codeGuard: () => {}, cmdGuard: (c: string) => { seen.push(c); },
      });
      expect(r.isError).toBe(false);
      expect(seen.length).toBe(1);
      const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
      expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toContain('Bash');
      expect(JSON.stringify((fetchFn as jest.Mock).mock.calls[1][1].body)).toContain('ran');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('coding인데 cmdGuard 없으면 Bash 미노출', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_CHUNKS)) as unknown as typeof fetch;
    await new OpenAiApiBrain(PROFILE, fetchFn).complete('do', undefined, { cwd: 'C:/x', codeGuard: () => {} });
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/brain/openai-api.brain.spec.ts -t "Bash"` → FAIL.

- [ ] **Step 3: 구현**

**(a)** import 추가(기존 coding-tools import 줄 옆):
```ts
import { CODING_TOOL_DEFS, executeCodingTool, MAX_CODING_ITERATIONS } from './coding-tools';
import { BASH_TOOL_DEF, runShellTool } from './shell-tool';
```

**(b)** `complete()`의 `toolDefs`·`executor`(coding 갈래) 교체:
```ts
      const toolDefs: WebToolDef[] = coding
        ? [...CODING_TOOL_DEFS, ...(opts!.cmdGuard ? [BASH_TOOL_DEF] : [])]
        : [...WEB_TOOL_DEFS, ...(opts?.delegate ? [askBrainDef(opts.delegate.brains)] : [])];
      const executor = coding
        ? (name: string, input: unknown) => name === 'Bash'
            ? runShellTool(input, opts!.cwd!, opts!.cmdGuard!, ctrl.signal)
            : executeCodingTool(name, input, opts!.cwd!, opts!.codeGuard!, ctrl.signal)
        : (name: string, input: unknown) =>
            name === 'ask_brain' ? runAskBrain(input, opts?.delegate) : executeWebTool(name, input, this.profile, this.fetchFn, ctrl.signal);
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/brain/openai-api.brain.spec.ts` → PASS. `npm run build` → 에러 0.

- [ ] **Step 5: 커밋**

```
git add src/brain/openai-api.brain.ts src/brain/openai-api.brain.spec.ts
git commit -m "feat(phase8b2): OpenAiApiBrain 코딩 루프에 Bash 도구 배선(cmdGuard 있을 때)"
```

---

### Task 5: CodingSpecialist — cmdGuard 주입

**Files:**
- Modify: `src/agent-layer/coding-specialist.ts`
- Test: `src/agent-layer/coding-specialist.spec.ts`

**Interfaces:**
- Consumes: Task 2 `fence.shellEnabled()`·`fence.assertCommandAllowed(cmd)`.
- Produces: `brain.complete`에 `commandMode≠off`일 때 `cmdGuard: (cmd) => fence.assertCommandAllowed(cmd)` 전달.

- [ ] **Step 1: 실패 테스트 추가**

`src/agent-layer/coding-specialist.spec.ts`의 `describe('CodingSpecialist', ...)` 안에 append(기존 `registry`·`project`·`logger` 재사용):
```ts
  it('shellEnabled면 cmdGuard(=fence.assertCommandAllowed)도 전달', async () => {
    const calls: string[] = [];
    const fence2 = {
      codingAutoFlags: () => ['--allowedTools', 'Edit'],
      assertCodingWrite: () => {},
      shellEnabled: () => true,
      assertCommandAllowed: (cmd: string) => { calls.push(cmd); },
    } as any;
    const captured: any = {};
    const brain = { complete: (_p: string, _c: any, opts: any) => { captured.opts = opts; return Promise.resolve({ text: 'ok', costUsd: 0, isError: false }); } };
    const spec = new CodingSpecialist(registry, fence2, () => brain as any, logger);
    await spec.work('Dev', { id: 'tk1', area: 'src/a', instruction: 'i', status: 'PENDING', attempts: 0, gate: null }, project);
    expect(typeof captured.opts.cmdGuard).toBe('function');
    captured.opts.cmdGuard('npm test');
    expect(calls).toEqual(['npm test']);
  });

  it('shellEnabled=false면 cmdGuard 미전달(off)', async () => {
    const fence2 = { codingAutoFlags: () => [], assertCodingWrite: () => {}, shellEnabled: () => false, assertCommandAllowed: () => {} } as any;
    const captured: any = {};
    const brain = { complete: (_p: string, _c: any, opts: any) => { captured.opts = opts; return Promise.resolve({ text: 'ok', costUsd: 0, isError: false }); } };
    const spec = new CodingSpecialist(registry, fence2, () => brain as any, logger);
    await spec.work('Dev', { id: 'tk1', area: 'src/a', instruction: 'i', status: 'PENDING', attempts: 0, gate: null }, project);
    expect(captured.opts.cmdGuard).toBeUndefined();
  });
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/agent-layer/coding-specialist.spec.ts -t "cmdGuard|shellEnabled"` → FAIL.

- [ ] **Step 3: 구현**

`src/agent-layer/coding-specialist.ts`의 `brain.complete(...)` 호출을 교체(기존 cwd·extraArgs·codeGuard 유지, cmdGuard 추가):
```ts
    const r = await brain.complete(prompt, onChunk, {
      cwd: project.targetPath,
      extraArgs: flags,
      codeGuard: (p) => this.fence.assertCodingWrite(p, project.writePaths),
      // 셸 켜짐(off 아님)일 때만 주입 → off면 Bash 도구 미노출. auto/allowlist는 assertCommandAllowed가 판정.
      ...(this.fence.shellEnabled() ? { cmdGuard: (cmd: string) => this.fence.assertCommandAllowed(cmd) } : {}),
    });
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/agent-layer/coding-specialist.spec.ts` → PASS(신규 2 + 기존 전부).

- [ ] **Step 5: 커밋**

```
git add src/agent-layer/coding-specialist.ts src/agent-layer/coding-specialist.spec.ts
git commit -m "feat(phase8b2): CodingSpecialist가 shellEnabled면 cmdGuard도 전달"
```

---

### Task 6: 설정 파일 read/write 순수 함수 (brains-file · permissions-file)

**Files:**
- Modify: `src/desktop/brains-file.ts`
- Create: `src/desktop/permissions-file.ts`
- Test: `src/desktop/brains-file.spec.ts`, `src/desktop/permissions-file.spec.ts`

**Interfaces:**
- Produces(Task 7): `brains-file.ts`: `listBrains(configDir): Array<{key,provider,model,isDefault}>` · `setDefaultBrain(configDir, key): void`. `permissions-file.ts`: `getCommandMode(configDir): 'auto'|'allowlist'|'off'` · `setCommandMode(configDir, mode): void`.

- [ ] **Step 1: 실패 테스트 — brains-file**

`src/desktop/brains-file.spec.ts` 끝에 append(상단 fs/os/path·`mergeBrainProfile` 재사용 방식 동일):
```ts
import { listBrains, setDefaultBrain } from './brains-file';

describe('listBrains / setDefaultBrain', () => {
  it('두뇌 목록과 기본여부 반환', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-lb-'));
    try {
      fs.writeFileSync(path.join(dir, 'brains.json'), JSON.stringify({
        default: 'anthropic',
        brains: { claude: { provider: 'claude-cli', model: '' }, anthropic: { provider: 'anthropic-api', model: 'claude-opus-4-8' } },
      }));
      const list = listBrains(dir);
      expect(list.find((b) => b.key === 'anthropic')).toEqual({ key: 'anthropic', provider: 'anthropic-api', model: 'claude-opus-4-8', isDefault: true });
      expect(list.find((b) => b.key === 'claude')!.isDefault).toBe(false);
      expect(listBrains(path.join(dir, 'none'))).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('setDefaultBrain은 default만 바꾸고 나머지 보존', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sd-'));
    try {
      fs.writeFileSync(path.join(dir, 'brains.json'), JSON.stringify({ default: 'claude', brains: { claude: {}, anthropic: {} } }));
      setDefaultBrain(dir, 'anthropic');
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'brains.json'), 'utf8'));
      expect(raw.default).toBe('anthropic');
      expect(Object.keys(raw.brains).sort()).toEqual(['anthropic', 'claude']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: 실패 확인 → 구현 brains-file**

Run: `npx jest src/desktop/brains-file.spec.ts -t "listBrains"` → FAIL.

`src/desktop/brains-file.ts` 끝에 append:
```ts
// 두뇌 목록(설정창 드롭다운용). provider·model·기본여부.
export function listBrains(configDir: string): Array<{ key: string; provider: string; model: string; isDefault: boolean }> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'brains.json'), 'utf8'));
    const brains = raw && typeof raw.brains === 'object' && raw.brains ? raw.brains : {};
    const def = typeof raw?.default === 'string' ? raw.default : 'claude';
    return Object.keys(brains).map((key) => ({
      key,
      provider: String(brains[key]?.provider ?? ''),
      model: String(brains[key]?.model ?? ''),
      isDefault: key === def,
    }));
  } catch {
    return [];
  }
}

// 기본 두뇌 전환(default 필드만 갱신, 나머지 보존). 파일 없음/깨짐이면 no-op.
export function setDefaultBrain(configDir: string, key: string): void {
  const file = path.join(configDir, 'brains.json');
  let raw: { default?: string; brains?: Record<string, unknown> };
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (!raw || typeof raw !== 'object') return;
  raw.default = key;
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
}
```

Run: `npx jest src/desktop/brains-file.spec.ts` → PASS.

- [ ] **Step 3: 실패 테스트 — permissions-file**

`src/desktop/permissions-file.spec.ts`:
```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCommandMode, setCommandMode } from './permissions-file';

describe('permissions-file commandMode', () => {
  it('파일 없거나 미지정 → auto', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-pf-'));
    try {
      expect(getCommandMode(dir)).toBe('auto');
      fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify({ default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } }));
      expect(getCommandMode(dir)).toBe('auto');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('setCommandMode는 allow.commandMode만 갱신, 나머지 보존', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-pf2-'));
    try {
      fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify({ default: 'deny', allow: { tools: { Dev: ['Edit'] }, writePaths: ['C:/p'], denyPaths: [] } }));
      setCommandMode(dir, 'off');
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'permissions.json'), 'utf8'));
      expect(raw.allow.commandMode).toBe('off');
      expect(raw.allow.tools).toEqual({ Dev: ['Edit'] });     // 보존
      expect(raw.allow.writePaths).toEqual(['C:/p']);          // 보존
      expect(getCommandMode(dir)).toBe('off');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('파일 없을 때 setCommandMode는 골격 생성', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-pf3-'));
    try {
      setCommandMode(dir, 'allowlist');
      expect(getCommandMode(dir)).toBe('allowlist');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 4: 실패 확인 → 구현 permissions-file**

Run: `npx jest src/desktop/permissions-file.spec.ts` → FAIL(모듈 없음).

`src/desktop/permissions-file.ts`:
```ts
import * as fs from 'fs';
import * as path from 'path';

export type CommandMode = 'auto' | 'allowlist' | 'off';

// permissions.json의 allow.commandMode 읽기(없거나 깨짐 → 'auto').
export function getCommandMode(configDir: string): CommandMode {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'permissions.json'), 'utf8'));
    const m = raw?.allow?.commandMode;
    return m === 'allowlist' || m === 'off' ? m : 'auto';
  } catch {
    return 'auto';
  }
}

// allow.commandMode 부분 갱신(다른 필드 보존, 골격 없으면 생성).
export function setCommandMode(configDir: string, mode: CommandMode): void {
  const file = path.join(configDir, 'permissions.json');
  let cfg: { default: string; allow: Record<string, unknown> } = { default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') cfg = raw;
  } catch {
    // 없거나 깨짐 → 골격
  }
  if (!cfg.allow || typeof cfg.allow !== 'object') cfg.allow = { tools: {}, writePaths: [], denyPaths: [] };
  cfg.allow.commandMode = mode;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}
```

Run: `npx jest src/desktop/permissions-file.spec.ts` → PASS.

- [ ] **Step 5: 커밋**

```
git add src/desktop/brains-file.ts src/desktop/brains-file.spec.ts src/desktop/permissions-file.ts src/desktop/permissions-file.spec.ts
git commit -m "feat(phase8b2): 설정 파일 함수 — listBrains/setDefaultBrain + permissions-file getCommandMode/setCommandMode"
```

---

### Task 7: 설정창 UI 배선 (IPC · preload · settings.html)

**Files:**
- Modify: `src/desktop/main.ts`, `src/desktop/preload.ts`, `src/desktop/settings.html`

**Interfaces:** Consumes Task 6 함수 4종.

이 태스크는 Electron 메인 HTML/IPC라 단위 테스트 없음(순수 함수는 Task 6에서 검증). `npm run build`(tsc)로 타입만 확인.

- [ ] **Step 1: preload.ts — 4개 메서드 추가**

`src/desktop/preload.ts`의 `exposeInMainWorld('engram', { ... })` 안에 추가:
```ts
  listBrains: () => ipcRenderer.invoke('engram:list-brains'),
  setDefaultBrain: (key: string) => ipcRenderer.invoke('engram:set-default-brain', key),
  getCommandMode: () => ipcRenderer.invoke('engram:get-command-mode'),
  setCommandMode: (mode: string) => ipcRenderer.invoke('engram:set-command-mode', mode),
```

- [ ] **Step 2: main.ts — import + 4개 핸들러 추가**

import 추가(기존 `./api-brain` import 옆):
```ts
import { listBrains, setDefaultBrain } from './brains-file';
import { getCommandMode, setCommandMode } from './permissions-file';
```
`ipcMain.handle('engram:save-api-key', ...)` 아래에 추가:
```ts
  ipcMain.handle('engram:list-brains', () => listBrains(configDir));
  ipcMain.handle('engram:set-default-brain', (_e, key: string) => { setDefaultBrain(configDir, key); });
  ipcMain.handle('engram:get-command-mode', () => getCommandMode(configDir));
  ipcMain.handle('engram:set-command-mode', (_e, mode: string) => { setCommandMode(configDir, mode as 'auto' | 'allowlist' | 'off'); });
```

- [ ] **Step 3: settings.html — 낡은 문구 수정 + 새 UI**

**(a)** `apiKeyNote` 문구 갱신(낡은 "Phase 8b" 제거). ko(현 225줄 부근)·en(현 247줄 부근):
```js
      apiKeyNote: 'Anthropic API 키 — claude CLI 없이 두뇌를 씁니다. 엔그램 하네스 두뇌도 코딩(파일 편집·명령 실행)이 됩니다. 코딩을 claude CLI가 할지 엔그램이 할지는 아래 "기본 두뇌"로 정해요.',
```
en:
```js
      apiKeyNote: 'Anthropic API key — runs the brain without the claude CLI. Engram-harness brains can code too (file edits and commands). Whether the claude CLI or Engram does the coding is set by "Default brain" below.',
```

**(b)** i18n 키 추가(ko·en 각 객체에):
```js
      defaultBrain: '기본 두뇌', harnessCli: 'CLI 하네스', harnessEngram: '엔그램 하네스',
      secCoding: '코딩', cmdMode: '명령 실행', cmdAuto: '자동', cmdAllow: '제한', cmdOff: '끔',
      cmdHint: '자동 = 아무 명령이나 실행(클로드코드처럼). 제한 = 승인 목록만. 끔 = 파일만, 명령 없음.',
```
en:
```js
      defaultBrain: 'Default brain', harnessCli: 'CLI harness', harnessEngram: 'Engram harness',
      secCoding: 'Coding', cmdMode: 'Command execution', cmdAuto: 'Auto', cmdAllow: 'Restricted', cmdOff: 'Off',
      cmdHint: 'Auto = run any command (like Claude Code). Restricted = allowlist only. Off = files only, no commands.',
```

**(c)** 두뇌 섹션(`<section id="sec-brain">`)의 `<div id="api-note">` 위(또는 아래)에 기본 두뇌 드롭다운 추가:
```html
    <div class="row" id="default-brain-row" style="margin-top:14px" hidden>
      <label style="font-size:13px" data-t="defaultBrain"></label>
      <select id="default-brain"></select>
    </div>
```

**(d)** Discord 섹션 앞(`<section id="sec-messenger">` 위)에 코딩 섹션 추가:
```html
  <section id="sec-coding">
    <h2 data-t="secCoding"></h2>
    <div class="row">
      <label style="font-size:13px" data-t="cmdMode"></label>
      <select id="cmd-mode">
        <option value="auto" data-t="cmdAuto"></option>
        <option value="allowlist" data-t="cmdAllow"></option>
        <option value="off" data-t="cmdOff"></option>
      </select>
    </div>
    <div class="hint" data-t="cmdHint"></div>
  </section>
```

**(e)** `<script>` 안(맨 아래 `refresh(); detect();` 근처)에 로딩·배선 추가:
```js
    async function loadBrains() {
      const brains = await window.engram.listBrains();
      const sel = $('default-brain');
      sel.textContent = '';
      const cli = brains.filter((b) => !/^(anthropic|openai)-api$/.test(b.provider));
      const engram = brains.filter((b) => /^(anthropic|openai)-api$/.test(b.provider));
      const addGroup = (label, items) => {
        if (!items.length) return;
        const og = document.createElement('optgroup');
        og.label = label;
        for (const b of items) {
          const opt = document.createElement('option');
          opt.value = b.key;
          opt.textContent = b.model ? `${b.key} · ${b.model}` : b.key;
          if (b.isDefault) opt.selected = true;
          og.appendChild(opt);
        }
        sel.appendChild(og);
      };
      addGroup(t.harnessCli, cli);
      addGroup(t.harnessEngram, engram);
      $('default-brain-row').hidden = brains.length === 0;
    }
    $('default-brain').onchange = async () => { await window.engram.setDefaultBrain($('default-brain').value); };

    async function loadCmdMode() { $('cmd-mode').value = await window.engram.getCommandMode(); }
    $('cmd-mode').onchange = async () => { await window.engram.setCommandMode($('cmd-mode').value); };

    loadBrains();
    loadCmdMode();
```

- [ ] **Step 4: 빌드 확인**

Run: `npm run build`
Expected: tsc/nest 에러 0(preload·main 타입).
Run: `npx jest src/desktop/` → PASS(Task 6 함수 스위트 회귀 없음).

- [ ] **Step 5: 커밋**

```
git add src/desktop/main.ts src/desktop/preload.ts src/desktop/settings.html
git commit -m "feat(phase8b2): 설정창 — 코딩 명령 모드 토글 + 기본 두뇌(하네스) 드롭다운 + 낡은 코딩 문구 수정"
```

---

### Task 8: 전체 회귀 + 빌드

**Files:** 없음(검증만)

- [ ] **Step 1: 백엔드 전체**

Run: `npx jest`
Expected: PASS. fs/git 무거운 스위트(rag-store·coding-git·wiki-*)가 병렬 flaky하면 in-band 재확인(`npx jest coding-git wiki-git --runInBand`). 실 회귀면 해당 Task 복귀.

- [ ] **Step 2: 빌드**

Run: `npm run build`
Expected: nest/tsc 에러 0(shell-tool·fence·두 brain·desktop 전부).

- [ ] **Step 3: 렌더러(무변경 확인)**

Run: `npm --prefix renderer test`
Expected: PASS(8b-2는 렌더러 무변경 — 설정창은 데스크톱 HTML).

---

## Self-Review

**Spec coverage:**
- §3 Bash 도구(shell:true·타임아웃·출력상한·never-throw·기본auto) → Task 1. ✅
- §5 안전모델(타임아웃 트리종료·출력상한·never-throw·git격리 재사용·opt-in 제한) → Task 1(트리종료/상한)·Task 2(commandMode). ✅
- §6.1 shell-tool.ts 시그니처·BASH_TOOL_DEF → Task 1. ✅
- §6.2 CompleteOpts.cmdGuard → Task 1. ✅
- §6.3 assertCommandAllowed/shellEnabled/DEFAULT_COMMANDS(auto/allowlist/off·연산자거부·basename) → Task 2. ✅
- §6.4 CodingSpecialist cmdGuard(shellEnabled일 때) → Task 5. ✅
- §7 루프 통합(coding toolDefs+Bash·executor 라우팅) → Task 3(anthropic)·Task 4(openai). ✅
- §8 재사용 무변경(VerificationGate·CodingGit·Orchestrator) → 건드리는 Task 없음. ✅
- §9.1 코딩 명령 모드 토글 → Task 6(setCommandMode/getCommandMode)·Task 7(UI). ✅
- §9.2 기본 두뇌 드롭다운(하네스별) → Task 6(listBrains/setDefaultBrain)·Task 7(UI optgroup). ✅
- §9.3 낡은 문구 수정 → Task 7 Step 3(a). ✅
- §9.4 파일 함수 유닛테스트 → Task 6. ✅
- §10 테스트 전략 → 각 Task. ✅
- §11 불변식 1~7 → Task 1(2·3·5)·Task 2(1·4)·Task 3/4(회귀6)·Task 5(4)·재사용(7). ✅

**Placeholder scan:** "적절히"류 없음. 상수 확정(120000·20000·DEFAULT_COMMANDS). ✅

**Type consistency:**
- `CommandGuard = (command: string) => void` — Task 1 정의, Task 3/4 executor(`opts.cmdGuard`), Task 5(`(cmd) => fence.assertCommandAllowed`) 동일. ✅
- `runShellTool(input, cwd, guard, signal)` — Task 1 정의, Task 3/4 호출 동일 인자순. ✅
- `BASH_TOOL_DEF: WebToolDef`(name 'Bash') — Task 1, Task 3/4 toolDefs·라우팅('Bash') 동일. ✅
- `CompleteOpts.cmdGuard?: (command: string) => void` — Task 1, Task 3/4/5 동일. ✅
- `shellEnabled()`·`assertCommandAllowed(command)` — Task 2 정의, Task 5 사용 동일. ✅
- `listBrains(configDir)`→`{key,provider,model,isDefault}[]`·`setDefaultBrain(configDir,key)`·`getCommandMode(configDir)`·`setCommandMode(configDir,mode)` — Task 6 정의, Task 7(main 핸들러·settings.html) 사용 동일. ✅

**주의(구현자용):**
- Task 3/4의 목 fetch는 **첫 호출=Bash tool_use 턴, 둘째=최종 텍스트 턴**(call 카운터). Bash 실행은 실제 `node -e` 서브프로세스(안전·빠름)라 fetch와 무관.
- 8b-1 코딩 테스트(cwd+codeGuard, **cmdGuard 없음**)는 Bash 미노출이라 `tools=['Read'..'Grep']` 그대로 통과 — 회귀 아님.
- Task 7은 유닛테스트 없음(Electron HTML). 실 설정창 스모크는 수동(별도).
- `runShellTool`은 POSIX에서 `detached:true`로 프로세스그룹을 만들어 `-pid` 트리 kill; Win은 `taskkill /T /F`. cross-spawn이 옵션 관통.
