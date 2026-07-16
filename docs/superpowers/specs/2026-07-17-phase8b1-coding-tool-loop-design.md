# Phase 8b-1 — 엔그램 하네스 코딩 도구루프 설계

## 1. 목표 · 배경

엔그램은 두뇌(LLM)를 provider로 갈아끼운다. provider가 곧 **하네스(에이전트 도구 루프를 누가 도느냐)** 선택이다:

- `claude-cli`·`gemini-cli`·`codex-cli` → 외부 CLI 하네스가 도구 루프를 돈다(코딩 시 CLI가 직접 파일 편집).
- `anthropic-api`·`openai-api` → **엔그램 자체 하네스**가 도구 루프를 돈다(8a에서 도입). 지금은 웹검색/웹fetch 미니 루프만 있고, **코딩(`opts.cwd`)은 거부**한다("coding requires a CLI-harness brain until Phase 8b").

모델과 하네스는 별개이고 둘 다 사용자가 `provider`로 정한다. 예: Ollama 하나를 `claude-cli`(env로 엔드포인트만 로컬) 하네스에 태울 수도, `openai-api`(엔그램) 하네스에 태울 수도 있다.

**8b-1이 하는 일**: 엔그램 하네스 두뇌(`anthropic-api`·`openai-api`)를 골랐을 때 **코딩이 실제로 되게** 한다. 거부하던 자리에 **엔그램이 직접 도는 파일 도구루프**(읽기/쓰기/편집/glob/grep)를 넣는다 — 8a 웹도구 루프와 동일 구조, 도구만 파일로. 셸은 안 준다(8b-2 샌드박스). 어느 하네스를 쓸지는 사용자가 `brains.json`의 provider로 정하는 그대로이고, 배포판 기본값(`claude-cli`)은 **바꾸지 않는다** — 강제 전환이 아니라 "엔그램 하네스를 고르면 코딩도 된다"는 **선택지 활성화**.

## 2. 범위

**포함(8b-1)**
- `coding-tools.ts`(src/brain): 파일 도구 5종 스키마 + never-throw 실행기.
- `anthropic-api`·`openai-api` 두뇌: `opts.cwd`+`opts.codeGuard` 있으면 코딩 도구루프를 돈다(거부 로직 대체).
- `CompleteOpts.codeGuard` 주입 필드 + `PermissionFence.assertCodingWrite` 추가.
- `CodingSpecialist`가 CLI용 플래그와 API용 `codeGuard`를 함께 넘김(하위호환).
- 코딩 루프 상한 상수.

**비포함**
- 셸/명령 실행 도구 → **8b-2**(OS 샌드박스).
- MCP 클라이언트 → **8c**.
- 배포판 기본 provider 값 변경(사용자가 `default`로 선택; 8b-1은 값 안 건드림).
- 설정창 "기본 두뇌 고르기" UI(후속).
- 지휘자(8d)가 코딩 하위작업을 다른 두뇌에 위임하는 것(후속 — 8b-1은 코딩 루프 자체만).
- `VerificationGate`·`CodingGit`·`Orchestrator`·`PersonaRegistry` 로직 변경(전부 무변경 재사용).

## 3. 아키텍처 개요

8a·8d의 **주입 패턴**을 그대로 따른다(웹도구는 `fetchFn`, 지휘자는 `delegate`를 opts로 주입 → src/brain은 agent-layer에 의존하지 않는다).

```
CodingSpecialist (agent-layer)
  ├─ prompt(코딩 규칙 포함) 구성  ← 기존
  ├─ extraArgs = codingAutoFlags(...)         ← CLI 두뇌용(기존)
  └─ codeGuard = (p) => fence.assertCodingWrite(p, project.writePaths)  ← API 두뇌용(신규)
        │
        ▼  brain.complete(prompt, onChunk, { cwd, extraArgs, codeGuard })
API 두뇌 (src/brain, anthropic-api·openai-api)
  ├─ opts.cwd 없음 → 채팅 루프(웹도구 + ask_brain)             ← 기존
  └─ opts.cwd 있음:
        ├─ codeGuard 없음 → 즉시 isError(무방비 쓰기 방지)
        └─ codeGuard 있음 → 코딩 루프(CODING_TOOL_DEFS + executeCodingTool)
                                  │ 쓰기 직전 codeGuard(absPath) 호출(막히면 에러 텍스트)
coding-tools.ts (src/brain): fs 기계 담당, 보안 판정은 주입받은 codeGuard + cwd 스코프
```

