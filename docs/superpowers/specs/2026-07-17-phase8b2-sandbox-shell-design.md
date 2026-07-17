# Phase 8b-2 — 엔그램 하네스 명령 실행(Bash) 도구 설계

## 1. 목표 · 배경

8b-1에서 엔그램 하네스 두뇌(`anthropic-api`·`openai-api`)가 파일 도구루프로 코딩하게 됐다. **셸(명령 실행)은 의도적으로 뺐다** — 8b-2로 미뤘다. 8b-2는 두뇌가 **자기가 정한 명령을 스스로 돌려 결과를 보고 고치는** 능력을 준다(테스트·빌드·린트 실행 등).

**기본 철학 = Claude Code 자동모드 parity.** 개인용 단일 사용자가 자기 프로젝트를 코딩시키는 도구다. 매번 명령을 허락받거나 목록을 관리하게 하지 않는다 — **기본은 두뇌가 아무 명령이나 그냥 실행**(auto). 진짜 안전망은 명령 제한이 아니라 **이미 있는 git 브랜치 격리**(무엇을 하든 임시 공간, 사용자가 확인·병합 전까지 실제 코드 무영향)다. 명령 제한은 원하는 사람만 켜는 opt-in.

기존 자산: `VerificationGate`가 `cross-spawn`으로 명령을 실행(`shell:true`)하지만 사람 승인 config(typecheck/build/test)만 돈다. 8b-2는 두뇌가 명령을 넣게 하되, 사고 방지 장치(타임아웃 강제종료·출력 상한)만 두르고 auto로 실행한다.

## 2. 핵심 결정 (읽고 넘어갈 것)

**(가) 기본 = 자동 실행(Claude Code 자동모드 동일).** 두뇌가 `{ command }` 셸 명령을 넣으면 **진짜 셸로 그대로 실행**(`shell:true` — 파이프·`&&`·리다이렉트 다 됨). 허락·목록 관리 없음. 이게 default.

**(나) 안전장치 = "제한"이 아니라 "사고 방지"만.** 명령을 막지 않는다. 대신 ①**git 브랜치 격리**(이미 있음 — 되돌림) ②**타임아웃 트리 강제종료**(멈춘 명령·폭주 차단) ③**출력 상한**(컨텍스트 폭발 차단) ④**never-throw**. 이것들은 무엇이 실행되는지 제한하지 않으므로 auto와 공존한다.

**(다) 제한은 opt-in(기본 꺼짐).** 공유 서버처럼 남이 코딩을 트리거하거나 조심하고 싶은 경우만 `permissions.json`에서 `commandMode`를 바꾼다: `auto`(기본, 다 실행)·`allowlist`(승인 목록만)·`off`(셸 완전 비활성=8b-1 상태). 대부분 사용자는 안 건드린다.

**(라) 네트워크 하드 차단·OS 샌드박스는 8b-2 범위 밖.** 순수 TS로 Windows 프로세스별 네트워크 차단은 사실상 샌드박스(full-C, 네이티브)를 요구한다. auto는 인터넷도 된다(Claude Code처럼). 진짜 격리(untrusted 코드 실행)는 full-C/후속.

## 3. 범위

**포함(8b-2)**
- 새 `Bash` 도구(coding 모드): `{ command: string }`를 `shell:true`로 cwd에서 실행, 타임아웃 트리종료·출력상한·never-throw. **기본 auto.**
- `PermissionFence`에 `commandMode`(auto/allowlist/off) + `assertCommandAllowed`(auto면 통과). opt-in allowlist용 `commands`(내장 기본목록 있음).
- `CompleteOpts.cmdGuard` 주입 필드. coding 루프가 `cmdGuard` 있을 때만 `Bash` 노출(=`off`면 미노출).
- `CodingSpecialist`가 `codeGuard`와 함께 `cmdGuard`도 전달(모드 `off`가 아니면).

**비포함**
- 네트워크 하드 차단·OS 샌드박스(AppContainer/컨테이너/VM) → full-C, 후속.
- Job Object 자원상한(메모리/CPU) → 네이티브, 후속.
- 사람 승인 경로(명령을 "승인함"에 쌓기) → 대화형 코딩 UI 필요, 후속.
- 인자 수준 세밀 제한(allowlist 모드에서 `npm test`는 되고 `npm publish`는 안 되게) → 실행파일 수준.
- CLI 두뇌(claude-cli 등)의 셸 → 그들 하네스가 이미 처리, 무변경.
- `VerificationGate`·`CodingGit`·`Orchestrator` 로직 변경 → 무변경 재사용.

