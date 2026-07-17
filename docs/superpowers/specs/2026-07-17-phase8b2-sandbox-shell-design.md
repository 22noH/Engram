# Phase 8b-2 — 엔그램 하네스 명령 실행(Run) 도구 설계

## 1. 목표 · 배경

8b-1에서 엔그램 하네스 두뇌(`anthropic-api`·`openai-api`)가 파일 도구루프(Read/Write/Edit/Glob/Grep)로 코딩하게 됐다. **셸(명령 실행)은 "울타리를 빠져나간다"는 이유로 의도적으로 뺐다**(§8b-1 스펙 §2, §5). 8b-2는 두뇌가 **자기가 정한 명령을 스스로 돌려 결과를 보고 고치는** 능력을 준다 — 예: 특정 테스트만 돌려보기, 린터 돌리기, 빌드 확인.

기존 자산: `VerificationGate`가 이미 `cross-spawn`으로 명령을 실행하지만(`shell:true`), **사람이 승인한 프로젝트 config(typecheck/build/test)만** 돈다. 두뇌가 임의 명령을 못 넣는다. 8b-2는 두뇌가 명령을 넣되 **기본 거부 허용목록 + 타임아웃 강제종료 + 출력 상한**으로 안전하게 가둔다. 코딩은 무인(자동) 흐름이라 "명령마다 사람 확인"이 아니라 **허용목록이 그 자리를 대신**한다.

## 2. 핵심 결정 (읽고 넘어갈 것)

**(가) "셸"이 아니라 "프로그램 실행(Run)".** 두뇌에게 셸 문자열을 주지 않는다. 도구 입력은 `{ command: string, args?: string[] }` 구조이고 **셸 없이(`shell:false`)** 실행한다. → `&&`·`|`·`;`·리다이렉트 같은 명령 체이닝/주입이 **구조적으로 불가능**하다(허용목록이 느슨해도 안전). 파이프가 필요한 워크플로는 8b-2 비범위(검증용 명령엔 거의 불필요).

**(나) 네트워크 하드 차단은 8b-2 범위 밖(정직).** 순수 TS로 Windows에서 프로세스별 네트워크 차단은 사실상 OS 샌드박스(full C, 네이티브)를 요구한다. 8b-2는 이를 만들지 않는다. 대신 **허용목록이 네트워크 통제 역할**을 한다 — `curl`·`wget` 등 네트워크 실행파일을 허용목록에 안 넣으면 임의 네트워크 명령이 애초에 안 돈다. 진짜 네트워크 격리는 full-C/후속.

**(다) 하이브리드의 실 구성 = 허용목록(기본 거부) + 타임아웃 트리 강제종료 + 출력 상한 + cwd + (이미 있는)git 브랜치 격리.** Job Object 자원상한은 네이티브라 미도입 — 트리 강제종료가 폭주(무한루프·포크밤 지속)를 끊는다.

## 3. 범위

**포함(8b-2)**
- 새 `Run` 도구(coding 모드): `{ command, args? }`를 `shell:false`로 cwd에서 실행, 타임아웃 트리종료·출력상한·never-throw.
- `PermissionFence`에 명령 허용목록(기본 거부) + `assertCommandAllowed`.
- `CompleteOpts.cmdGuard` 주입 필드. API 두뇌 coding 루프가 `cmdGuard` 있을 때만 `Run` 도구 노출.
- `CodingSpecialist`가 `codeGuard`와 함께 `cmdGuard`도 전달.

**비포함**
- 네트워크 하드 차단·OS 샌드박스(AppContainer/컨테이너/VM) → full-C, 후속.
- Job Object 자원상한(메모리/CPU) → 네이티브, 후속.
- 셸 기능(파이프·리다이렉트·명령 체이닝) → 구조적으로 미제공(결정 가).
- 사람 승인 경로(허용목록 밖 명령을 "승인함"에 쌓기) → 대화형 코딩 UI 필요, 후속.
- CLI 두뇌(claude-cli 등)의 셸 → 그들 하네스가 이미 처리, 무변경.
- `VerificationGate`·`CodingGit`·`Orchestrator` 로직 변경 → 무변경 재사용.

