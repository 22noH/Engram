# 언어 리팩터 — 지시문 영어화 + 출력/저장 다국어 분리

작성일: 2026-07-08
상태: 설계 확정(브레인스토밍 산출) — 구현 플랜 대기
순서: **Phase 12(다중 연결)보다 먼저**. 서로 의존 없음(독립 크로스컷).

---

## 0. 왜 지금, 무엇을

현재 Engram은 **LLM에 주는 지시문(프롬프트·페르소나)이 전부 한국어**이고, 그래서
답·위키 저장·상태 문구까지 사실상 한국어로 굳어 있다. 목표는 두 축을 **분리**하는 것:

| 축 | 무엇 | 이번 목표 |
|---|---|---|
| **지시문 언어** | 모델에게 주는 명령(분류·규칙·역할…) | **영어** |
| **출력 언어** | 사용자에게 가는 답 + 위키/대화 저장 + 상태 문구 | **사용자 언어**(대화형) / **설정 언어**(자율·UI) |

효과: 다국어가 제대로 돌고(설정=한국어 → 한국어로 보임), 지시문 토큰이 줄며,
출력 언어가 코드에서 분리돼 유지보수가 쉬워진다.

**결정된 언어 규칙**(브레인스토밍):
- **대화형** 출력 = **사용자가 보낸 메시지 언어**를 모델이 추론해 맞춤.
- **자율**(트리거 메시지 없는 인사이트·회의록·앰비언트) 출력 = **설정 언어**.
- **백엔드 하드코딩 문자열·UI** = **설정 언어**.

---

## 1. 스코프

### 포함 (A~D)
- **A. 지시문 → 영어**: `prompts/*.md` 7개 + 코드 `*_DEFAULT` 상수 7개 + 오버라이드
  불가 인라인 프롬프트 5개 + `personas/*.md` 8개.
- **B. 통일 출력 언어 규칙**: 각 LLM 표면에 대화형/자율에 맞는 언어 지시 1줄. insight의
  "한국어" 하드코딩 제거.
- **C. 설정 언어 배선(신규 최소)**: 백엔드가 설정 언어를 아는 수단 신설(현재 부재).
- **D. 백엔드 하드코딩 한국어 문자열 → 백엔드 T 사전(en/ko)**: 오케스트레이터 상태·
  안내·라벨, 회의록 라벨, reader 헤더 등.

### 비범위(후속)
- 설정 언어 **실시간 반영**(이번엔 재시작 시 적용) · en/ko 외 UI 언어 추가 · 저장된
  과거 콘텐츠 소급 번역 · 프롬프트 A/B 품질 튜닝.
- 인라인 5개 프롬프트를 `loadPrompt` 오버라이드로 승격(별개 관심사, 이번엔 제자리 번역).

### 회귀 안전
프롬프트를 영어로 바꾸면 **모든 에이전트 산출이 미묘하게 달라질 수 있다**. find-replace가
아니라, 표면별 골든 출력 스모크로 "언어만 바뀌고 구조/JSON 계약은 그대로"를 지킨다(§8).

---

## 2. LLM 표면별 분류(설계의 핵심 표)

각 LLM 지시문을 **JSON(기계용)** / **대화형 출력** / **자율 출력** / **원본언어 추종**으로
분류하고, 그에 맞는 언어 지시를 붙인다. JSON 계약 줄은 **손대지 않는다**(파서와 묶임).

| 표면 | 파일 | 분류 | 언어 지시 |
|---|---|---|---|
| triage 분류 | `orchestrator.ts:616` / `prompts/triage.md` | JSON | 없음(영어 지시만) |
| decompose | `orchestrator.ts:681` / `decompose.md` | JSON | 없음 |
| ambient 판정+문구 | `orchestrator.ts:591` / `ambient.md` | **자율** | `Respond in {설정언어}` |
| code-chat | `orchestrator.ts:394` / `code-chat.md` | **대화형** | `…user's message language` |
| coding-rules(보고) | `coding-specialist.ts:40` / `coding-rules.md` | **대화형** | 〃 (기존 "같은 언어" 대체) |
| review | `reviewer-agent.ts:28` / `review.md` | **대화형** | 〃 |
| insight | `insight-reporter.ts:54` / `insight.md` | **자율** | `Respond in {설정언어}`(한국어 하드코딩 제거) |
| reader 답 | `reader-agent.ts:75-86` (인라인) | **대화형** | 〃 message language |
| synthesizer | `synthesizer.ts:14-17` (인라인) | **대화형** | 〃 |
| specialist 기여 | `specialist-agent.ts:28` (인라인) | **대화형** | 〃 |
| ingester 추출(writer) | `ingester-agent.ts:35-39` (인라인) | **원본언어 추종** | `…in the source conversation's language` |
| ingester 판정(judge) | `ingester-agent.ts:100-110` (인라인) | JSON | 없음 |
| meeting 회의록 | `meeting-engine.ts` | **자율** | `Respond in {설정언어}` |
| personas ×8 | `personas/*.md` | 정의=영어 | 출력은 호출 맥락 규칙 상속(specialist=대화형 등) |

