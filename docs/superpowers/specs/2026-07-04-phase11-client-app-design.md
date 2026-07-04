# Phase 11 — 클라이언트 앱 토대 (Client App Foundation)

작성일: 2026-07-04
상태: 설계 확정 대기(브레인스토밍 산출)

---

## 0. 이 문서의 위치 — 큰 그림 먼저

이번 작업은 단일 기능이 아니라 **플랫폼 방향 전환의 1단계**다. 최종 비전과
분해를 먼저 못 박고, 그중 이번에 짓는 조각(Phase 11)만 상세화한다.

### 0.1 최종 비전

- **Engram(두뇌)** = AI 코어. 개인 위키 + RAG로 지속되는 지식을 붙여 LLM을 더
  똑똑하게 쓰는 "제2의 두뇌". 자율쓰기·협업·코딩·스케줄·관찰은 그 위의 덤. 두뇌는
  **어느 컴퓨터에나 설치**되고, 바깥과는 `MessengerPort`(ws) 하나로만 말한다.
- **클라이언트 앱** = 사람이 두뇌를 쓰는 전용 프로그램. 사용자 본인 컴퓨터에서 돌며
  **여러 Engram 두뇌에 동시 연결**(연결마다 이름, @Tag로 특정 두뇌 호출)한다.
- **사람 팀 채팅**(Slack/Discord식) 영역도 갖고, 그 안에서도 Engram을 @멘션으로 호출.
- **위키 원격/공유 스토리지**로 회사 등 다중 사용자 공용 두뇌도 가능.
- 즉 **혼자 쓰는 로컬 → 회사 전원이 동시에 쓰는 것**으로 확장 가능한 구조.

```
[Engram 두뇌 A]  [Engram 두뇌 B]  [Engram 두뇌 C]   ← 기계마다 설치, 각자 (인증된) ws API
       \             |             /
        [ Engram 클라이언트 앱 ]              ← 독립 Electron+React, N개에 연결
         · 연결마다 이름 + @Tag 라우팅
         · 영역 3개: 채팅(사람) / 챗봇(Ask) / 코드
                     |
        [ 원격/공유 Wiki 스토리지 ]
```

### 0.2 분해(각자 spec→plan→구현, 순서 = 의존)

| # | 서브프로젝트 | 핵심 |
|---|------------|------|
| **11 (이번)** | **클라이언트 앱 토대** | React+Vite+TS 독립 앱, 타입 ws 프로토콜, 현 기능 이전 + 버튼. 로컬 두뇌 1개. |
| 12 | 다중 연결 | N개 두뇌 연결, 연결 이름, @Tag 두뇌 선택. |
| 13 | 인증 + 원격 노출 | 두뇌 ws 토큰 인증(폰·타 기계·회사망). "남의 두뇌 호출 금지"가 여기서 풀림. |
| 14 | 사람 팀 채팅 | Slack/Discord 심화 or 호스트 채널. Engram @멘션 호출. |
| 15 | 원격/공유 Wiki 스토리지 | KnowledgeCore 스토리지 백엔드 교체(회사 공용 두뇌). |
| 16 | 다중 사용자/계정 | 동시 사용·격리·권한. |

**설계 원칙**: 11을 "밖으로 연결하는 독립 클라이언트"로 처음부터 지으면 12~16이
열린다. 두뇌가 UI를 서빙하는 구조로 지으면 다중 연결(2번)이 원천 봉쇄되므로,
독립 클라이언트는 사치가 아니라 **비전의 전제 조건**이다.

### 0.3 파킹된 열린 질문(이번 범위 아님, 방향만 기록)

- **원격 두뇌로 코딩** — 코드는 파일이 있는 곳에서 돌아야 하는데 두뇌가 원격이면
  갈라진다. **낙점 방향 = (c) 두뇌↔실행 분리**: 원격 두뇌가 "생각"하고 사용자 로컬
  실행기가 파일을 편집. Phase 12/13(원격 연결) 때 별도 브레인스토밍으로 상세화.

---

## 1. 이번 스코프 (Phase 11) — 로컬 전용, 서버 0