보안 판정(`assertWritable`/`assertCodingWrite`)은 `PermissionFence` **한 곳**에만 있고, src/brain은 그걸 함수로 받아 부를 뿐 `PermissionFence`를 import하지 않는다.

## 4. `coding-tools.ts` (src/brain, 신규)

web-tools.ts와 같은 꼴. 도구 정의 형태는 기존 `WebToolDef`(`{ name, description, parameters }`)를 재사용한다.

```ts
import { WebToolDef } from './web-tools'; // { name; description; parameters } — 도구 정의 공용 형태

export const MAX_CODING_ITERATIONS = 30; // 코딩은 여러 파일을 고치므로 채팅(8)보다 높게

// 쓰기 허용 판정(막히면 throw). agent-layer가 fence.assertCodingWrite를 바인딩해 주입.
export type WriteGuard = (absPath: string) => void;

export const CODING_TOOL_DEFS: WebToolDef[]; // Read, Write, Edit, Glob, Grep (아래 §4.1)

// 도구 실행 — never-throw. 실패(파일없음·가드거부·cwd밖·오염인자)는 에러 텍스트로 되먹임.
export async function executeCodingTool(
  name: string,
  input: unknown,
  cwd: string,
  guard: WriteGuard,
  signal: AbortSignal,
): Promise<string>;
```

### 4.1 도구별 동작

경로는 상대면 `cwd` 기준으로 resolve한다. **읽기 계열은 cwd 안으로 제한**, **쓰기 계열은 `guard`가 판정**.

- **Read** `{ path }` — 파일 텍스트 반환. cwd 밖이면 에러 텍스트. 큰 파일은 상한(예: 50k자)에서 잘라 "(truncated)" 표기.
- **Write** `{ path, content }` — 파일 생성/덮어쓰기. 쓰기 전 `guard(absPath)`(막히면 에러 텍스트). 부모 폴더 없으면 생성(단 부모도 guard 통과 경로 안).
- **Edit** `{ path, old_string, new_string }` — 파일에서 `old_string`을 찾아 `new_string`으로 치환. **정확히 1곳** 매치일 때만(0곳→"not found", 2곳 이상→"not unique" 에러 텍스트). 쓰기 전 `guard(absPath)`.
- **Glob** `{ pattern }` — cwd 하위에서 패턴 매치 경로 목록(cwd 상대). 결과 상한(예: 200개). cwd 밖 미포함.
- **Grep** `{ pattern, path? }` — cwd 하위(또는 지정 하위)에서 정규식 매치 라인. 결과 상한. cwd 밖 미포함.

전부 `signal.aborted`면 즉시 중단(타임아웃 관통 — 8a에서 도구 fetch까지 abort 커버한 것과 동형).

## 5. 보안 경계

- **읽기(Read·Glob·Grep)**: `cwd`(작업 대상 저장소) 안으로만. 밖(시스템 파일, 엔그램 저장소의 비밀 등)을 읽어 API 업체로 유출되는 걸 차단. CLI 하네스가 `--add-dir`로 읽기를 가두는 것과 같은 취지.
- **쓰기(Write·Edit)**: 매번 주입된 `guard`가 판정. `guard = (p) => fence.assertCodingWrite(p, project.writePaths)`:
  - `assertWritable(p)`의 하드 백스톱 재사용 — **엔그램 자기 저장소·시스템 폴더·denyPaths는 무조건 거부**(자기수정 차단 불변식).
  - `project.writePaths`가 지정되면 그 안이어야 함(CLI `--add-dir`와 동형 스코프).
- **셸 없음**: Bash/명령 실행 도구를 주지 않는다. 테스트·빌드는 에이전트가 아니라 `VerificationGate`가 직접 돈다(§8.1 자기보고 불신). 샌드박스 붙인 셸은 8b-2.
- **never-throw**: 도구 실패는 던지지 않고 에러 텍스트로 모델에 되먹여 다른 방법을 시도하게 한다(8a 계약).

### 5.1 `PermissionFence.assertCodingWrite` (신규, 추가만)