## 4. 아키텍처

8b-1과 동일한 주입 패턴. 명령 판정은 `PermissionFence`에만 있고 `src/brain`은 함수로 받아 부른다. **auto 모드에선 그 함수가 무조건 통과**하므로 사실상 제약 없이 실행.

```
CodingSpecialist (agent-layer)
  ├─ codeGuard = (p) => fence.assertCodingWrite(p, project.writePaths)   ← 8b-1(쓰기)
  └─ commandMode ≠ 'off' 이면:
        cmdGuard = (cmd) => fence.assertCommandAllowed(cmd)              ← 8b-2(명령)
        │  auto: 즉시 통과 / allowlist: 목록 검사 / off: cmdGuard 미주입
        │  brain.complete(prompt, onChunk, { cwd, extraArgs, codeGuard, cmdGuard })
API 두뇌 (src/brain)
  └─ opts.cwd + codeGuard → coding 루프. cmdGuard 있으면 도구셋에 Bash 추가.
        toolDefs = CODING_TOOL_DEFS + (cmdGuard ? [BASH_TOOL_DEF] : [])
        executor: name==='Bash' ? runShellTool(input, cwd, cmdGuard, signal) : executeCodingTool(...)
shell-tool.ts (src/brain, 신규): shell:true spawn·타임아웃 트리종료·출력상한. never-throw.
```

## 5. 안전 모델

- **기본 auto = 명령 그대로 실행**: `spawn(command, [], { cwd, shell: true, stdio: ['ignore','pipe','pipe'] })`(cross-spawn, `VerificationGate`와 동일 방식). 파이프·체이닝 그대로 동작.
- **git 브랜치 격리(주 안전망, 이미 있음)**: `CodingGit`가 코딩을 격리 브랜치에서 한다 → 명령이 저장소를 망쳐도 브랜치 폐기로 복구. 8b-2 무변경 재사용. **이게 진짜 되돌림 장치.**
- **타임아웃 트리 강제종료**: 명령별 타임아웃(상수, 기본 120s) 또는 루프 `signal` abort — 먼저 발동 시 **프로세스 트리 전체** kill(Win=`taskkill /T /F /PID`, POSIX=프로세스그룹 kill). 폭주·행 차단. 8a 교훈대로 도구 실행이 루프 타임아웃을 무시하지 않는다.
- **출력 상한**: stdout+stderr 마지막 N자(예: 20k)만 반환 + 종료코드.
- **never-throw**: 명령 실패(비영 종료·타임아웃·spawn 실패·모드거부)는 던지지 않고 텍스트로 되먹임.
- **opt-in 제한(`commandMode`)**: 기본 `auto`(다 실행). `allowlist`면 명령의 실행파일이 목록(내장 기본값 또는 사용자 지정)에 있어야 하고 셸 연산자(`&& | ; > < \` $(`)가 있으면 거부(단일 명령만). `off`면 `Bash` 도구 자체를 안 준다(8b-1 상태).
- **네트워크**: auto는 됨(제한 안 함). 진짜 격리는 full-C/후속.

**솔직한 한계**: auto = 풀파워 = 풀리스크(Claude Code 자동모드 동일). 명령이 저장소 밖·시스템·네트워크를 건드리는 걸 auto에선 막지 않는다. 실질 방어는 git 브랜치 격리 + 사용자가 병합 전 확인. 더 강한 격리가 필요하면 `allowlist`/`off` 또는 후속 full-C.

## 6. 인터페이스

### 6.1 `shell-tool.ts` (src/brain, 신규)

```ts
import { WebToolDef } from './web-tools';

export const MAX_SHELL_TIMEOUT_MS = 120_000;   // 명령별 타임아웃
export const SHELL_OUTPUT_LIMIT = 20_000;      // 반환 출력 마지막 N자

// 명령 판정(막히면 throw). agent-layer가 fence.assertCommandAllowed를 바인딩해 주입. auto 모드면 사실상 no-op.
export type CommandGuard = (command: string) => void;

export const BASH_TOOL_DEF: WebToolDef; // name 'Bash', { command: string }

// 실행 — never-throw. cwd에서 shell:true로 실행, 타임아웃/abort 시 트리 강제종료, 출력 상한.
export async function runShellTool(
  input: unknown,
  cwd: string,
  guard: CommandGuard,
  signal: AbortSignal,
): Promise<string>;
```

