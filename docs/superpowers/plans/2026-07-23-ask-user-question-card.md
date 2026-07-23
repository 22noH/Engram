# 질문 카드(ask_user) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 두뇌가 선택지 카드(옵션·추천·기타·Skip·다중선택·묶음)를 채팅에 게시하고, 사용자의 답이 새 메시지로 돌아와 두뇌를 재트리거하는 비동기 질문 UI.

**Architecture:** 카드 = `Message.question` 구조 필드가 달린 두뇌 메시지(append-only 유지). 답 = 기존 send 경로 + `answersId` 참조(카드 수정 없음, 서버가 중복 차단). 생성 경로 2개 — ① 자체 하네스 `ask_user` 도구(CompleteOpts 클로저 주입, delegate 관례) ② 모든 하네스 공용 응답 텍스트 ` ```ask_user ` 펜스 블록 후처리.

**Tech Stack:** 기존 그대로 — TS/Nest 백엔드(jest), React 렌더러(vitest), ws 프로토콜(shared/protocol.ts), 실스모크 스크립트.

**Spec:** `docs/superpowers/specs/2026-07-23-ask-user-question-card-design.md` (목업 v4 확정 — 번호 칩 앞·Recommended 배지·기타 전체폭 입력·하단 우측 [Skip][Send]·클릭=선택/Send=전송)

## Global Constraints

- **회귀 0**: 프로토콜 additive만. `question`/`answersId` 없는 메시지의 저장·전송·렌더 경로 byte-identical. 기존 `actions` 버튼 기능 무변경.
- 답 메시지도 기존 게이트 전부 통과: 세션 게이트·authorId 서버 스탬프·canAccessChannel. 새 우회 경로 금지.
- 중복 전송 차단은 **서버측**(클라 비활성은 UX일 뿐).
- ⚠️ `chat-store.appendMessage`의 input 스프레드가 메시지 필드 allow-list다 — `question`·`answersId`를 거기 추가하지 않으면 저장 시 소실된다.
- 펜스 블록 검증 실패 시 **본문을 건드리지 않는다**(오탐 안전 — 블록이 그냥 텍스트로 보임).
- 카드 메시지 `text`에는 읽을 수 있는 폴백(질문+번호 옵션)을 채운다 — question을 모르는 표시면에서 정보 유실 없음.
- UI 문구 영어 기본+ko 로케일(renderer/src/i18n.ts 플랫 터너리 관례). 커밋 Co-Authored-By 금지. 무관 더티 파일 스테이징 금지. jest는 포그라운드 실행.

---

### Task 1: 프로토콜 타입 + chat-store 영속

**Files:**
- Modify: `shared/protocol.ts`(Message에 2필드+타입 2개), `src/edge/messenger/chat-store.ts:246-259`(appendMessage input)
- Test: `src/edge/messenger/chat-store.spec.ts`(기존 파일에 케이스 추가)

**Interfaces:**
- Produces(전 태스크가 사용):
  ```ts
  // shared/protocol.ts
  export interface QuestionOption { label: string; desc?: string; recommended?: boolean }
  export interface QuestionItem { q: string; header?: string; multiSelect?: boolean; options: QuestionOption[] }
  // Message에 추가:
  question?: { questions: QuestionItem[] };  // 질문 카드(두뇌 게시)
  answersId?: string;                        // 이 메시지가 답하는 카드 메시지 id
  ```
  `ClientFrame`의 send에 `answersId?: string` 추가: `{ t: 'send'; channelId: string; text: string; threadId?: string; answersId?: string }`.
- chat-store `ChatMessage`(chat-store.ts:10-18)에도 동일 2필드 추가(protocol과 병렬 유지, 기존 관례).

- [ ] **Step 1: RED** — chat-store.spec.ts에 추가: `appendMessage(ch, { authorId:'engram', text:'q', question:{ questions:[{ q:'포맷?', options:[{label:'A',recommended:true},{label:'B'}] }] } })` 후 `history()` 재조회 시 question 왕복 보존 + `appendMessage(ch, { authorId:'owner', text:'A', answersId: card.id })` 후 answersId 보존. 실행: `npx jest --testPathPattern="chat-store"` → 현재는 컴파일 에러 또는 필드 소실로 FAIL.
- [ ] **Step 2: GREEN** — protocol.ts 타입 추가 + appendMessage input 타입에 `question?: ChatMessage['question']; answersId?: string` 추가하고 msg 조립에 `...(input.question ? { question: input.question } : {}), ...(input.answersId ? { answersId: input.answersId } : {})` 스프레드 2줄. 재실행 PASS.
- [ ] **Step 3: 회귀+커밋** — full `npm test`·`npm run build`. `git commit -m "feat(ask-user): Message.question/answersId 타입+chat-store 영속(allow-list 등재)"`

---

### Task 2: self.adapter — 답 수신(answersId)과 카드 게시(reply 확장)

**Files:**
- Modify: `src/edge/messenger/messenger.port.ts:20-28`(reply 4번째 옵션 인자), `src/edge/messenger/self.adapter.ts:640-688`(onSend·reply)
- Test: `src/edge/messenger/self.adapter.spec.ts`(기존 파일에 케이스 추가)

**Interfaces:**
- Consumes: Task 1 타입.
- Produces:
  ```ts
  // messenger.port.ts — additive 옵션 인자(기존 구현체는 3인자 그대로 = 구조적 호환)
  reply(target: ReplyTarget, text: string, actions?: Action[], question?: Message['question']): Promise<void>;
  ```
  - self.adapter.reply: question 있으면 appendMessage input에 실어 저장+브로드캐스트.
  - onSend: `f.answersId`가 비어있지 않은 string이면 → `this.store.history(channelId, { limit: Number.MAX_SAFE_INTEGER })`에서 `m.answersId === answersId`인 메시지가 이미 있으면 **조용히 return**(응답 0·기록 0), 없으면 appendMessage input에 answersId 첨부. 나머지 경로(멘션 트리거 포함) 무변경.

- [ ] **Step 1: RED** — self.adapter.spec 케이스 3개: ①reply(target, text, undefined, question) → 브로드캐스트된 msg.question 보존 ②send 프레임 answersId 첨부 → 저장 메시지에 answersId + 두뇌 핸들러 정상 트리거 ③같은 answersId 두 번째 send → 두 번째는 미저장(history 길이 불변)·무브로드캐스트. 실행: `npx jest --testPathPattern="self.adapter"` FAIL.
- [ ] **Step 2: GREEN** — 위 인터페이스대로 구현. 중복 검사는 answersId 있을 때만(일반 send 비용 0). 재실행 PASS.
- [ ] **Step 3: 무인증 회귀 확인+커밋** — 기존 무인증·비공개 채널 테스트 전체 green 확인(full `npm test`)·build. `git commit -m "feat(ask-user): send answersId(서버측 중복 차단)+reply question 전달"`

---

### Task 3: 범용 경로 — 응답 텍스트 ` ```ask_user ` 펜스 블록 후처리