**언어 지시 문구(표준화)**:
- 대화형: `Respond in the language of the user's latest message.`
- 자율: `Respond in {LANGUAGE}.` — 코드가 설정 언어 코드를 이름으로 매핑해 삽입.
- 원본추종(ingester): `Write the extracted facts in the same language as the source text.`

이 지시들은 호출부가 **코드에서 프롬프트 끝에 덧붙인다**(JSON 계약 줄과 같은 방식). 그래야
사용자가 `.md`를 편집해도 언어 규칙이 안 깨지고, `.md`/`_DEFAULT` 본문은 순수 지시만 남는다.

---

## 3. A — 지시문 영어화

- `prompts/*.md`와 대응 `*_DEFAULT` 상수를 **둘 다 영어로**(현행처럼 동기 유지). 프레시
  설치 기본이 영어. 사용자가 `ENGRAM_DATA_DIR/prompts/*.md`에 자기 언어로 덮어둔 건 그대로
  존중(Phase 7 오버라이드).
- 인라인 5개(reader/synthesizer/specialist/ingester×2)는 **제자리에서 영어로** 번역.
  loadPrompt 승격은 안 함(비범위).
- `personas/*.md`: frontmatter는 유지, 지시 본문 영어로. `role` 값이 UI 라벨로 쓰이면
  그 표시는 §5 T 사전이 담당(정의 자체는 영어).
- **JSON 출력 계약·propose 마커·차트블록 등 파서 결합 문자열은 변경 금지**(영어여도 계약
  키/토큰은 그대로).

---

## 4. B — 출력 언어 규칙

§2 표대로 표면별 언어 지시를 코드에서 덧붙인다. 구체 변화:
- `insight-reporter.ts` / `insight.md`: "3~5문장 한국어 서술로" → "3–5 sentences" +
  자율 언어 지시(`Respond in {설정언어}`).
- `coding-rules` / `code-chat`의 기존 "사용자 언어로" 문구는 표준 대화형 지시로 대체(중복 제거).
- **예약(schedule) 발사**: 저장된 `task` 텍스트가 그대로 재주입되어 파이프를 타므로 출력
  언어 = task 언어(사용자가 등록 때 쓴 언어). **현행 유지**(대화형 규칙과 일관, 변경 없음).

---

## 5. C — 설정 언어 배선(신규 최소)

**진실원**: 설정 파일. 기존 `configDir/chat.json`(`ChatConfig`, `chat.config.ts`)에
`language?: string`(BCP-47 코드, 예 `ko`/`en`) 필드를 **추가**한다. 없으면 미설정.

**기본값 해석 순서**(main.ts, Electron):
`chat.json.language` → 없으면 `app.getLocale()`(OS 로케일, 이미 `main.ts:32`에서 읽음) →
폴백 `en`.

**백엔드로 전달**: `main.ts`가 위 결정값을 `childEnv.ENGRAM_LANG`로 자식(utilityProcess,
`main.ts:45`)에 주입. 자율 리포터·백엔드 T 사전은 `process.env.ENGRAM_LANG`(폴백 `en`)를
읽는다. 코드→언어이름 매핑 소사전(`{ en:'English', ko:'Korean', ja:'Japanese', … }`,
미지 코드는 코드 그대로)으로 자율 지시의 `{LANGUAGE}`를 채운다.

**렌더러로 전달**: `main.ts`가 loadFile 시 `?port=`에 더해 `?lang=`를 붙인다. 렌더러
`config.ts`는 `?lang=` 우선, 없으면 현행 `navigator.language`. → UI도 같은 설정을 따름.

**설정 UI**: `settings.html`에 언어 선택(자동/English/한국어)을 추가, `configDir/chat.json`에
저장(기존 저장 헬퍼 패턴 재사용). **적용은 재시작 시**(env는 spawn 시 고정).
ponytail: 재시작 반영이 천장. 실시간 반영은 후속(ws config 프레임). `// ponytail:` 주석으로 표식.

**LLM 산출 언어 범위**: 설정 언어는 임의 코드 허용(모델이 해당 언어로 출력). **UI/T 사전은
en/ko만 저작**하고 미지원 코드는 en 폴백(§6). 즉 "일본어 설정" → LLM 답은 일본어, 버튼
라벨은 영어(후속 확장 여지).