## 4. 아키텍처

8b-1과 동일한 **주입 패턴**. 명령 허용 판정은 `PermissionFence`에만 있고, `src/brain`은 함수로 받아 부른다.

```
CodingSpecialist (agent-layer)
  ├─ codeGuard = (p) => fence.assertCodingWrite(p, project.writePaths)   ← 8b-1(쓰기)
  └─ cmdGuard  = (cmd) => fence.assertCommandAllowed(cmd)                ← 8b-2(명령, 신규)
        │  brain.complete(prompt, onChunk, { cwd, extraArgs, codeGuard, cmdGuard })
API 두뇌 (src/brain)
  └─ opts.cwd + codeGuard → coding 루프. cmdGuard도 있으면 도구셋에 Run 추가.
        toolDefs = CODING_TOOL_DEFS + (cmdGuard ? [RUN_TOOL_DEF] : [])
        executor: name==='Run' ? runShellTool(input, cwd, cmdGuard, signal) : executeCodingTool(...)
shell-tool.ts (src/brain, 신규): 프로세스 spawn(shell:false)·타임아웃 트리종료·출력상한. never-throw.
```

## 5. 안전 모델

- **기본 거부 허용목록**: `Run`의 `command`(실행파일)가 fence 허용목록에 없으면 거부(에러 텍스트로 되먹임). config 비면 전부 거부(안전 기본). 허용목록은 사람이 permissions.json에 넣는다(예: `npm`·`pnpm`·`yarn`·`node`·`pytest`·`go`·`cargo`·`tsc`). `curl`·`wget`·`git` 등은 기본 미포함(사용자가 원하면 추가).
- **셸 없음(구조적 주입 차단)**: `spawn(command, args, { shell: false, cwd })`. 셸 미개입 → `&&`/`|`/리다이렉트 불가. `command`에 공백·연산자를 욱여넣어도 그런 이름의 실행파일이 없어 실패(무해).
- **타임아웃 트리 강제종료**: 명령별 타임아웃(상수, 기본 120s) + 루프의 `AbortSignal`. 둘 중 먼저 발동 시 **프로세스 트리 전체**를 죽인다(Win=`taskkill /T /F /PID`, POSIX=프로세스그룹 kill). → 폭주·행 방지. 8a 교훈대로 도구 실행이 루프 타임아웃을 무시하지 않는다.
- **출력 상한**: stdout+stderr 합쳐 마지막 N자(예: 20k)만 반환(컨텍스트 폭발 방지). 종료코드도 함께.
- **git 브랜치 격리(이미 있음)**: `CodingGit`가 코딩을 격리 브랜치에서 한다 → 명령이 저장소 안을 망쳐도 브랜치 폐기로 복구. 8b-2는 이를 재사용(무변경).
- **네트워크**: 하드 차단 안 함(결정 나). 허용목록이 임의 네트워크 실행파일을 막는 게 실질 통제.
- **never-throw**: 명령 실패(비영 종료·타임아웃·미허용·spawn 실패)는 던지지 않고 종료코드+출력 텍스트로 되먹임. 두뇌가 보고 판단.

## 6. 인터페이스

### 6.1 `shell-tool.ts` (src/brain, 신규)

```ts
import { WebToolDef } from './web-tools';

export const MAX_SHELL_TIMEOUT_MS = 120_000;   // 명령별 타임아웃 상한
export const SHELL_OUTPUT_LIMIT = 20_000;      // 반환 출력 마지막 N자

// 명령 허용 판정(막히면 throw). agent-layer가 fence.assertCommandAllowed를 바인딩해 주입.
export type CommandGuard = (command: string) => void;

export const RUN_TOOL_DEF: WebToolDef; // name 'Run', { command: string, args?: string[] }

// 실행 — never-throw. cwd에서 shell:false로 실행, 타임아웃/abort 시 트리 강제종료, 출력 상한.
export async function runShellTool(
  input: unknown,
  cwd: string,
  guard: CommandGuard,
  signal: AbortSignal,
): Promise<string>;
```

