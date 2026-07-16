# Phase 8a — engram 자체 하네스 (단발호출 + 미니 도구루프) 설계

작성일: 2026-07-13
상태: 설계 확정(브레인스토밍 산출) — 구현 플랜 대기

---

## 0. 배경 — 왜 지금

지금 Engram은 모델뿐 아니라 **하네스(도구 루프)까지 외부 CLI**(`claude`/`gemini`/`codex`)에서 빌려 쓴다. "로컬 LLM 사용"조차 claude CLI 껍데기에 env로 엔드포인트만 바꾼 것이라(brain.factory.ts 주석), Ollama 사용자도 claude CLI 설치가 필수다. Phase 8 = **모델 추론은 만들지 않되**(상용 API·로컬 LLM·기존 CLI 중 사용자 선택) 그 위의 **하네스를 Engram 것으로** 갖는 단계 — DESIGN.md §13.1 궁극 목표("Claude Code를 안 쓰게 되는 것")의 실질 시작.

**분해(사용자와 합의).** Phase 8은 커서 셋으로 쪼갠다:
- **8a(이 스펙)**: 모델 엔드포인트 직접 호출 provider + **미니 도구루프**(web_search·web_fetch 한 쌍만). 단발 호출(chat·collaborate·judge·classify 등 `complete()` 전 경로)이 대상.
- **8b(후속)**: 코딩 도구루프(파일편집·셸·관찰 반복 = `codeRun`) + 기본 provider 전환.
- **8c(후속)**: MCP 클라이언트.

**핵심 통찰(브레인스토밍 중 확정).** 웹검색은 모델 능력이 아니라 **도구**다. Anthropic 서버측 web_search($10/1천회)는 검색 대행 서비스일 뿐 — 하네스가 검색 도구를 직접 구현하면 로컬 LLM도 웹검색이 되고, API 두뇌도 그 과금을 피한다. 미니 도구루프는 8b 코딩 루프의 씨앗이 된다.

---

## 1. 확정된 모델 (사용자와 합의)

1. **8a 범위 = 단발호출 + 검색/fetch 미니 도구루프.** 코딩 루프는 8b.
2. **엔드포인트 둘 다**: Anthropic Messages API(`anthropic-api`) + OpenAI호환 chat/completions(`openai-api` — Ollama·LM Studio·vLLM·OpenAI 전부 커버).
3. **자체 웹검색 도구를 8a에 포함**(미니 도구루프). Anthropic 서버측 유료 검색은 **안 씀** — 두뇌 종류와 무관하게 검색 경로 단일화, 과금 변수 제거.
4. **검색 소스 기본 = DuckDuckGo**(키 불필요·설정 제로). config에 Brave/Tavily 키를 주면 그쪽으로 전환.
5. **API 키는 brains.json 평문 저장**(기존 Discord 토큰 관례와 동일 — 로컬 단일사용자 앱).
6. **기본 provider는 claude-cli 유지**(engram-api는 opt-in). 코딩이 아직 CLI 하네스 필요 — 기본값 전환은 8b.
7. **기존 CLI provider 3종 그대로**(선택권 유지, 강제 탈피 아님).

---

## 2. 설계 — 새 provider 2종

기존 포트 `BrainProvider.complete(prompt, onChunk?, opts?): Promise<BrainResult>` **무변경**. Orchestrator·에이전트·Semaphore·JUDGE_BRAIN 배선 전부 그대로. `createBrain`(brain.factory.ts)에 case 2개 추가, `ALLOWED`(brain.config.ts)에 2종 추가.

### 2.1 AnthropicApiBrain (`anthropic-api`)

- `POST https://api.anthropic.com/v1/messages` 직접 호출(공식 SDK 미도입 — 의존성 최소, HTTP+SSE ~수백 줄. *ponytail: SDK가 주는 재시도·타이핑이 필요해지면 도입 재검토*).
- 모델 기본 `claude-opus-4-8`(프로필 `model`로 변경). `max_tokens` 프로필 `maxTokens`(기본 16000).
- 스트리밍: SSE(`stream: true`) — `content_block_delta`의 `text_delta`를 `onChunk`로.
- 도구: §3 미니 도구루프의 `web_search`/`web_fetch`를 **클라이언트측 도구**로 선언(tool_use → 하네스 실행 → tool_result 되먹임).
- 인증: 프로필 `apiKey` → `x-api-key` 헤더. 키 없으면 즉시 isError(명확한 메시지).

### 2.2 OpenAiApiBrain (`openai-api`)

- `POST {baseUrl}/chat/completions` (OpenAI호환). `baseUrl` 프로필 필수(Ollama 기본 `http://127.0.0.1:11434/v1`). `apiKey` 옵셔널(Ollama는 불필요, OpenAI는 필요 — `Authorization: Bearer`).
- 스트리밍: SSE(`stream: true`) — `choices[].delta.content`를 `onChunk`로.
- 도구: OpenAI function calling 형식으로 동일한 `web_search`/`web_fetch` 선언. 모델이 tool calling 미지원이면 도구 없이 순수 텍스트로 동작(에러 아님 — 응답에 tool_calls가 안 올 뿐).

