# Phase 1 — A 읽기 (ReaderAgent + CLI Gateway) 설계

> 상위 기준선: [docs/DESIGN.md](../../DESIGN.md) · 작성: 2026-06-26 · 상태: 설계 확정, 구현 계획 착수 예정
> 전제: Phase 0(KnowledgeCore — WikiEngine + RagStore) 완료. 이 문서는 그 위에 "사람이 질문하고 답을 받는" 첫 경로를 얹는다.

---

## 1. 개요 · 범위

Phase 0는 지식 창고(위키 저장 + 하이브리드 검색)까지 만들었으나, 사람이 말을 거는 창구도, 검색 결과를 답으로 종합하는 에이전트도 없다. Phase 1은 그 첫 입출력 경로를 만든다.

```
사용자 → CLI Gateway → Orchestrator(스텁) → ReaderAgent → RagStore(완료) + BrainProvider(신규)
```

**범위 안**: BrainProvider(Claude CLI 어댑터 + 세마포어), ReaderAgent(A), 미니 Orchestrator 스텁, CLI Gateway(원샷 + REPL), 부트스트랩 배선.

**범위 밖(이후 단계)**: 분해·종합·TurnBudget(Phase 3), 자율 수집·검증 파이프라인(Phase 2), Discord/웹 게이트웨이, InsightLayer, ProcessSupervisor.

---

## 2. 산출물 (파일 배치)

```
src/brain/
 ├ brain.port.ts          IBrainProvider 인터페이스 + BrainResult 타입 + BRAIN DI 토큰
 ├ brain.config.ts        brains.json 로더 (복수 프로필 + default, env 덮어쓰기, 기본값)
 ├ claude-cli.brain.ts    claude -p 어댑터 (cross-spawn + p-limit 세마포어 + 스트리밍)
 ├ fake-brain.ts          테스트용 고정 BrainResult 제공자
 └ brain.module.ts
src/agent-layer/
 ├ reader-agent.ts        A: 질문 → 검색 → 컨텍스트 조립 → brain → 답 + 출처
 ├ orchestrator.ts        미니 스텁 (route() = reader.handle() 한 줄, "모든 흐름 경유" seam)
 └ agent-layer.module.ts
src/edge/
 ├ core-message.ts        CoreMessage 타입 — 앞단 중립 메시지 { text, userId }
 ├ cli.gateway.ts         원샷 + REPL 어댑터 (CLI 특유의 것을 여기 가둠)
 └ edge.module.ts
src/cli.ts                CLI 진입점 (Nest standalone 컨텍스트 → Gateway 실행)
```

`main.ts`는 24/7 상주용으로 그대로 둔다. `PathResolver`에 `getConfigDir()`(= `runtime/config/`)를 추가한다.

---

## 3. 결정 요약

| 영역 | 결정 |
|---|---|
| 흐름 배선 | Gateway → **미니 Orchestrator 스텁** → ReaderAgent. Gateway는 Orchestrator만 알고 ReaderAgent를 모른다(불변 "모든 흐름 경유"를 1일차부터 박음). |
| 근거 정책 | **위키 근거 우선 + 출처 명시.** 검색 결과를 우선 근거로, 어느 페이지에서 왔는지 표기. 위키에 없으면 일반 지식으로 답하되 그 사실을 명시. |
| CLI 형태 | **원샷 기본 + REPL 플래그.** 둘 다 같은 `route(CoreMessage)`로 수렴. |
| 두뇌 config | **`brains.json` 파일이 1차 소스** — 이름 붙인 두뇌 **여러 개** + `default`. env 변수는 활성 두뇌 덮어쓰기로만. Phase 1은 `default` 하나만 구동(claude-cli), 나머지 프로필은 파일에 둬도 무시. |
| 출력 방식 | **스트리밍.** 글자 단위로 흘러나옴. `onChunk` 콜백을 층 사이로 통과시키는 방식. |
| 진입점 | `main.ts`(상주) / `cli.ts`(질문) **분리.** |
| 에이전트 상태 | **매 턴 독립**(stateless 워커, 설계 §3). REPL도 같은 호출 반복, Claude 세션 resume 안 함. |