**Files:**
- Create: `src/agent-layer/ask-user-block.ts`, `src/agent-layer/ask-user-block.spec.ts`
- Modify: `src/agent-layer/orchestrator.ts`(post 직전 추출 지점 — 두뇌 최종 응답을 `post(reply, ...)`로 게시하는 경로), `src/edge/messenger/messenger-bridge.ts:27`(post에 question 인자 관통), `src/agent-layer/orchestrator.ts:41`(PostFn 확장)
- Modify: TOOL_USAGE_GUIDANCE 상수(자체 하네스·CLI 하네스 프롬프트에 무조건 포함되는 그 블록 — grep `TOOL_USAGE_GUIDANCE`)에 형식 문서+사용 지침 추가.

**Interfaces:**
- Consumes: Task 1 타입, Task 2 reply 4번째 인자.
- Produces:
  ```ts
  // ask-user-block.ts
  export interface AskUserPayload { questions: QuestionItem[] }
  // 텍스트에서 ```ask_user\n{JSON}\n``` 블록을 찾아 검증·분리. 유효하지 않으면 원문 그대로.
  export function extractAskUser(text: string): { text: string; question?: AskUserPayload };
  // 카드 text 폴백 생성(질문 + "1. 라벨 — 설명" 줄들) — reply의 text 인자로 사용
  export function questionFallbackText(q: AskUserPayload): string;
  ```
  - 검증 규칙(전부 통과해야 추출): questions 1~4개·각 q 비어있지 않은 string·options 2~4개·label 비어있지 않은 string·desc/header string·multiSelect/recommended boolean. JSON 파싱 실패/규칙 위반 → `{ text: 원문 }`.
  - `PostFn = (text: string, actions?: Action[], question?: AskUserPayload) => Promise<void>` — bridge가 `port.reply(e.target, text, actions, question)`로 관통.
  - orchestrator: 두뇌 최종 응답 게시 직전 `const { text, question } = extractAskUser(reply)` → question 있으면 `post(text || questionFallbackText(question), undefined, question)`.
  - TOOL_USAGE_GUIDANCE 추가 문구(요지): "사용자 결정이 필요한 분기에서는 응답에 ```ask_user JSON 블록(questions 1~4·options 2~4·recommended 1개)을 넣어라. 예약·자동 트리거 등 무인 턴에서는 사용 금지."