---

## 6. D — 백엔드 하드코딩 문자열 → 백엔드 T 사전

**신규**: `src` 백엔드용 소형 i18n(`src/edge/messenger/i18n.ts` 등) — 렌더러 `T`와 같은
결의 사전. 키→{en,ko}. 선택 언어 = `ENGRAM_LANG`(en/ko, 그 외 en 폴백). 순수 함수라 테스트 쉬움.

**대상(인벤토리 근거)** — 코드가 직접 찍는 사용자 대면 한국어:
- 오케스트레이터: 예약/취소/재시도/오류 안내 `orchestrator.ts:197,200,470,532,543,547,551-553`,
  상태 라벨 `:351`(`코딩/예약/협업`), 진행중계 `:565-566,654,665,670`, 앰비언트 접두 `💡`.
- 명령 키워드 이중(`예약목록||schedules`, `예약취소||schedule cancel`) `:191,195` — **입력**
  파싱이므로 두 언어 인식 유지(라벨과 별개, 변경 없음).
- 회의록 라벨 `meeting-engine.ts:26`(`# 안건 / # 결론`, "…회의록") — T 사전 경유.
- reader 헤더/실패문 `reader-agent.ts:10,45,57`.

**주의**: 이 문자열들은 코드가 찍으므로 **설정 언어**를 따른다(사용자 메시지 언어 추론
아님 — 백엔드에 그 신호가 없고, "설정=한국어면 한국어로 보임" 요구와 일치).

---

## 7. 저장/위키 — 자동 추종

`ConversationStore.append`·`WikiEngine`·`InsightStore`·`ProposalStore`는 **LLM 출력 텍스트를
그대로 저장**한다(별도 언어 처리 없음). 따라서 §4로 출력 언어가 정해지면 저장 언어도 함께
이동한다 — 저장 계층은 **코드 변경 없음**. (회의록 라벨만 §6 T 경유.)

---

## 8. 테스트 전략

- **순수 함수 단위**:
  - 언어 지시 빌더: (분류, 설정언어코드) → 덧붙는 문구(대화형/자율/원본추종/없음).
  - 코드→언어이름 매핑(미지 코드 폴백).
  - 백엔드 T 사전: 키·en/ko·미지원 언어 en 폴백.
  - 설정 언어 해석: chat.json → OS → en 순서.
- **회귀 스모크(구조 보존)**: 각 LLM 표면에서 프롬프트에 (a) JSON 계약 줄이 그대로 있고
  (b) 언어 지시가 정확히 1회 덧붙는지 조립 단위 테스트. fake-brain으로 파이프 왕복 시
  JSON 파싱·propose 마커·차트블록이 그대로 동작하는지(언어만 바뀌고 계약 불변).
- **동작 확인**: insight가 설정 언어 지시를 싣는지(한국어 하드코딩 제거 확인). 대화형
  표면이 message-language 지시를 싣는지. `ENGRAM_LANG=ko`일 때 T가 한국어, 미설정 시 en.
- **렌더러**: `?lang=` 우선·navigator 폴백.
- 실제 LLM 출력 언어의 질(정말 그 언어로 답하는지)은 사용자 수동 스모크(모델 행동 의존).

---

## 9. 마이그레이션·삭제

- 변경: `prompts/*.md`×7, `personas/*.md`×8, `*_DEFAULT`×7, 인라인 프롬프트×5 → 영어.
  각 호출부에 언어 지시 덧붙임. `chat.config.ts`에 `language` 필드. `main.ts` env/쿼리 주입.
  `settings.html` 언어 선택. 백엔드 T 사전 신설 + 하드코딩 문자열 교체. `insight` 한국어 제거.
- 삭제: `coding-rules`/`code-chat`의 중복 "같은 언어로" 문구(표준 지시로 대체).
- 무변경: 저장 계층, ws 프레임 계약(§7·§5는 env/쿼리로만 전달 — 프로토콜 필드 안 늘림),
  BM25 불용어·slug 한글 유지(언어 리팩터와 무관).

---

## 10. 성공 기준

- 설정 언어=English → 새 대화에서 **영어로 물으면 영어로 답**하고, 인사이트/회의록/상태
  문구도 영어. 설정=한국어 → 전부 한국어. (설정 변경은 재시작 후 반영.)
- 한국어로 물으면 설정과 무관하게 **한국어로 답**(대화형=메시지 언어).
- 위키/대화 저장 언어가 답 언어와 일치(자동).
- 프롬프트·페르소나 지시문이 영어. JSON 계약·propose 마커·차트블록 등 파서 결합 계약은
  불변(회귀 0).
- 백엔드가 코드로 찍던 한국어 상태·라벨이 설정 언어를 따름.