`RUN_TOOL_DEF` 설명(모델용): "Run an allowed program with arguments in the working directory. No shell — no pipes, redirects, or command chaining; give the executable as `command` and each argument as a separate `args` entry. Only allowlisted programs run."

동작:
1. 인자 검증: `command` 문자열 필수, `args`는 문자열 배열(없으면 `[]`). 아니면 에러 텍스트.
2. `guard(command)` — 막히면 `Run blocked: <이유>` 텍스트.
3. `spawn(command, args, { cwd, shell: false, stdio: ['ignore','pipe','pipe'] })`(cross-spawn). stdout/stderr 수집.
4. 명령별 타임아웃 타이머(`MAX_SHELL_TIMEOUT_MS`) 또는 루프의 `signal` abort — **둘 중 먼저** 발동하면 트리 강제종료, `[timeout] ...` 반환. (루프 전체 타임아웃은 이미 그 signal이 관리하므로 잔여시간 계산은 불필요.)
5. 정상 종료 → `[exit <code>]\n<output 마지막 SHELL_OUTPUT_LIMIT자>` 반환.
6. spawn 자체 실패(실행파일 없음 등) → `Run error: <메시지>`.

트리 종료 헬퍼: Win=`taskkill /pid <pid> /T /F`, POSIX=detached spawn + `process.kill(-pid)`(또는 동등). (플랜에서 `tree-kill` 의존 도입 여부 결정 — 소형이면 인라인.)

### 6.2 `CompleteOpts` 추가 (`brain.port.ts`)

```ts
export interface CompleteOpts {
  cwd?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  delegate?: DelegateHandle;
  codeGuard?: (absPath: string) => void;
  cmdGuard?: (command: string) => void; // Phase 8b-2: 명령 허용 판정(주입). 있으면 coding 루프가 Run 도구 노출.
}
```

### 6.3 `PermissionFence` 추가 (`permission-fence.ts`)

`FenceConfig.allow`에 `commands: string[]` 추가(기본 `[]`). `EMPTY()`도 `commands: []`.

```ts
// 명령 실행 허용 판정(기본 거부). command의 실행파일 이름(basename, 확장자 무시)이 허용목록에 있어야 함.
assertCommandAllowed(command: string): void {
  const exe = path.basename(command).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
  const allow = (this.cfg.allow.commands ?? []).map((c) => c.toLowerCase());
  if (!allow.includes(exe)) {
    throw new Error(`허용되지 않은 명령: ${command} (permissions.json allow.commands에 "${exe}" 추가 필요)`);
  }
}
```

(`command`가 `../evil` 같은 경로여도 basename만 비교 — 경로로 우회한 실행파일도 이름 기준. 절대경로 실행파일도 basename으로 판정.)

### 6.4 `CodingSpecialist` 배선

```ts
const r = await brain.complete(prompt, onChunk, {
  cwd: project.targetPath,
  extraArgs: flags,
  codeGuard: (p) => this.fence.assertCodingWrite(p, project.writePaths),
  cmdGuard: (cmd) => this.fence.assertCommandAllowed(cmd), // Phase 8b-2
});
```

CLI 두뇌는 `cmdGuard` 무시(자기 셸 사용). API 두뇌만 `cmdGuard`로 Run 도구 활성.

## 7. 루프 통합 (API 두뇌 `complete()`)

coding 갈래에서 toolDefs·executor에 Run을 얹는다(8b-1 갈래에 추가):

```ts
const toolDefs: WebToolDef[] = coding
  ? [...CODING_TOOL_DEFS, ...(opts!.cmdGuard ? [RUN_TOOL_DEF] : [])]
  : [...WEB_TOOL_DEFS, ...(opts?.delegate ? [askBrainDef(opts.delegate.brains)] : [])];
const executor = coding
  ? (name, input) => name === 'Run'
      ? runShellTool(input, opts!.cwd!, opts!.cmdGuard!, ctrl.signal)
      : executeCodingTool(name, input, opts!.cwd!, opts!.codeGuard!, ctrl.signal)
  : (name, input) => name === 'ask_brain' ? runAskBrain(...) : executeWebTool(...);
```