### 2.3 공통 계약

- **never-throw**: HTTP 실패·타임아웃·JSON 오염·루프 상한 도달 → `{ text, costUsd, isError: true, raw }` 반환(기존 ClaudeCliBrain 계약과 동일, 상주 불사).
- **Semaphore**: 프로필 `concurrency`로 provider별 생성(기존 패턴 그대로).
- **타임아웃**: `opts.timeoutMs ?? profile.timeoutMs` — 도구루프 **전체**에 하나(호출당이 아님).
- **코딩 호출 방어**: `opts.cwd`가 오면(코딩 신호) 즉시 `isError` + "코딩은 CLI 하네스 두뇌 필요(8b까지)" — 조용한 품질저하 대신 정직한 거부. `opts.extraArgs`는 CLI 플래그라 무의미 → 무시(에러 아님 — code-chat이 읽기도구 플래그를 넘기는 경로는 cwd 동반이라 위에서 걸러짐).
- **costUsd**: 응답 usage 토큰 × 프로필 단가(`inputUsdPerMTok`/`outputUsdPerMTok`, 기본 0) — 기존 turn-budget 경로가 그대로 동작. 가격표 하드코딩 안 함(금방 낡음). Ollama는 0.

---

## 3. 설계 — 미니 도구루프 + 웹 도구

### 3.1 루프 (tool-loop, 두 provider 공용)

```
history = [user: prompt]
loop (최대 MAX_TOOL_ITERATIONS = 8):
  res = 모델 호출(history, tools=[web_search, web_fetch], stream→onChunk)
  if res에 도구 호출 없음 → 최종 텍스트 반환
  각 도구 호출 실행(§3.2) → 결과를 tool_result로 history에 추가 → 계속
상한 도달 → 지금까지의 텍스트 + isError=false(부분 답변도 답변) 반환하되 raw에 'tool-loop-limit' 표기
```

- 도구 실행 자체의 실패(네트워크 등)는 **도구 결과로 에러 텍스트**를 되먹임(모델이 다른 방법을 시도하게) — 루프를 죽이지 않는다.
- provider별 와이어 형식(Anthropic tool_use/tool_result vs OpenAI tool_calls/role:tool)만 다르고 루프 로직은 공유 모듈 하나.

### 3.2 도구 구현 (web-tools)

- **`web_search(query)`**: 
  - 기본: DuckDuckGo HTML(`https://html.duckduckgo.com/html/?q=…`) 스크레이핑 → 상위 5개 `{title, url, snippet}` 텍스트로.
  - 프로필 필드(§4 `searchProvider`+`searchApiKey`)에 Brave/Tavily가 지정되면 그 API 사용.
  - *ponytail: DDG 스크레이핑은 마크업 변경에 깨질 수 있는 알려진 천장 — 파싱 실패 시 에러 텍스트에 "검색 키(Brave/Tavily) 설정" 안내를 담는 게 폴백. 업그레이드 경로 = 키 기반 전환.*
- **`web_fetch(url)`**: GET → HTML이면 태그 제거 텍스트 추출, 크기 상한(~50k chars)으로 절단. http/https만 허용, 사설 IP(127.*/10.*/192.168.*/169.254.* 등) 거부(SSRF 방어 — 두뇌 서버가 내부망에 있을 수 있음).
- 도구 스키마(이름·설명·인자)는 한 곳에 정의하고 provider가 자기 와이어 형식으로 변환.

---

## 4. 설계 — 프로필·config

`BrainProfile`(brain.config.ts) 확장 — 전부 옵셔널, 기존 프로필 하위호환:

```ts
interface BrainProfile {
  provider: string;            // + 'anthropic-api' | 'openai-api'
  cli: string;                 // CLI provider용(기존)
  model: string;
  concurrency: number;
  timeoutMs: number;
  extraArgs: string[];
  env?: Record<string, string>;
  apiKey?: string;             // 신규: anthropic-api 필수, openai-api 옵셔널
  baseUrl?: string;            // 신규: openai-api 필수
  maxTokens?: number;          // 신규: 기본 16000
  inputUsdPerMTok?: number;    // 신규: costUsd 계산용, 기본 0
  outputUsdPerMTok?: number;   // 신규
  searchProvider?: 'duckduckgo' | 'brave' | 'tavily'; // 신규: 기본 duckduckgo
  searchApiKey?: string;       // 신규: brave/tavily용
}
```

- `ALLOWED`에 `'anthropic-api'`, `'openai-api'` 추가. `resolve()`의 검증 그대로.
- env 오버라이드: `ENGRAM_BRAIN_API_KEY`·`ENGRAM_BRAIN_BASE_URL` 추가(기존 `ENGRAM_BRAIN_CLI`/`MODEL` 관례).
- **brains.json 기본 파일 무변경**(default=claude). engram-api는 사용자가 프로필 추가/편집으로 opt-in.