---

## 4. BrainProvider

설계 §7.5의 교체 가능한 두뇌 포트. Phase 1은 Claude CLI 어댑터 1개만 구현하되, 인터페이스를 포트로 둬 이후 API·Gemini·로컬 어댑터가 같은 자리에 꽂히게 한다.

### 4.1 포트 (`brain.port.ts`)

```ts
export interface BrainResult {
  text: string;        // 최종 답 본문
  costUsd: number;     // 호출 비용(없으면 0)
  isError: boolean;    // CLI 오류/타임아웃 여부
  raw?: unknown;       // 원본 응답(디버깅용)
}

export interface BrainProvider {
  // onChunk: 텍스트 조각이 생성될 때마다 호출(스트리밍). 생략 시 블로킹 수집.
  complete(prompt: string, onChunk?: (text: string) => void): Promise<BrainResult>;
}

export const BRAIN = Symbol('BRAIN'); // DI 토큰
```

### 4.2 Claude CLI 어댑터 (`claude-cli.brain.ts`)

- **호출**: `cross-spawn(cli, ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...(model ? ['--model', model] : []), ...extraArgs])`. (설계 §12 — `claude -p` 윈도우 네이티브 동작 확인됨, spawn은 `cross-spawn`으로.)
- **스트리밍 파싱**: stdout은 NDJSON(줄 단위 JSON 이벤트). 각 줄을 파싱해 텍스트 델타 이벤트면 `onChunk` 호출·누적, 최종 `result` 이벤트에서 전체 텍스트·`total_cost_usd`·`is_error`를 얻어 `BrainResult`로 정규화. (정확한 이벤트 필드명은 구현 시 CLI 출력으로 확정 — claude-code-guide 에이전트로 검증.)
- **세마포어**: `p-limit(concurrency)`를 어댑터 인스턴스에 1개 둔다. 모든 brain 호출이 `complete()` 한 메서드로 수렴하므로 여기가 유일한 choke point(설계 §8 — 동시에 생각하는 에이전트 수에 천장).
- **타임아웃**: `timeoutMs` 경과 시 프로세스 kill → `{ text:'', costUsd:0, isError:true }` 반환. **throw 하지 않고** `BrainResult`로 흡수(호출자가 분기 처리).
- **하드코딩 금지**: cli 경로·모델·동시 수·타임아웃·extraArgs를 전부 config에서 받는다(아래).

### 4.3 Config (`brain.config.ts`)

`runtime/config/brains.json`이 1차 소스. **이름 붙인 두뇌 프로필 여러 개 + `default`** 형태(설계 §7.5 — 페르소나가 `brain:`으로 고르는 미래를 위해 파일 형식부터 복수형). 파일이 없으면 기본값으로 1회 생성(사용자가 편집 가능). env 변수는 활성(=default) 두뇌에 대한 빠른 테스트용 덮어쓰기.

```json
{
  "default": "claude",
  "brains": {
    "claude": {
      "provider": "claude-cli",
      "cli": "claude",
      "model": "",
      "concurrency": 2,
      "timeoutMs": 120000,
      "extraArgs": []
    }
  }
}
```

**Phase 1 동작**: 로더가 `brains[default]` 프로필 하나만 꺼내 어댑터를 만든다. `provider`가 `claude-cli`가 아니면 명확한 에러로 거부(이후 단계에서 분기 추가). `brains`에 다른 이름이 더 있어도 Phase 1은 무시(Phase 3에서 페르소나·라우팅이 이름으로 해소). 프로필 키:

