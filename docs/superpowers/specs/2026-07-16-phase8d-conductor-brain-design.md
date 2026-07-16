# Phase 8d — 지휘자 두뇌 (두뇌 간 위임) 설계

작성일: 2026-07-16
상태: 설계 확정(브레인스토밍 산출) — 구현 플랜 대기

---

## 0. 배경 — 왜 지금

지금도 여러 두뇌를 `brains.json`에 등록해두고 페르소나마다 다른 두뇌를 정해 쓸 수 있다(정적 배정). 하지만 사용자가 원하는 건 다르다: **대화하는 기본 두뇌가 능동적으로 다른 두뇌를 불러 쓰는 것.**

- "이거 만들어줘, 리뷰는 클로드로" 처럼 **말로 특정 두뇌에 일부를 맡기기.**
- 혼자 하다 **막히면 알아서 다른 두뇌를 불러 해결하기.**
- 시작 전 **되물어 확인하기.**

8a에서 엔그램 자체 하네스(도구 루프)를 이미 만들었다. 그 루프에 도구 하나 — **"다른 두뇌 부르기"** — 를 더하면 위 셋이 전부 나온다. 8a의 `tool-loop.ts`·`sse.ts` 그대로 재사용.

---

## 1. 확정된 모델 (사용자와 합의)

1. **핵심 = 도구 하나.** 엔그램 두뇌의 도구 루프에 `ask_brain`(등록된 두뇌 하나를 골라 일 시키고 답 받기) 추가. "말로 지시"·"막히면 위임"·"먼저 질문"은 이 도구 + 프롬프트 + 기존 대화 루프에서 자연히 나온다(새 메커니즘 최소).
2. **지휘자 = 엔그램 두뇌(anthropic-api·openai-api)만.** claude CLI/codex/gemini는 자기 하네스로 돌아 우리가 도구를 못 심는다 — 걔네가 지휘자가 되는 건 8c(MCP). 지금은 미지원.
3. **일꾼 = 아무 두뇌나.** claude CLI·codex·gemini·로컬 전부 불려갈 수 있다(그냥 `complete(task)` 한 번).
4. **깊이 1단.** 불려간 일꾼은 또 다른 두뇌를 못 부른다(재위임 없음) → 무한 재귀 원천 차단.
5. **비용 합산.** 불려간 두뇌가 쓴 비용도 지휘자 응답 비용에 합산(예산·과금 추적).
6. **미지 두뇌 → 에러 텍스트.** 없는 이름을 부르면 던지지 않고 에러 텍스트로 되먹여 지휘자가 다시 판단.
7. **자율 위임은 공짜/로컬 우선.** 사용자가 특정 두뇌를 지시하지 않은 자율 폴백에서는 로컬(비용 0) 두뇌를 우선하도록 프롬프트로 유도(예상 못한 API 과금 방지). 강제 아님 — 프롬프트 지침.
8. **채팅 경로에만.** `ask_brain`은 채팅(ReaderAgent) 경로에서만 붙는다. 코딩(opts.cwd) 경로는 8a대로 여전히 거부(코딩 자체는 8b-1). 위임할 일이 채팅·분석·리뷰면 지금 바로 되고, **코딩을 위임하는 건 8b-1이 끝나야** 채워진다.

---

## 2. 설계 — `ask_brain` 도구 + 위임 핸들

### 2.1 위임 핸들 (포트 확장)

`CompleteOpts`(brain.port.ts)에 옵셔널 필드 추가. 8a의 `fetchFn` 주입 패턴과 동일 정신 — 두뇌는 "다른 두뇌를 만드는 법"을 몰라도 되고, 제공된 함수만 부른다(src/brain이 agent-layer에 결합 안 됨).

```ts
// brain.port.ts
export interface DelegateHandle {
  brains: string[];                                     // 위임 가능한 두뇌 이름들(brains.json 등록 전부 — 자기 자신 포함, 자기 위임은 허용하되 무의미)
  run(brain: string, task: string): Promise<string>;    // never-throw — 실패·미지 두뇌는 에러 텍스트 반환
}
export interface CompleteOpts {
  cwd?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  delegate?: DelegateHandle;   // 신규: 있으면 엔그램 하네스가 ask_brain 도구를 노출
}
```

### 2.2 `ask_brain` 도구 (엔그램 두뇌 provider 양쪽)