**목표**: 자체 채팅 UI를 지금의 단일 `chat.html`(vanilla)에서 **제대로 된 독립
React+Vite+TS 앱**으로 교체한다. 두뇌 코어는 건드리지 않는다. 아직 연결 대상은
로컬 두뇌 하나뿐이지만, "밖으로 연결하는 클라이언트" 구조로 지어 12~16의 자리를
열어둔다.

### 포함
- `renderer/` 새 폴더(최상위, `src/` 밖) = **데스크탑 앱의 렌더러**(Electron 렌더러
  프로세스 UI). React+Vite+TS, 자체 package.json. 웹앱이 아니라 데스크탑 앱의 UI 레이어다.
- Electron이 **로컬 빌드를 직접 로드**(loadFile) + ws로 **설정된 엔드포인트**
  (기본 `ws://127.0.0.1:47800`)에 연결.
- 두뇌 변경 최소: `SelfMessenger`가 **chat.html/HTML 서빙을 중단**하고 http는
  헬스 프로브 + ws 업그레이드만 유지. 코어 로직 무변경.
- **타입 ws 프로토콜**: 프레임을 한 곳에서 타입 정의 → 서버·`renderer/` 공유.
- **현 기능 전부 이전**(2.5 인벤토리).
- **클릭 승인/선택 버튼** — 메시지 프레임의 `actions` 정식 필드로.
- **영역 3개 네비 구조**: 채팅(사람) / 챗봇(Ask) / 코드.
  - **Ask·Code = 실제 동작**(로컬 두뇌 + 기존 기능).
  - **채팅(사람) = 다 짓되 feature flag로 숨김**(서버 없는 배포에선 visible=off).

### 비범위(후속 단계)
- 다중 연결·@Tag 두뇌 선택(12) · 인증·원격 노출(13) · 사람 채팅 실동작(14) ·
  원격/공유 wiki(15) · 계정/다중 사용자(16) · 원격 코딩(c안 상세).

---

## 2. 아키텍처

### 2.1 호스팅 모델 전환

| | 지금(Phase 9/10) | Phase 11 |
|---|---|---|
| 페이지(HTML/JS) 전달 | 두뇌 http가 `chat.html` 서빙, Electron이 `loadURL(http://127.0.0.1:47800)` | 클라가 페이지를 **소유**. Electron `loadFile(renderer/dist/index.html)` |
| 데이터(ws) | `ws://${location.host}`(같은 서버) | `ws://127.0.0.1:47800`(**설정된 엔드포인트**) |
| 두뇌 http 역할 | chat.html 서빙 + ws 업그레이드 | **헬스 프로브 + ws 업그레이드만** |

**왜**: 클라가 나중에 여러 두뇌에 붙어야 하는데, 그러면 "어느 두뇌가 UI를 서빙하냐"가
성립 안 한다. 그래서 처음부터 클라가 페이지를 들고 있고 두뇌엔 ws로만 붙는다.

의도적 제거: `127.0.0.1:47800`을 브라우저로 열어 쓰던 편의. 단일 두뇌가 다중연결
UI를 서빙할 수 없으므로 제거. 폰·브라우저 접속은 Phase 13(원격) 때 재설계.

### 2.2 프로세스 배치(로컬)

- **두뇌**: 기존대로 Electron `main.ts`가 `utilityProcess`로 Nest 자식을
  띄운다(무변경). 자식이 `SelfMessenger` ws를 `127.0.0.1:47800`에 연다.
- **클라 렌더러**: `chatWin`이 `renderer/dist/index.html`을 `loadFile`로 로드. 렌더러 JS가
  ws로 두뇌에 붙는다.
- **준비 감지**: 지금 `probe()`가 http GET로 두뇌 기동을 기다린다. http를 헬스용으로
  유지하므로 프로브 로직 그대로. 다만 `loadURL(url)` 대신 준비되면 **loadFile**로
  진입(대기 화면 → 준비 → 클라 로드).

### 2.3 폴더 구조(신규)