- [ ] **Step 1: RED** — ask-user-block.spec: 유효 블록 추출(본문 분리·question 파싱)/무효 JSON·옵션 1개·질문 5개 → 원문 그대로/블록만 있고 본문 없음 → text=''/questionFallbackText 형식. orchestrator 경로 테스트: stub 두뇌 응답에 블록 포함 → post가 question 인자와 함께 호출됨(기존 orchestrator 테스트 관례 따름). FAIL 확인.
- [ ] **Step 2: GREEN** — 구현+재실행 PASS. 블록 정규식은 ` ```ask_user `로 시작해 ` ``` `로 닫히는 첫 블록 하나만(여러 개면 첫 번째만 추출, 나머지는 텍스트로 둠 — 단순 규칙 주석).
- [ ] **Step 3: 커밋** — full test·build. `git commit -m "feat(ask-user): 응답 펜스 블록 후처리(범용 — CLI·비도구 LLM 커버)+PostFn question 관통"`

---

### Task 4: 자체 하네스 `ask_user` 도구(CompleteOpts 클로저 주입)

**Files:**
- Create: `src/brain/ask-user-tool.ts`, `src/brain/ask-user-tool.spec.ts`
- Modify: `src/brain/brain.port.ts:20`(CompleteOpts에 askUser), `src/brain/anthropic-api.brain.ts:47-61`(toolDefs+executor), `src/brain/openai-api.brain.ts`(동일 지점 — anthropic과 형제 구조), `src/agent-layer/reader-agent.ts:75` 부근(delegate 만드는 그 자리에서 askUser 클로저 주입 — post를 이미 쥔 층에서 생성)