`AnthropicApiBrain`·`OpenAiApiBrain`의 `complete()`가 `opts.delegate`를 받으면:
- 도구 셋에 `ask_brain`을 **추가**(기존 web_search·web_fetch와 나란히). 스키마: `{ brain: string, task: string }`.
- 도구 **설명에 `opts.delegate.brains` 목록을 넣어** 모델이 고를 수 있는 두뇌 이름을 알게 한다(설명은 호출 시점에 조립 — 상수 WEB_TOOL_DEFS와 달리 동적).
- 모델이 `ask_brain` 호출 → `opts.delegate.run(brain, task)` 실행 → 반환 텍스트를 tool_result로 되먹임(8a 루프 그대로, never-throw이므로 실패도 텍스트).
- `opts.delegate`가 없으면(코딩·judge 등 다른 경로, 또는 지휘자 비활성) `ask_brain` 미노출 — 8a와 동일.

도구 스키마 정의는 `web-tools.ts`와 형태 맞춰 `brain-tools.ts`(신규)에 두거나, 동적 설명이 필요하므로 provider가 인라인 조립. 구현자가 8a `WEB_TOOL_DEFS` 패턴을 따라 결정(플랜에서 고정).

### 2.3 위임 실행기 `BrainDelegator` (agent-layer, 신규)

`DelegateHandle`을 만드는 작은 팩토리. 설정 접근·두뇌 캐시·깊이 가드를 담당(src/brain은 이걸 모름 — 함수만 받음).

```ts
// agent-layer/brain-delegator.ts
export class BrainDelegator {
  private spent = 0;
  constructor(
    private readonly configDir: string,
    private readonly resolve: (name: string) => BrainProvider, // createBrain(loadBrainProfile(configDir, name)) 캐시(모듈 factory 재사용)
    private readonly names: () => string[],                     // 등록된 두뇌 이름들(default 포함, 자기 자신 위임은 허용하되 무의미)
  ) {}

  handle(): DelegateHandle {
    this.spent = 0;
    return {
      brains: this.names(),
      run: async (brain, task) => {
        if (!this.names().includes(brain)) return `delegate error: unknown brain "${brain}" (available: ${this.names().join(', ')})`;
        const worker = this.resolve(brain);
        // 깊이 1: 일꾼에겐 delegate 미전달 → 재위임 불가(무한 재귀 차단). cwd 없음 = 채팅/분석 작업.
        const r = await worker.complete(task);
        this.spent += r.costUsd;
        return r.isError ? `delegate error: brain "${brain}" failed (${String(r.raw)})` : r.text;
      },
    };
  }
  spentUsd(): number { return this.spent; }
}
```

- `resolve`·`names`는 `agent-layer.module.ts`가 이미 가진 `createBrain(loadBrainProfile(...))` 캐시와 brains.json 로딩을 재사용(SpecialistAgent의 resolveBrain과 동형). 새 두뇌 생성 로직 안 만듦.

### 2.4 ReaderAgent 배선 (지휘자 진입점)

`ReaderAgent.handle`이 `this.brain.complete(prompt, onChunk)` → `this.brain.complete(prompt, onChunk, { delegate })`로.

- `BrainDelegator`를 `@Optional`로 주입(미주입 시 위임 없음 — 회귀 안전, 테스트 단순).
- 매 메시지마다 `const handle = delegator.handle()` 새로 만들어 `opts.delegate`로 넘김(비용 카운터 리셋).
- 기본 두뇌가 claude-cli면 opts.delegate를 무시(자기 하네스라 우리 루프 안 탐) — ReaderAgent는 두뇌 종류를 판별하지 않고 **항상 넘기기만** 한다. 엔그램 두뇌만 실제로 사용.
- 완료 후 위임 비용을 반영: 응답 비용/로깅에 `delegator.spentUsd()`를 더함(turn-budget·과금 추적). (구체 반영점은 플랜.)
- **지휘자 프롬프트**: 위임이 켜졌을 때(delegator 주입 + 기본이 엔그램일 때) buildPrompt에 지휘자 지침 블록을 앞에 붙인다 — `loadPrompt('conductor', CONDUCTOR_DEFAULT)`(외부화, 기존 prompt-store 패턴). 지침 내용: ask_brain으로 다른 두뇌를 부를 수 있음 · 사용자가 특정 두뇌를 지목하면 그걸 씀 · 막히면 위임 고려(자율 폴백은 로컬/공짜 우선) · 요청이 애매하면 추측 말고 되물음 · 코딩 위임은 아직 불가(8b-1).

### 2.5 "먼저 질문"은 새 장치 없음