```
renderer/                ← 데스크탑 앱의 렌더러(Electron 렌더러 UI). 최상위, src/ 밖.
  package.json
  vite.config.ts
  index.html             ← Vite 진입(루트)
  src/
    main.tsx             ← React 부트
    App.tsx              ← 셸: 3영역 네비 + 연결
    ws/
      protocol.ts        ← ★ ws 프레임 타입(서버와 공유, 단일 진실원)
      client.ts          ← ws 연결·재연결·프레임 송수신 훅
    areas/
      ask/               ← 챗봇(Ask Engram)
      code/              ← 코드
      chat/              ← 사람 채팅(flag-gated)
    components/
      Message.tsx        ← 마크다운/차트/체크리스트/표 렌더(XSS 안전)
      ActionButtons.tsx  ← ★ 버튼(actions 필드)
      Channels.tsx, Composer.tsx, ...
    i18n.ts, theme.ts, config.ts(엔드포인트·feature flag)
  dist/                  ← 빌드 산출물(electron-builder files에 포함)
```

**ws 프레임 타입 공유**: `protocol.ts`를 단일 진실원으로 두고 서버(`src/edge/messenger/`)도
같은 타입을 참조한다. 구현 시 방식 확정(경로 alias / 작은 공유 파일 / 심볼릭). 핵심은
**프레임 계약이 양쪽에서 같은 타입**이라는 것(지금의 stringly-typed 해소).

### 2.4 두뇌 쪽 변경(최소)

- `SelfMessenger.start()`의 http 핸들러에서 **chat.html 읽기 제거** → GET `/`는 200
  헬스(빈 바디 or `{ok:true}`)만. ws 업그레이드는 그대로 http 서버에 붙임.
- `ChatStore`/`chat.config`/`MessengerHub`/`messenger.port`는 유지. `MessengerPort`,
  `MentionEvent`, `mode/repoPath`(Phase 10) 등 계약 무변경.
- `desktop/chat.html`, `chat-preload.ts`는 클라 이전 후 제거/이관(2.6).

---

## 2.5 현 기능 이전 인벤토리 (chat.html → renderer/)

빠짐없이 옮긴다(회귀 0 목표):