| 키 | env 덮어쓰기 | 기본 | 의미 |
|---|---|---|---|
| `provider` | — | `claude-cli` | 어댑터 종류(Phase 1은 `claude-cli`만) |
| `cli` | `ENGRAM_BRAIN_CLI` | `claude` | 실행 파일(경로/PATH 이름) |
| `model` | `ENGRAM_BRAIN_MODEL` | `''`(= CLI 기본) | 모델 ID |
| `concurrency` | `ENGRAM_BRAIN_CONCURRENCY` | `2` | 동시 호출 상한(세마포어, 프로필별) |
| `timeoutMs` | `ENGRAM_BRAIN_TIMEOUT_MS` | `120000` | 호출 타임아웃 |
| `extraArgs` | — | `[]` | CLI 추가 인수 |

> 세마포어가 프로필별인지 전역(구독 한도 = 총 동시 두뇌 호출)인지는 두뇌가 둘 이상 도는 Phase 3의 관심사. Phase 1은 두뇌 하나뿐이라 프로필별 = 전역.

---

## 5. ReaderAgent (A)

설계 §7.2. 질문 하나를 검색 → 종합 → 답으로 바꾸는 단일 에이전트. 상태 없음(매 호출 독립).

### 5.1 흐름 — `handle(msg: CoreMessage, onChunk?): Promise<string>`

1. `rag.search(msg.text, k=5, msg.userId)` → `SearchResult[]`(`{ slug, title, text, score }`).
2. **컨텍스트 조립**: 검색 결과를 번호 매긴 블록으로.
   ```
   [1] {title} (slug: {slug})
   {text}

   [2] ...
   ```
3. **프롬프트**: 시스템 지시 = "아래 검색된 위키 내용을 **우선** 근거로 답하라. 사용한 근거는 `[n]`으로 표기하라. 검색 내용으로 답할 수 없으면 위키 밖 일반 지식임을 명시하라." + 컨텍스트 블록 + 사용자 질문.
4. `brain.complete(prompt, onChunk)` → 답 스트리밍.
5. **출처 첨부**: 스트림 종료 후 사용된(검색된) 페이지 목록을 답 밑에 붙인다.
   ```
   ───
   출처: [1] {title} (slug) · [2] ...
   ```
6. 최종 문자열 반환(REPL/원샷 공통).

### 5.2 무결과 처리

`search`가 `[]`면 컨텍스트 없이 진행하되, 답 머리에 `⚠ 위키에 관련 내용 없음 — 일반 지식 기반 답변` 표기. (근거 정책 = 위키 우선이되 없으면 일반 지식 + 그 사실 명시.)

### 5.3 에러 경계

`handle` 전체를 try/catch로 감싼다(설계 §10.3 — 한 에이전트 실패가 프로세스를 죽이지 않게). `BrainResult.isError`이거나 예외면 사용자에게 "답변 생성 실패: {사유}"를 돌려주고 로그(pino)에 남긴다. 프로세스는 계속 산다.

### 5.4 출처의 범위

Phase 1의 "출처" = 답이 참조한 **위키 페이지(slug/title)**. `SearchResult`가 이미 slug·title을 들고 있어 코어 수정 불필요. frontmatter `sources:`(대화·URL 등 더 깊은 출처)까지 노출하는 건 C 자율쓰기 검증의 관심사 → 그때 `SearchResult`에 필드 추가(현재 YAGNI).

---

## 6. 미니 Orchestrator (스텁)

설계 §7.1 "모든 흐름이 경유" 불변을 1일차부터 강제하는 빈 껍데기.

```ts
@Injectable()
export class Orchestrator {
  constructor(private readonly reader: ReaderAgent) {}
  route(msg: CoreMessage, onChunk?: (t: string) => void): Promise<string> {
    return this.reader.handle(msg, onChunk); // Phase 3: 분해·종합·TurnBudget이 여기 들어옴
  }
}
```

Gateway는 `Orchestrator`만 주입받고 `ReaderAgent`를 직접 모른다 → seam이 가짜가 아니라 실제 경유 지점.

---

## 7. CLI Gateway (포트 + 어댑터)