`BASH_TOOL_DEF` 설명(모델용): "Run a shell command in the working directory and return its combined output and exit code. Use it to run tests, builds, linters, or any command needed to verify your changes."

동작:
1. 인자 검증: `command` 문자열 필수(없으면 에러 텍스트).
2. `guard(command)` — 막히면 `Bash blocked: <이유>`(auto 모드면 통과).
3. `spawn(command, [], { cwd, shell: true, stdio: ['ignore','pipe','pipe'] })`. stdout/stderr 수집.
4. 명령별 타임아웃 타이머(`MAX_SHELL_TIMEOUT_MS`) 또는 루프 `signal` abort — 먼저 발동 시 트리 강제종료, `[timeout] ...` 반환.
5. 정상 종료 → `[exit <code>]\n<output 마지막 SHELL_OUTPUT_LIMIT자>`.
6. spawn 자체 실패 → `Bash error: <메시지>`.

트리 종료 헬퍼: Win=`taskkill /pid <pid> /T /F`, POSIX=detached spawn + `process.kill(-pid)`. (플랜에서 `tree-kill` 의존 도입 여부 결정 — 소형이면 인라인.)

### 6.2 `CompleteOpts` 추가 (`brain.port.ts`)

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

### 6.3 `PermissionFence` 추가 (`permission-fence.ts`)

`FenceConfig.allow`에 `commandMode?: 'auto' | 'allowlist' | 'off'`(기본 `'auto'`) + `commands?: string[]`(allowlist용, 없으면 내장 기본값) 추가.

```ts
// allowlist 모드에서 쓰는 내장 기본 허용목록(사용자가 allow.commands 지정 안 하면 이걸 씀).
export const DEFAULT_COMMANDS = [
  'npm','pnpm','yarn','npx','node','deno','bun','python','python3','pytest','go','cargo','rustc',
  'dotnet','msbuild','cmake','make','nmake','qmake','tsc','jest','vitest','eslint','prettier','gradle','mvn',
];

// 셸 켜짐 여부(off면 Bash 도구 미노출). CodingSpecialist가 cmdGuard 주입 판단에 사용.
shellEnabled(): boolean {
  return (this.cfg.allow.commandMode ?? 'auto') !== 'off';
}

// 명령 판정. auto=무조건 통과, off=무조건 거부(도구 자체는 안 나오지만 방어), allowlist=목록+연산자 검사.
assertCommandAllowed(command: string): void {
  const mode = this.cfg.allow.commandMode ?? 'auto';
  if (mode === 'auto') return;
  if (mode === 'off') throw new Error('셸이 비활성화됨(commandMode: off)');
  // allowlist: 셸 연산자 있으면 거부(단일 명령만), 실행파일 이름이 목록에 있어야 함.
  if (/[&|;<>`]|\$\(/.test(command)) throw new Error(`allowlist 모드에선 셸 연산자 금지: ${command}`);
  const exe = command.trim().split(/\s+/)[0];
  const base = exe.replace(/.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
  const allow = (this.cfg.allow.commands ?? DEFAULT_COMMANDS).map((c) => c.toLowerCase());
  if (!allow.includes(base)) {
    throw new Error(`허용되지 않은 명령: ${command} (permissions.json allow.commands에 "${base}" 추가 필요)`);
  }
}
```

### 6.4 `CodingSpecialist` 배선

```ts
const r = await brain.complete(prompt, onChunk, {
  cwd: project.targetPath,
  extraArgs: flags,
  codeGuard: (p) => this.fence.assertCodingWrite(p, project.writePaths),
  // 셸 켜짐(off 아님)일 때만 주입 → off면 Bash 도구 미노출. auto/allowlist면 assertCommandAllowed가 판정.
  ...(this.fence.shellEnabled() ? { cmdGuard: (cmd: string) => this.fence.assertCommandAllowed(cmd) } : {}),
});
```

CLI 두뇌는 `cmdGuard` 무시(자기 셸 사용). API 두뇌만 `cmdGuard`로 Bash 활성.

## 7. 루프 통합 (API 두뇌 `complete()`)

coding 갈래 toolDefs·executor에 Bash를 얹는다(8b-1 갈래에 추가):

```ts
const toolDefs: WebToolDef[] = coding
  ? [...CODING_TOOL_DEFS, ...(opts!.cmdGuard ? [BASH_TOOL_DEF] : [])]
  : [...WEB_TOOL_DEFS, ...(opts?.delegate ? [askBrainDef(opts.delegate.brains)] : [])];