**Interfaces:**
- Consumes: Task 3 `AskUserPayload`·검증 로직(재사용 — 중복 구현 금지: ask-user-block.ts의 검증 함수를 export해 공유), Task 2 reply.
- Produces:
  ```ts
  // ask-user-tool.ts
  export function askUserDef(): WebToolDef; // name:'ask_user', parameters = questions 구조 JSON Schema
  export async function runAskUser(input: unknown, askUser?: (q: AskUserPayload) => Promise<void>): Promise<string>;
  // brain.port.ts CompleteOpts에 추가:
  askUser?: (q: AskUserPayload) => Promise<void>;
  ```
  - runAskUser: askUser 미주입 → "이 하네스에선 ask_user를 쓸 수 없다" 안내 string(throw 금지). 입력 검증 실패 → 실패 사유 string. 성공 → 게시 후 "질문 카드를 게시했다. 사용자의 답은 다음 사용자 메시지로 도착한다. 이번 턴은 간결히 마무리하라." 반환.
  - toolDefs: 비코딩 분기에 `...(opts?.askUser ? [askUserDef()] : [])` — delegate 관례 그대로. executor에 `name === 'ask_user' ? runAskUser(input, opts?.askUser)` 분기.
  - reader-agent: delegate handle 만드는 자리에서 `askUser: async (q) => post(questionFallbackText(q), undefined, q)` 주입(post 접근 가능한 층 — 실제 파라미터 경로는 구현 시 reader-agent의 post 보유 형태에 맞춤. post가 reader-agent에 없으면 orchestrator에서 CompleteOpts로 내려보내는 동일 관례 사용).

- [ ] **Step 1: RED** — ask-user-tool.spec: 스키마 shape·미주입 안내·무효 입력 사유·유효 입력 시 askUser 1회 호출+마무리 문자열. anthropic-api.brain 테스트에 ask_user 노출/미노출(askUser 유무) 케이스(기존 delegate 노출 테스트 관례 복제). FAIL.
- [ ] **Step 2: GREEN** — 구현+PASS. openai-api.brain도 동일 분기(형제 일관).
- [ ] **Step 3: 커밋** — full test·build. `git commit -m "feat(ask-user): 자체 하네스 ask_user 도구(CompleteOpts 주입·delegate 관례)"`

---

### Task 5: 렌더러 QuestionCard(목업 v4)

**Files:**
- Create: `renderer/src/components/QuestionCard.tsx`, `renderer/src/components/QuestionCard.test.tsx`
- Modify: `renderer/src/components/Message.tsx`(m.question 분기), `renderer/src/App.tsx:351`(sendText answersId)·send 프레임, `renderer/src/i18n.ts`, `renderer/src/theme.css`

**Interfaces:**
- Consumes: Task 1 타입(`import type` — shared/protocol).
- Produces:
  ```tsx
  export function QuestionCard(props: {
    msgId: string;                       // 카드 메시지 id → answersId로 전송
    question: { questions: QuestionItem[] };
    answeredText?: string;               // 이 카드를 참조(answersId===msgId)하는 답 메시지의 text. 있으면 answered 상태.
    onAnswer: (text: string, answersId: string) => void;
  }): JSX.Element;
  ```
  - App: `sendText(text, threadId?, answersId?)` → send 프레임에 answersId 조건부 포함. Message 렌더 시 그 채널 메시지 배열에서 `msgs.find(x => x.answersId === m.id)`를 answeredText로 전달. Message.tsx: `m.question ? <QuestionCard .../> : 기존 body` — question 카드도 who 줄·기존 .msg 골격 유지, body(markdown)는 카드 위에 텍스트가 있으면 함께 표시하지 않고 카드만(폴백 text는 비-self용이므로 렌더러에선 카드가 원본).
  - 동작(목업 v4·확정 규칙): 옵션 행 클릭=선택 토글(단일=라디오, multiSelect=체크)·기타 입력에 타이핑=기타 선택·**Send=전송 확정**·Skip=현재 질문 건너뜀. 묶음: 내부 인덱스 진행, 마지막 Send에 `header(없으면 q): 답` 형식을 ` / `로 합쳐 한 번 전송. 전부 skip → `(skipped)` 전송. answeredText 있으면: 선택 표현 렌더(✓·강조)·나머지 흐림·컨트롤 비활성.
  - 키보드: 카드 루트 `tabIndex={0}`·onKeyDown — 포커스 시 숫자키=해당 행 선택, Enter=Send, Escape=blur. 채팅 입력창과 무간섭(포커스 없으면 무반응).
  - 스타일: theme.css 관례(`.msg` 하위 중첩·기존 변수 --panel/--line/--accent-soft/--accent-line/--dim만) — `.qcard`, `.qcard .qhead`, `.qcard .qopt`, `.qcard .qopt.sel`, `.qcard .qnum`(번호 칩 앞·선택=accent), `.qcard .qrec`(배지), `.qcard .qother`, `.qcard .qfoot`(우측 정렬 Skip·Send), `.qcard.answered`(흐림) — 목업 v4 배치 픽셀 대응.
  - i18n 키(플랫 터너리): `qRecommended`('Recommended'/'추천'), `qOtherPh`('Other — type your own answer'/'기타 — 직접 입력'), `qSkip`('Skip'/'건너뛰기'), `qSend`('Send'/'보내기' — 기존 send 키 재사용 가능하면 재사용), `qSkipped`('(skipped)'/'(건너뜀)' — 전송 텍스트는 로케일 무관 `(skipped)` 고정, 라벨만 로케일).