ReaderAgent는 이미 한 번 `complete()` 후 답을 돌려주고, 직전 대화(RECENT_TURNS=6)를 다음 턴 프롬프트에 주입한다. 지휘자가 되물으면 그 질문이 답으로 나가고, 사용자가 다음 메시지로 답하면 연속성으로 이어진다. 새 pause/ask 메커니즘 불필요 — 지휘자 프롬프트가 "애매하면 되물어라"만 지시하면 된다.

---

## 3. 에러 처리·하위호환

- **위임 비활성(delegator 미주입, 또는 claude CLI 기본)**: 8a·현행 그대로. `ask_brain` 미노출, 회귀 0.
- **미지 두뇌·일꾼 실패**: 던지지 않고 에러 텍스트로 되먹임 → 지휘자가 다른 방법 시도. never-throw 계약 유지.
- **무한 재귀**: 깊이 1(일꾼은 delegate 미보유)로 구조적 차단.
- **비용 폭주**: 8a의 도구루프 상한(웹은 8회)이 ask_brain 호출 수도 제한. 자율 위임 로컬 우선(프롬프트). 전체는 기존 turn-budget/run-state가 감쌈.
- **동시성**: 지휘자가 일꾼을 부르면 일꾼은 자기 Semaphore로 실행 — 서로 다른 provider 인스턴스라 데드락 없음(지휘자는 자기 슬롯 점유한 채 대기, 정상).
- **타임아웃**: 불려간 일꾼은 **자기 프로필 타임아웃**(profile.timeoutMs)으로 이미 bound된다 — 무한정 매달리지 않음. 지휘자의 AbortController가 일꾼까지 관통하게 하는 건 선택적 강화(필수 아님) — 필요 시 `run`에 signal 인자를 더하는 방식으로 플랜에서 결정.

---

## 4. 테스트 전략

- **provider 2종**: 주입 fetch로 모델이 `ask_brain{brain,task}`를 부르는 SSE를 흘리고, 주입 delegate 스텁이 그 (brain, task)로 호출됐는지 + 결과가 tool_result로 되먹여져 최종 답이 나오는지. delegate 없으면 도구 미노출.
- **BrainDelegator**: 이름 지정 두뇌 resolve·깊이 1(일꾼 complete가 delegate 없이 불림)·미지 두뇌→에러 텍스트·일꾼 isError→에러 텍스트·비용 누적(spentUsd).
- **ReaderAgent**: delegator 주입 시 opts.delegate 전달·지휘자 프롬프트 포함, 미주입 시 미전달(회귀).
- **prompts/conductor.md 폴백**: 파일 없을 때 CONDUCTOR_DEFAULT 동작.
- 기존 스위트(특히 reader-agent·brain provider·orchestrator) 무변경 통과가 회귀 기준. 실 두뇌 위임 스모크는 수동.

---

## 5. 파일 구조 (요약)

**백엔드**
- `src/brain/brain.port.ts` — `DelegateHandle` + `CompleteOpts.delegate`.
- `src/brain/anthropic-api.brain.ts`·`openai-api.brain.ts` — opts.delegate 있으면 `ask_brain` 도구 노출(동적 설명)+실행 라우팅.
- `src/brain/brain-tools.ts`(선택) — ask_brain 스키마(동적 설명 조립 헬퍼).
- `src/agent-layer/brain-delegator.ts` — DelegateHandle 팩토리(깊이 1·비용 누적·미지 두뇌 가드).
- `src/agent-layer/reader-agent.ts` — delegator @Optional 주입·opts.delegate 배선·지휘자 프롬프트.
- `src/agent-layer/agent-layer.module.ts` — BrainDelegator provider(기존 resolveBrain 캐시 재사용).
- `prompts/conductor.md`(+ CONDUCTOR_DEFAULT 내장 폴백).

---

## 6. 이번에 안 하는 것 (되살릴 신호)

- **claude CLI/codex/gemini가 지휘자 되기** → 8c(MCP)로 ask_brain을 외부 하네스에 노출.
- **코딩을 다른 두뇌에 위임** → 8b-1(새 두뇌가 코딩 되게)이 끝나면 delegate.run이 cwd 있는 코딩 작업도 받게 확장. 그 전엔 채팅·분석·리뷰만.
- **깊이 2단+ 위임(일꾼이 또 위임)** → 필요 신호 오면 깊이 카운터로. 지금은 1단.
- **정교한 라우팅 정책·비용 상한 UI** → 프롬프트 유도로 충분. 규제/과금 요구 시.
- **보드미팅형 다대다 협업** → 이미 Phase 3에 있음. 이건 1대1 능동 위임.