const executor = coding
  ? (name, input) => name === 'Bash'
      ? runShellTool(input, opts!.cwd!, opts!.cmdGuard!, ctrl.signal)
      : executeCodingTool(name, input, opts!.cwd!, opts!.codeGuard!, ctrl.signal)
  : (name, input) => name === 'ask_brain' ? runAskBrain(...) : executeWebTool(...);
```

두 provider(anthropic·openai) 동일.

## 8. 재사용 (무변경)

- `VerificationGate` — 최종 검증(typecheck/build/test)은 여전히 **직접** 돈다(§8.1 자기보고 불신). Bash는 두뇌의 반복용이지 게이트 대체가 아님. 무변경.
- `CodingGit` — 격리 브랜치(주 안전망). 무변경.
- `Orchestrator` — 코딩 재시도 루프. 무변경.
- CLI 두뇌 3종 — 무변경.

## 9. 테스트 전략

실 위험 명령 금지. 크로스플랫폼 안전 명령만(예: `node -e "..."`).

- **shell-tool.ts**(단위):
  - auto 가드(통과)로 명령 실행 → `[exit 0]` + stdout 포함(`node -e "console.log('hi')"` → 'hi').
  - 파이프/체이닝 실제 동작(auto): `node -e "console.log(1)" && node -e "console.log(2)"` → 둘 다.
  - 비영 종료 → `[exit N]` + stderr(never-throw).
  - 타임아웃 → 트리 종료 + `[timeout]`(긴 sleep + 짧은 타임아웃/즉시 abort).
  - abort(signal) 관통.
  - 오염 인자(command 누락) → 에러 텍스트.
  - 출력 상한: 큰 출력 → 마지막 N자만.
  - guard가 throw(allowlist/off 시뮬) → `Bash blocked`, spawn 안 함.
- **PermissionFence.assertCommandAllowed/shellEnabled**: auto→전부 통과·off→throw+shellEnabled false·allowlist(연산자 거부·목록 밖 throw·목록 안 통과·basename 정규화).
- **API 두뇌 Bash 경로**(anthropic·openai 각): `fetchFn` 주입 SSE로 Bash tool_use + auto `cmdGuard` 스텁 + 안전 명령 → 실행·되먹임. `cmdGuard` 없으면(off) Bash 미노출. 채팅 회귀 0.
- **CodingSpecialist**: shellEnabled=true면 cmdGuard 주입, false면 미주입(스텁 fence로 opts 캡처).

## 10. 불변식

1. **기본 auto** — 기본값에선 두뇌가 아무 명령이나 실행(Claude Code 자동모드 parity). 제한은 opt-in.
2. **타임아웃 관통** — 하나의 AbortController가 모델 호출과 명령 실행까지 커버, 초과 시 트리 강제종료.
3. **never-throw** — 명령 실행은 어떤 입력·실패에도 예외 대신 텍스트 반환.
4. **셸 끄기 가능** — `commandMode: off`면 Bash 도구 미노출(8b-1 상태).
5. **회귀 0** — 채팅 경로·CLI 두뇌·8b-1 파일도구·기본 provider 값 무변경.
6. **게이트 불신 유지** — 최종 검증은 VerificationGate가 직접(Bash는 두뇌 보조용).
7. **되돌림은 git** — 주 안전망은 CodingGit 격리 브랜치(무변경 재사용).

## 11. 비범위 (후속)

- **네트워크 하드 차단·OS 샌드박스**(AppContainer/컨테이너/VM) = full-C. untrusted 코드 격리 실행 시.
- **Job Object 자원상한**(메모리/CPU).
- **사람 승인 경로**(명령 제안→승인) — 대화형 코딩 UI와 함께.
- **인자 수준 세밀 제한**(allowlist 모드에서 하위명령 단위).