기존 메서드는 무변경. 쓰기 정책을 fence 한 곳에 유지하려는 얇은 조합 메서드:

```ts
// API 코딩 루프용 쓰기 판정: 백스톱 + 프로젝트 쓰기 스코프. 막히면 throw.
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

## 6. API 두뇌 통합 (`anthropic-api.brain.ts`·`openai-api.brain.ts`)

### 6.1 `CompleteOpts` 추가 (`brain.port.ts`)

```ts
export interface CompleteOpts {
  cwd?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  delegate?: DelegateHandle;
  codeGuard?: (absPath: string) => void; // Phase 8b-1: 코딩 쓰기 허용 판정(주입). 있으면 API 두뇌가 코딩 루프.
}
```

### 6.2 `complete()` 갈래

기존 `if (opts?.cwd) return fail('coding requires a CLI-harness brain until Phase 8b')`를 교체:

```ts
const coding = !!opts?.cwd;
if (coding && !opts!.codeGuard) {
  return fail('coding requires an injected codeGuard (PermissionFence) — set an engram-harness brain via CodingSpecialist');
}
const toolDefs = coding
  ? CODING_TOOL_DEFS
  : [...WEB_TOOL_DEFS, ...(opts?.delegate ? [askBrainDef(opts.delegate.brains)] : [])];
const executor = coding
  ? (name: string, input: unknown) => executeCodingTool(name, input, opts!.cwd!, opts!.codeGuard!, ctrl.signal)
  : (name: string, input: unknown) =>
      name === 'ask_brain' ? runAskBrain(input, opts?.delegate) : executeWebTool(name, input, this.profile, this.fetchFn, ctrl.signal);
const maxIter = coding ? MAX_CODING_ITERATIONS : MAX_TOOL_ITERATIONS;