---

## 5. 설계 — 데스크톱 설정창

- **Anthropic API 키 입력란** 신설: 키 저장 시 `brains.json`에 `anthropic-api` 프로필(`anthropic` 이름) 생성/갱신. "기본 두뇌로 사용" 체크 시 default 전환(체크는 사용자 의사 — 코딩이 CLI 필요하다는 경고 문구 병기).
- **Ollama 흐름 교체**: 기존 `addOllamaProfile`이 *claude-cli 껍데기+env* 프로필을 만들던 것을 `openai-api` 프로필(`baseUrl: http://127.0.0.1:11434/v1`) 생성으로 교체 → **Ollama 사용자가 claude CLI 없이 동작**(이 페이즈의 존재 이유). 기존에 만들어진 프로필은 건드리지 않음(무변경 하위호환).
- 문구는 영어 기본 + ko 로케일(기존 관례).

---

## 6. 에러 처리·하위호환

- **기존 CLI 경로 무변경**: claude-cli/gemini-cli/codex-cli 사용자에게 회귀 제로(테스트로 고정).
- **키 미설정 anthropic-api**: 즉시 isError(스폰 시도 없음). **baseUrl 미설정 openai-api**: 동일.
- **네트워크 없음/서버 다운**: isError + raw에 사유 — 상주(main)는 기존 warn 로그 경로.
- **모델이 tool calling 미지원(로컬 구형 모델)**: 도구 없이 텍스트만 — 기능 저하이지 에러 아님.
- **코딩 경로**: `opts.cwd` → isError(§2.3). Orchestrator의 기존 `r.isError → answerUnavailable` 경로가 그대로 사용자에게 전달.
- **웹검색 과금**: 자체 도구라 Anthropic 검색 과금 없음. Brave/Tavily 선택 시 그 서비스 과금은 사용자 몫(키를 직접 발급하므로 인지된 선택).

---

## 7. 테스트 전략

- **provider 2종**: HTTP를 모킹(jest mock — 실제 네트워크 없이 CI)해서 ①단발 텍스트 ②SSE 스트리밍(onChunk 순서) ③tool_use→tool_result 루프 1회전 ④루프 상한 ⑤HTTP 4xx/5xx/타임아웃→isError ⑥키/baseUrl 미설정→isError ⑦opts.cwd→isError ⑧costUsd 계산(usage×단가).
- **tool-loop**: 순수 로직 단위 테스트(도구 실행 실패→에러 텍스트 되먹임, 상한).
- **web-tools**: DDG 파서는 저장된 HTML **픽스처**로(실 네트워크 금지), fetch는 태그제거·크기상한·사설IP 거부.
- **brain.config**: 신규 필드 병합·ALLOWED 확장·env 오버라이드.
- **brain.factory**: 2 case 생성.
- **desktop**: 설정창 로직 모듈(프로필 쓰기)은 기존 local-brains/ollama 테스트 패턴.
- 기존 스위트(특히 claude-cli.brain·orchestrator) 무변경 통과가 회귀 기준. 실 API/실 Ollama 스모크는 수동.

---

## 8. 파일 구조 (요약)

**백엔드 (src/brain/)**
- `anthropic-api.brain.ts` — AnthropicApiBrain(SSE+도구 와이어 변환).
- `openai-api.brain.ts` — OpenAiApiBrain(SSE+function calling 변환).
- `tool-loop.ts` — 공용 미니 도구루프(순수 로직).
- `web-tools.ts` — web_search(DDG/Brave/Tavily)+web_fetch(+SSRF 가드)+도구 스키마 정의.
- `brain.config.ts` — BrainProfile 확장+ALLOWED+env.
- `brain.factory.ts` — case 2개.

**데스크톱 (src/desktop/)**
- `settings.html`/preload/main IPC — Anthropic 키 입력·저장.
- `ollama.ts` — addOllamaProfile을 openai-api 프로필 생성으로 교체.

---

## 9. 이번에 안 하는 것 (되살릴 신호)

- **코딩 도구루프**(파일편집·셸·관찰 반복, `codeRun`) → **8b**. PermissionFence·결정적 게이트·격리 브랜치 seam은 불변 유지.
- **기본 provider 전환**(brains.json default=engram) → 8b(코딩까지 자체 하네스가 감당할 때).
- **MCP 클라이언트** → 8c.
- **키 암호화 저장**(Electron safeStorage) → 평문이 문제되는 신호(공유 머신 등) 오면.
- **Anthropic 서버측 web_search 옵션** → 자체 도구 품질이 부족하다는 실사용 신호 오면.
- **한도·resume 재정의**(§13.1 미해결②) → 8b에서 코딩 루프와 함께.