- 채널 사이드바(목록·선택·생성[인라인 입력, Electron `prompt` 미지원 대응]·삭제·⋯ 컨텍스트 팝오버).
- 자동 스레드(anchor=트리거 메시지, 답 1개=인라인/2+=접힘, 기본 펼침).
- 마크다운 렌더: 헤딩·목록·**체크리스트**·**비교 표**(+/▲ 초록, -/▼ 빨강)·인라인 강조·링크(외부 브라우저로).
- **인라인 SVG 시각화**: ` ```chart ` bar/line/pie(라이브러리 0, 순수 SVG).
- `/` 명령 팔레트. 번호 목록 클릭 선택(→ 버튼으로 대체/보강, 3.3).
- "생각 중" 인디케이터(답 도착 시 해제, 180s 타임아웃).
- 재연결 백오프(1s→5s→30s) + 재동기화(재연결 시 히스토리 다시 로드).
- 초안(입력 중 텍스트) 유지.
- i18n(en 기본 / ko 로케일). XSS 안전(`textContent`+DOM 조립 원칙 유지 — React면 기본 이스케이프).
- 커스텀 타이틀바 + 화이트/하늘색 테마(시스템 다크 자동 추종). 설정창도 동일 테마.
- Phase 10: 모드 탭 → **영역 3개 네비로 승격/재편**(3.1).
- Phase 10: Code 폴더 empty state + **네이티브 폴더 선택**(Electron `engram:pick-folder` IPC, 2.6).

## 2.6 Electron 연동 이전

- `chat-preload.ts`의 `window.engramDesktop.pickFolder`(폴더 선택 IPC)는 유지 —
  클라(React)가 `window.engramDesktop`로 호출. preload 경로만 새 빌드에 맞게.
- `settings.html`은 이번 범위 밖(그대로 둠). 클라와 별개 창.
- electron-builder `files`: `src/desktop/chat.html` 제거 → `renderer/dist/**` 추가.
  transformers `.cache` 제외 등 기존 규칙 유지.

---

## 3. 영역 3개 (Chat / Ask / Code)

Phase 10의 Chat/Code 탭을 재편한다. Phase 10의 "Chat"(두뇌와 대화)은 실은 **Ask**이고,
여기에 진짜 **사람 채팅**이 새로 추가된다.

| 영역 | 무엇 | Engram 응답 | respondMode | Phase 11 |
|------|------|------------|-------------|----------|
| **채팅(Team)** | 사람·팀원과 대화 | **@멘션할 때만** | `mention` | 구조만, **flag로 숨김** |
| **챗봇(Ask)** | 두뇌에 직접(위키·협업·다이제스트·인사이트) | 전부 두뇌로 | `all` | **동작** |
| **코드(Code)** | 로컬 레포 코딩(레포 바인딩) | 레포 경로로 | — | **동작(로컬)** |

- 영역별 **채널 목록 분리**(Phase 10 유지). 새 채널은 현재 영역으로 생성.
- **채팅(사람) 영역 feature flag**: `config.ts`의 `features.teamChat=false`(기본). false면
  네비에서 탭 자체가 안 보임(visible=off) → 기능 봉인. 서버(Phase 14) 생기면 켠다.
  다 짓되 숨기는 이유: placeholder는 깨져 보이고, 코드를 두 번 안 짜려고.
- **Ask ↔ 기존 매핑**: `respondMode='all'`, `mode` 미설정(=chat). 기존 `route`/`handleMention`
  경로 그대로.
- **Code ↔ 기존 매핑**: `mode='code'` + `repoPath`. 기존 Phase 10 흐름(classify 건너뛰고
  startProposal) 그대로.

---

## 4. ws 프로토콜(타입화)

지금 self.adapter/chat.html이 주고받는 프레임을 **타입으로 고정**한다(신규 계약 아님 —
현행을 명문화 + `actions` 추가).

### 클라 → 서버
- `{ t:'channels' }` — 채널 목록 요청
- `{ t:'history', channelId, before? }` — 기록 요청
- `{ t:'send', channelId, text, threadId?, authorId? }` — 메시지 전송
- `{ t:'createChannel', name, mode? }` — 채널 생성
- `{ t:'deleteChannel', id }`
- `{ t:'setRepoPath', id, repoPath }`
- `{ t:'setRespondMode', id, mode:'all'|'mention' }`

### 서버 → 클라
- `{ t:'channels', list: Channel[] }`
- `{ t:'history', channelId, messages: Message[] }`
- `{ t:'msg', channelId, message: Message }`
- `{ t:'error', text }`

### 확장: `Message.actions`
```ts
interface Action { label: string; send: string; confirm?: string }
interface Message { id; authorId; text; ts; threadId?; actions?: Action[] }
```
- 서버가 결정 지점에서 `actions`를 실어 보낸다(5절).
- 블록 파싱 꼼수(` ```buttons `) **불채택** — 타입 프레임을 양쪽이 소유하므로 정식 필드가 맞다.
- `ChatStore`가 메시지에 `actions`를 실어 append/broadcast(옵셔널, 하위호환).

---

## 5. 클릭 승인/선택 버튼

**서버(Orchestrator)**: 기존 텍스트 프로토콜(`"1"`/`"승인"`/`"취소"`)은 그대로 두고,
결정 지점 post에 `actions`를 첨부한다(post 계약 확장은 구현 시 최소 침습으로 —
`post(text, actions?)` 옵셔널 인자 or 전용 게시). 두 지점:

1. **승인**(`startProposal`, 자율코딩 시작): `[{label:'✅ 승인', send:'승인', confirm:'자율 코딩을 시작할까요?'}, {label:'취소', send:'취소'}]`
2. **후보 선택**(`startCoding` 다중 매치): 후보마다 `{label:'1. C:/foo', send:'1'}` + `{label:'취소', send:'취소'}`

**클라(ActionButtons.tsx)**: 메시지에 `actions`가 있으면 버튼 줄 렌더. 클릭 시
- `confirm`이 있으면 네이티브 `confirm()` 한 번(Electron 지원 확인됨 — `window.prompt`만 미지원) → 확인해야 진행.
- `confirm` 없으면 즉시 `{t:'send', channelId, text: action.send}` 전송.
- **되돌릴 수 없는 것(승인)만 confirm, 선택/번호/취소는 즉시.**
- 전송 후 그 메시지의 버튼 비활성화(중복 전송 방지).

**서버 로직 변화 0**: 클릭이 보내는 건 기존 텍스트라 `pending` 상태머신이 그대로 처리.
label은 `textContent`로만 렌더(XSS), `send`는 ws로만 나감(DOM 안 들어감).

**Discord 등 다른 어댑터**: `actions`는 self 클라만 렌더. 다른 어댑터는 필드를 무시하고
프롬프트 텍스트로 폴백(타이핑 가능). 계약 하위호환.

---

## 6. 데이터 흐름(예: 승인 버튼)

1. 사용자 Ask/Code에서 코딩 요청 → `handleMention` → `startProposal` →
   `post('완성조건…', actions:[승인/취소])`.
2. `SelfMessenger.reply`가 `ChatStore.appendMessage`에 `actions` 실어 저장 →
   `{t:'msg', message:{…, actions}}` broadcast.
3. 클라가 메시지 렌더, `ActionButtons`가 [✅ 승인][취소] 표시.
4. [✅ 승인] 클릭 → `confirm()` → OK → `{t:'send', text:'승인'}`.
5. 서버 `handleMention`: `pending.kind==='approve'` + `'승인'` → `approveProject` → `launchCoding`.

---

## 7. 에러 처리

- ws 끊김: 기존 재연결 백오프 + 재동기화 유지. 연결 상태 점(dot) 표시.
- 두뇌 미기동: 대기 화면(기존) 유지, http 헬스 프로브로 준비 감지.
- 손상 프레임: `JSON.parse` 실패 시 무시(기존). 미지 `t`는 무시.
- 두뇌 crash 후 재기동: `did-fail-load` → 대기 화면 → 재프로브(기존 로직 이전).
- 버튼 중복 클릭: 클릭 후 비활성화. 스테일 버튼(오래된 메시지) 클릭 → 서버에 `pending`
  없으면 그 텍스트는 일반 대화로 흘러 무해(기존 성질).

## 8. 테스트 전략

- **`renderer/`(React 렌더러)**: Vitest + Testing Library. 순수/렌더 위주 —
  `protocol.ts` 타입, `ActionButtons`(confirm 게이트·send 페이로드·비활성화),
  마크다운/차트 렌더 스모크, ws client 훅(모의 소켓)의 재연결·재동기화.
- **서버**: 기존 Jest. `actions` 첨부 게시 단위(순수), `ChatStore.actions` 실림,
  `SelfMessenger`가 http에서 chat.html 안 서빙(헬스만) 회귀.
- **통합**: self ws로 승인 흐름(actions 프레임 왕복) 목 테스트.
- Electron 실동작(폴더 대화상자·loadFile·패키징)은 사용자 수동 스모크(기존 관례).

---

## 9. 마이그레이션·삭제

- 신규: `renderer/**`, `protocol.ts`(공유), electron-builder `files` 갱신, dev/build 스크립트
  (`renderer:dev`, `renderer:build`, `desktop:*`가 `renderer:build` 선행).
- 변경: `SelfMessenger`(http 헬스만), `main.ts`(loadFile + 프로브 진입), preload 경로.
- 삭제: `src/desktop/chat.html`(기능 `renderer/`로 이전 완료 후).

## 10. 성공 기준

- `desktop:build`로 설치본 빌드 → Electron이 React 클라 로드 → 로컬 두뇌 ws 연결.
- Ask 영역: 질문·협업·다이제스트/인사이트 동작. Code 영역: 폴더 선택·코딩 흐름 동작.
- **승인/선택이 버튼 클릭**으로 됨(승인은 confirm 한 번). 채팅(사람) 영역은 flag off로 안 보임.
- 현 chat.html 기능 회귀 0. 두뇌 코어 로직 무변경. 타입 ws 프로토콜로 프레임 계약 고정.