설계 §9.1. 입출력 통로. CLI 특유의 것(인수 파싱·프롬프트 기호·stdout 쓰기)을 이 어댑터 안에만 가두고, 코어는 `CoreMessage`만 본다.

### 7.1 CoreMessage (`core-message.ts`)

```ts
export interface CoreMessage {
  text: string;    // 사용자 질문
  userId: string;  // 기본 DEFAULT_USER
}
```

### 7.2 두 모드 (`cli.gateway.ts`)

- **원샷**: `engram ask "질문"` → `CoreMessage{ text:'질문', userId:DEFAULT_USER }` → `orchestrator.route(msg, chunk => process.stdout.write(chunk))` → 출처까지 출력 후 종료.
- **REPL**: 인수 없이 `engram` → `node:readline` 루프. 매 줄을 `route()`로 보내고 스트리밍 출력. `exit`/`quit`/Ctrl-C로 종료.
- 두 모드 모두 같은 `route()` 호출. 스트리밍 콜백 = stdout 직접 쓰기.

### 7.3 진입점 (`cli.ts`)

```ts
// Nest standalone 컨텍스트로 모듈 그래프 부팅 → Gateway 꺼내 실행 → 원샷은 종료, REPL은 루프.
```

`package.json`: `bin: { engram: "dist/cli.js" }` + `scripts.start:cli`. `main.ts`(상주)는 불변.

---

## 8. 배선

- `AppModule`에 `BrainModule`·`AgentLayerModule`·`EdgeModule` 추가.
- `AgentLayerModule`은 `KnowledgeCoreModule`(RagStore export)과 `BrainModule`(BRAIN export)을 import.
- `BrainModule`: `{ provide: BRAIN, useClass: ClaudeCliBrain }` + config 로더. 테스트는 `BRAIN`을 `FakeBrain`으로 override.
- `PathResolver.getConfigDir()` 추가 → `path.join(dataDir, 'config')`.

---

## 9. 테스트 계획

| 대상 | 방법 |
|---|---|
| `brain.config` | 파일 있음/없음/env 덮어쓰기 → 병합 결과, `default` 프로필 해소, 비-claude-cli provider 거부. |
| `ClaudeCliBrain` | spawn 모킹 → NDJSON 스트림 파싱(델타 → onChunk 누적, result → text/cost), 타임아웃 → isError, 세마포어가 동시 호출 수 제한. |
| `ReaderAgent` | `FakeBrain` + 인메모리/스텁 RagStore → 컨텍스트 조립 형식, 출처 첨부, 무결과 머리말, 에러 경계(brain isError → 실패 메시지). |
| `Orchestrator` | route가 reader.handle로 위임하고 onChunk를 통과시키는지. |
| `CliGateway` | `route()` 모킹 → 원샷 1개 스모크(인수 파싱 → CoreMessage → stdout). REPL은 수동/가벼운 테스트. |

기존 Phase 0 테스트 패턴(FakeEmbedder류 fake + 단위 spec) 따름.

---

## 10. 완료 기준

1. `engram ask "질문"` → 위키에 근거한 답이 **글자 단위로 흐르며** 출력되고, 밑에 출처 페이지 목록이 붙는다.
2. 인수 없이 `engram` → REPL로 연속 질의·응답.
3. 위키에 없는 질문 → `⚠ 위키에 관련 내용 없음` 머리말과 함께 일반 지식 답.
4. 두뇌 호출이 `brain.json`의 `concurrency`를 넘지 않는다(세마포어 동작).
5. CLI 타임아웃·오류가 프로세스를 죽이지 않고 사용자에게 실패 메시지로 전달된다.
6. Gateway가 `ReaderAgent`를 직접 참조하지 않는다(Orchestrator 경유).
7. 모델·CLI 경로·동시 수·타임아웃이 코드에 하드코딩되지 않고 `brains.json`(`brains[default]`)에서 온다. 두뇌 프로필 여러 개를 담을 수 있다.
8. 신규 단위 테스트 통과 + 기존 Phase 0 테스트 무회귀.