- [ ] **Step 1: RED** — QuestionCard.test: 렌더(번호칩 순서·추천 배지·1/N 표시)/클릭만으로 전송 안 됨/Send로 onAnswer(text, msgId) 1회/기타 입력 전송/multiSelect 조합 전송 텍스트/묶음 2문항 합침 형식/answeredText 시 버튼 무동작/전부 Skip → '(skipped)'/키보드(포커스 후 숫자+Enter). App.multi 테스트: msg.question 수신 → 카드 렌더·답 클릭 → send 프레임에 answersId 실림(기존 ws 스텁 관례). `npm --prefix renderer test -- --run` FAIL.
- [ ] **Step 2: GREEN** — 구현+PASS.
- [ ] **Step 3: 커밋** — renderer full+tsc+build, 백엔드 회귀 full test. `git commit -m "feat(ask-user): 렌더러 질문 카드(번호칩·추천·기타·Skip/Send·묶음·다중선택·answered)"`

---

### Task 6: 실스모크 + 검증

**Files:**
- Create: `scripts/smoke-ask-user.ts`(기존 `scripts/smoke-channel-brain.ts`의 mock 두뇌·실서버 부팅 패턴 재사용)

**Steps:**
- [ ] **Step 1: 스모크 작성** — 실서버 부팅(격리 임시 ENGRAM_DATA_DIR)+mock 두뇌(응답에 ask_user 펜스 블록 반환) → ws 클라: ①send "정리해줘" → 두뇌 응답으로 question 필드 달린 msg 프레임 수신(카드 게시 실증·블록 텍스트 미노출) ②answersId 실어 답 send → 정상 브로드캐스트+두뇌 재트리거(mock 호출 2회) ③같은 answersId 재전송 → 무반응(메시지 수 불변) ④서버 재시작 → history에 question·answersId 왕복 보존.
- [ ] **Step 2: 2회 연속 PASS + full 검증** — 스모크 2회·백엔드 full `npm test`·렌더러 full·양쪽 build. `git commit -m "test(ask-user): 실스모크(카드 게시→답→재트리거·중복 차단·재시작 영속)"`

---

## Self-Review 결과

- 스펙 커버: 데이터(T1)·서버 수신/게시(T2)·범용 후처리+지침(T3)·자체 하네스 도구(T4)·UI 전요소(T5)·스모크(T6). 비목표(블로킹·웹콘솔) 미구현 확인.
- 타입 일관: `QuestionItem`/`AskUserPayload`/`answersId`/`PostFn` 시그니처 태스크 간 동일 명칭 사용. 검증 로직은 ask-user-block.ts 단일 소스(T4가 재사용).
- 불확실(구현 중 확정): reader-agent가 post를 직접 쥐는지(아니면 orchestrator에서 CompleteOpts로 내려보낼지) — T4 브리프에 양쪽 경로 명시, 구현자가 실코드 따라 선택.
- 함정 명시: appendMessage allow-list(T1)·펜스 오탐 안전(T3)·서버측 중복 차단(T2)·키보드 무간섭(T5).