`codeGuard`는 있는데 `cmdGuard`가 없으면: 코딩은 파일 도구로만(Run 미노출). `cmdGuard`만 있고 `codeGuard`가 없는 경우는 없음(CodingSpecialist가 둘 다 준다). 두 provider(anthropic·openai) 동일.

## 8. 재사용 (무변경)

- `VerificationGate` — 게이트는 여전히 typecheck/build/test를 **직접** 돈다(§8.1 자기보고 불신). Run은 두뇌의 반복용이지 게이트 대체가 아님. 무변경.
- `CodingGit` — 격리 브랜치(복구 경로). 무변경.
- `Orchestrator` — 코딩 재시도 루프. 무변경.
- CLI 두뇌 3종 — 무변경.

## 9. 테스트 전략

실 위험 명령 금지. 크로스플랫폼 안전 명령만(예: `node -e "..."`).

- **shell-tool.ts**(단위):
  - 허용 명령 정상 실행 → `[exit 0]` + stdout 포함(예: `node -e "console.log('hi')"` → 'hi'). `args` 배열 그대로 전달.
  - 미허용 명령(guard throw) → `Run blocked` 텍스트, spawn 안 함.
  - 비영 종료코드 → `[exit N]` + stderr 포함(에러 아님, never-throw).
  - 타임아웃 → 트리 종료 + `[timeout]`(예: `node -e "setTimeout(()=>{},999999)"` + 짧은 타임아웃/즉시 abort).
  - abort(signal) 관통 → 실행 중 abort 시 종료.
  - 오염 인자(command 누락·args 비배열) → 에러 텍스트.
  - 셸 없음 확인: `command`에 `"node -e x && whatever"` 통짜 → 그런 실행파일 없어 spawn 실패(체이닝 안 됨).
  - 출력 상한: 큰 출력 → 마지막 N자만.
- **PermissionFence.assertCommandAllowed**: 허용목록 안 통과·밖 throw·빈 목록 전부 throw·basename/확장자 정규화(`npm.cmd`→`npm`).
- **API 두뇌 Run 경로**(anthropic·openai 각): `fetchFn` 주입 SSE로 Run tool_use 흘림 + `cmdGuard` 스텁 + 안전 명령 → 실제 실행되고 결과 되먹임. `cmdGuard` 없으면 Run 미노출(도구목록에 파일도구만). 채팅 회귀 0.
- **CodingSpecialist**: complete에 `cmdGuard`가 `codeGuard`와 함께 넘어가는지(스텁 두뇌 opts 캡처).

## 10. 불변식

1. **기본 거부** — 허용목록에 없는 명령은 안 돈다(config 비면 전부 거부).
2. **셸 없음** — 파이프/리다이렉트/체이닝 구조적 불가(shell:false + 구조적 입력).
3. **타임아웃 관통** — 하나의 AbortController가 모델 호출과 명령 실행까지 커버, 초과 시 트리 강제종료.
4. **never-throw** — 명령 실행은 어떤 입력·실패에도 예외 대신 텍스트 반환.
5. **가드 없으면 Run 없음** — `cmdGuard` 미주입이면 Run 도구 미노출.
6. **회귀 0** — 채팅 경로·CLI 두뇌·8b-1 파일도구·기본 provider 값 무변경.
7. **게이트 불신 유지** — 최종 검증은 VerificationGate가 직접(Run은 두뇌 보조용).

## 11. 비범위 (후속)

- **네트워크 하드 차단·OS 샌드박스**(AppContainer/컨테이너/VM) = full-C. untrusted 코드 격리 실행이 필요해지면.
- **Job Object 자원상한**(메모리/CPU 캡).
- **셸 기능**(파이프·리다이렉트) — 필요 신호 오면 별도 설계.
- **사람 승인 경로**(허용목록 밖 명령 제안→승인) — 대화형 코딩 UI와 함께.
- **인자 수준 허용목록**(`npm test`는 되고 `npm publish`는 안 되게) — 지금은 실행파일 수준.