const r = await runToolLoop(
  () => this.turn(history, onChunk, ctrl.signal, toolDefs),
  pushToolResults,          // provider별 기존 함수(anthropic tool_result / openai role:tool)
  executor,
  maxIter,
);
```

`turn()`는 도구 목록을 **인자로 받도록 리팩터**한다(현재는 내부에서 web+delegate로 조립): `turn(history, onChunk, signal, toolDefs)`. 채팅 모드의 `toolDefs`는 기존과 동일하게 조립되므로 요청 body는 그대로 → 8a·8d 테스트 회귀 없음.

두 provider 모두 동일 갈래. Anthropic은 `input_schema`, OpenAI는 `{type:'function', function}`로 매핑하는 기존 방식 유지.

## 7. `CodingSpecialist` 배선

`work()`의 `brain.complete` 호출에 `codeGuard`를 추가(CLI용 `extraArgs`는 그대로 — 각 두뇌가 자기가 아는 것만 씀):

```ts
const r = await brain.complete(prompt, onChunk, {
  cwd: project.targetPath,
  extraArgs: flags,                                              // CLI 두뇌용(기존)
  codeGuard: (p) => this.fence.assertCodingWrite(p, project.writePaths), // API 두뇌용(신규)
});
```

CLI 두뇌는 `codeGuard`를 무시하고 `extraArgs`로 돈다(무변경). API 두뇌는 `extraArgs`를 무시하고 `codeGuard`로 돈다. `CodingSpecialist`는 `this.fence`를 이미 보유.

## 8. 루프 한도 · resume (§13.1 미해결②)

- **한도**: `MAX_CODING_ITERATIONS`(상수, 30). 상한 도달 = **에러 아님** — 지금까지 편집분 + `hitLimit` 표시로 반환(8a와 동일). 어차피 `VerificationGate`가 직접 검증하므로 미완성은 게이트가 잡는다.
- **resume = 기존 재시도 루프**: 코딩이 게이트를 통과 못 하면 `Orchestrator`가 실패 내용(`ticket.gate.output`)을 프롬프트에 붙여 다시 시킨다(`CodingSpecialist`에 이미 있음). 외부 CLI의 rate-limit 개념을 **엔그램 자체 상한 + 게이트 재시도**로 대체 = §13.1 미해결② 그 항목의 실질 정의. 새 resume 장치는 8b-1에서 만들지 않는다.

## 9. 기본 provider 전환 (사용자 선택)

- 배포판 기본값 `brains.json` `default: "claude"`(claude-cli) **그대로**. 8b-1은 값을 안 바꾼다.
- 사용자가 `default`를 `anthropic`/`ollama` 등 엔그램 하네스 프로필로 바꾸면 **코딩까지 엔그램 하네스로** 돈다(8b-1 이전엔 거부됐음).
- provider가 곧 하네스 선택이므로 별도 스위치를 만들지 않는다. 설정창에서 기본 두뇌를 고르는 UI는 후속(비범위).

## 10. 재사용 (무변경)

- `VerificationGate` — 타입체크·빌드·테스트를 직접 돌려 자기보고 불신(§8.1). 코딩 루프가 파일을 고친 뒤 호출자가 돌린다. 무변경.
- `CodingGit` — 격리 브랜치/워크트리 seam. 무변경.
- `Orchestrator` — 코딩 재시도 루프. 무변경.
- `PermissionFence` — 기존 메서드 무변경, `assertCodingWrite` **추가만**.
- CLI 두뇌 3종 — 무변경.

## 11. 테스트 전략

전부 실 네트워크·실 두뇌 없이. 파일은 `fs.mkdtemp` 임시 폴더만.

- **coding-tools.ts**(단위):
  - Write → 파일 생성 확인; 부모 폴더 자동 생성.
  - Edit → 정확 1곳 치환 성공; 0곳→"not found" 에러 텍스트; 2곳 이상→"not unique" 에러 텍스트.
  - Read → 내용 반환; cwd 밖 경로 → 에러 텍스트; 큰 파일 truncate 표기.
  - Glob/Grep → cwd 하위 매치; cwd 밖 미포함; 상한 적용.
  - guard가 throw하는 경로(예: 자기 repo) → 에러 텍스트(안 터짐, never-throw).
  - 오염 인자(비객체·필드 누락) → 에러 텍스트.
- **API 두뇌 코딩 경로**(anthropic·openai 각):
  - `fetchFn` 주입해 SSE로 Write/Edit tool_use를 흘리고, `codeGuard` 스텁 + 임시 cwd → 루프가 실제 파일을 고치고 최종 답 반환.
  - `opts.cwd` 있고 `codeGuard` 없음 → isError(무방비 쓰기 거부).
  - 채팅 모드(`opts.cwd` 없음) → 기존 웹도구 body 그대로(회귀).
  - `codeGuard`가 막는 경로에 Write 시도 → tool_result에 에러 텍스트 되먹임, 루프 계속.
- **CodingSpecialist**: `brain.complete`에 `cwd`+`extraArgs`+`codeGuard`가 함께 넘어가는지(스텁 두뇌로 opts 캡처).
- **PermissionFence.assertCodingWrite**: 백스톱 경로 throw; projectWritePaths 밖 throw; 안이면 통과.

## 12. 불변식

1. **never-throw** — 코딩 도구 실행은 어떤 입력에도 예외를 던지지 않고 에러 텍스트를 반환.
2. **자기수정 차단** — 엔그램 자기 저장소·시스템 폴더·denyPaths에는 절대 쓰지 못함(`assertWritable` 백스톱 재사용).
3. **읽기 유출 차단** — 읽기 계열은 cwd 밖을 못 읽음.
4. **가드 없으면 코딩 없음** — `opts.cwd`는 있는데 `codeGuard` 미주입이면 즉시 isError(무방비 쓰기 원천 차단).
5. **셸 없음** — 명령 실행 도구 미제공. 검증은 `VerificationGate`가 직접.
6. **회귀 0** — 채팅 경로·CLI 두뇌·기본 provider 값 무변경. 엔그램 하네스를 안 고른 사용자는 아무 변화 없음.
7. **타임아웃 관통** — 하나의 `AbortController`가 모델 호출과 도구 실행까지 커버(8a 교훈).

## 13. 비범위 (후속)

- **8b-2**: OS 샌드박스 위의 셸/명령 실행 도구(감독 모드).
- **8c**: MCP 클라이언트(CLI 두뇌를 지휘자로 쓰는 것 포함).
- 설정창 기본 두뇌 선택 UI, 프로필별 코딩 상한/비용 상한, 지휘자의 코딩 하위작업 위임.
