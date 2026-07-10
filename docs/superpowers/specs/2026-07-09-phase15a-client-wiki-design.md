# Phase 15a — 클라이언트 위키 (보기/편집) 설계

작성일: 2026-07-09
상태: 설계 확정(브레인스토밍 산출) — 구현 플랜 대기

---

## 0. 이 문서의 위치 — 큰 그림 속 조각

위키(지식 코어)는 지금까지 **두뇌만** 읽고 쓴다 — 대화에서 지식을 뽑아 저장(digest),
결재 승인 등. **사람이 위키를 직접 보거나 편집하는 화면은 없다.** 팀은 채팅으로
두뇌와 대화만 할 뿐, 쌓인 공용 지식을 눈으로 못 본다.

Phase 15는 "여러 Engram 지식을 한 공간으로"라는 큰 목표이고, 사용자와 3조각으로
분해했다:

| # | 조각 | 이번 |
|---|------|------|
| **15a (이번)** | **클라이언트 위키 보기/편집** | 연결된 두뇌의 위키를 목록·읽기·편집(아티팩트 스타일) |
| 15b | 원격/중앙 저장(NAS·git 원격) | 저장 위치를 두뇌에서 분리·중앙화 |
| 15c | 여러 두뇌 동시 공유 | 공유 저장소에 다중 두뇌 동시 쓰기(분산 락·색인 소유권) |

**15a부터 하는 이유**: 위키가 사람에게 안 보이면 15b·15c를 해도 의미가 없다.
15a는 클라이언트가 두뇌에게 "위키 페이지 줘/저장해"라고 ws로 묻는 방식이라, 그 두뇌의
위키가 **로컬에 있든 나중에 NAS에 있든 똑같이 동작**한다 — 15b가 저장을 옮겨도 재사용된다.

**핵심 결정 — 하드 삭제 없음(파괴 불가).** 아래 §2 참조. 진짜 소유권 기반 권한은
계정이 붙는 Phase 16에서.

---

## 1. 개념 — 두뇌 위키의 사람용 창

`Wiki` 영역 = **선택된 두뇌(그 서버)의 공용 위키를 보고 편집하는 화면.** Phase 14에서
팀이 이미 그 두뇌에 접속해 있으니, 위키를 보여주기만 하면 곧 팀 공용 지식판이 된다.

- **네임스페이스** = 공유 위키 하나(`DEFAULT_USER`). 사용자별 분리는 Phase 16.
- **연결 스코프** = 선택된 두뇌(`defaultConnId`) 하나(Team 영역과 동형 — 위키는 두뇌별).
- **실시간 협업** = 누가 저장/게시하면 그 두뇌에 접속한 다른 클라 화면도 갱신(브로드캐스트).
- **동시성** = 기존 페이지별 락(KeyedLock, 충돌 안전). 본문은 마지막 저장 우선(천장).

---

## 2. 파괴 불가 원칙 (삭제 대신 숨기기)

신원이 검증되지 않는 단계다(모두 같은 토큰 + 자가선언 닉네임). "본인이 만든 것만
삭제" 같은 소유권 강제는 계정(Phase 16)이 있어야 가능하다. 그래서 **15a는 되돌릴 수
없는 파괴를 아예 만들지 않는다:**

- **하드 삭제 없음** — `wikiDelete`·`WikiEngine.deletePage` 미구현.
- **"치우기" = 숨기기(unpublish)**: published→draft. 두뇌 RAG 색인에서 빠져(Ask에서
  안 뜸) 활성 지식에서 제외되지만, **.md 파일·git 이력은 그대로** → 목록에 draft로
  남고 다시 게시 가능. `WikiEngine.unpublishPage`(기존)가 정확히 이 동작.
- **편집(덮어쓰기)도 git 버전관리** → 복구 가능.
- 결과: 누가 무엇을 해도 위키가 영구히 소실될 경로가 없다.

작성자/승인자 신원 기록과 소유권 기반 권한은 **Phase 16**(계정)에서 이 위에 얹는다.
15a는 페이지 frontmatter 스키마를 건드리지 않는다(Phase 16이 신원 모델과 함께 설계).

---

## 3. 서버 설계

### 3.1 WikiEngine 접근 배선

`SelfMessenger`는 현재 `main.ts`에서 `new SelfMessenger(chatCfg, chatStore, {logger})`로
수동 생성된다(Nest DI 아님). WikiEngine을 **옵셔널 4번째 인자**로 추가하고, `main.ts`가
`app.get(WikiEngine)`으로 꺼내 넘긴다(있을 때만 wiki 프레임 처리).

```ts
new SelfMessenger(chatCfg, chatStore, { logger }, wikiEngine)
```

WikiEngine 미주입(예: 테스트 일부) 시 wiki 프레임은 무시(no-op) — 하위호환.

### 3.2 ws 프레임 (`shared/protocol.ts`)

전부 **인증된 소켓만** 처리된다(Phase 13 auth 게이트가 이미 auth 외 프레임을 막음).

**클라 → 서버:**
```ts
| { t: 'wikiList' }
| { t: 'wikiGet'; slug: string }
| { t: 'wikiSave'; slug: string; title: string; category: string; body: string; status?: 'draft' | 'published' }
| { t: 'wikiPublish'; slug: string; publish: boolean }
```

**서버 → 클라:**
```ts
| { t: 'wikiPages'; list: WikiPageMeta[] }               // 목록(메타만)
| { t: 'wikiPage'; page: WikiPageDto }                   // 단일 페이지 전체
| { t: 'wikiChanged'; slug: string }                     // 저장/게시 변경 알림(브로드캐스트)
```

`WikiPageMeta = { slug, title, category, status, updated }`.
`WikiPageDto = { slug, title, category, status, body, updated }`(frontmatter 평탄화 —
클라가 WikiPage 전체 타입에 의존하지 않게).

### 3.3 핸들러 매핑 (`self.adapter.ts`)

| 프레임 | 동작 | WikiEngine |
|--------|------|-----------|
| `wikiList` | `listPages()` → 메타 매핑 → `wikiPages` 응답(요청 소켓) | `listPages()` |
| `wikiGet` | `getPage(slug)` → `wikiPage` 응답(없으면 error) | `getPage` |
| `wikiSave` | 없으면 `createPage`(status 기본 **published** — 사람=신뢰 편집자), 있으면 `updatePage` → `wikiChanged` **브로드캐스트** | `getPage`/`createPage`/`updatePage` |
| `wikiPublish` | publish=true→`publishPage`, false→`unpublishPage` → `wikiChanged` 브로드캐스트 | `publishPage`/`unpublishPage` |

- `wikiSave`의 사람 생성 기본 status=`published`(두뇌 초안과 달리 승인 우회 — 사람이 승인자).
- 브로드캐스트는 인증 소켓만(기존 broadcast 게이트 재사용).
- WikiEngine 메서드가 락·git·색인을 이미 처리 → 어댑터는 위임만.

---

## 4. 클라이언트 설계 (renderer)

### 4.1 Wiki 영역

- `areaTabs`에 `wiki` 추가(Ask/Team/Code 옆). 최상위 탭.
- **선택된 두뇌(`defaultConnId`)로 스코프** — 위키는 두뇌별(Team 스코프 패턴 재사용
  가능: 위키는 채널 머지 대상 아님, 단일 연결).
- Wiki 영역 진입 시 `wikiList` 전송 → 목록 렌더.

### 4.2 레이아웃 (아티팩트 스타일)

- **왼쪽 사이드바**: 페이지 목록(제목 + 상태 배지[draft/published] + 카테고리) +
  **필터 입력칸**(제목·본문 부분일치 클라 필터). "새 페이지" 버튼.
- **오른쪽 문서 패널** (아티팩트 스타일 — 깔끔한 문서):
  - **보기 모드**: 제목·카테고리·**렌더된 마크다운 본문**(기존 `render/markdown.ts`
    DOM 빌더 재사용 — XSS 안전). 상단에 상태 배지·편집/게시 버튼.
  - **편집 모드**(편집 토글): 제목·카테고리 입력 + 원문 마크다운 `textarea` + 저장/취소.
  - **게시/숨기기 토글**: `wikiPublish`.
- 아티팩트 느낌(타이포·여백·문서 카드)은 구현 시 frontend-design 스킬로 다듬는다.

### 4.3 데이터 흐름

- 진입 → `wikiList` → 목록.
- 페이지 클릭 → `wikiGet{slug}` → 문서 렌더.
- 저장 → `wikiSave` → 서버 저장 + `wikiChanged` 브로드캐스트 → 모든 클라가 목록/열린
  페이지 갱신.
- 게시/숨기기 → `wikiPublish` → 브로드캐스트.
- `wikiChanged{slug}` 수신: 목록 재요청(`wikiList`), 그 slug가 열려 있으면 `wikiGet` 재요청.

### 4.4 필터·검색

- 15a는 **클라이언트 필터**(목록에서 제목·본문 부분일치)만. 즉시·서버작업 0.
- 의미검색(RAG)은 이미 Ask 채널(두뇌)이 담당 → 15a 비범위(원하면 후속에 `wikiSearch`
  프레임으로 `RagStore.search` 노출).

---

## 5. 문서 (README)

"클라이언트 UI" 안내에 Wiki 영역 추가:
- Wiki 탭 = 그 서버 두뇌의 공용 지식 위키. 목록·읽기·편집·게시.
- 사람 편집은 즉시 게시(published), 실시간으로 다른 접속자에게 반영.
- **삭제는 없다** — "치우기"는 숨기기(draft로 내림)이고 되돌릴 수 있다. git 이력으로
  편집도 복구 가능. 소유권 기반 권한은 이후(계정) 단계.

---

## 6. 테스트

**서버(self.adapter.spec):**
- `wikiList` → 페이지 메타 목록.
- `wikiGet` → 해당 페이지 전체; 없는 slug → error.
- `wikiSave`(신규) → createPage 호출·published 기본·`wikiChanged` 브로드캐스트.
- `wikiSave`(기존) → updatePage 호출·브로드캐스트.
- `wikiPublish` true/false → publish/unpublish·브로드캐스트.
- WikiEngine 미주입 시 wiki 프레임 no-op(하위호환).
- 인증 게이트: 미인증 소켓의 wiki 프레임 미처리(기존 auth 테스트로 커버 — wiki도 동일 경로).

**클라(renderer):**
- Wiki 영역 목록 렌더·상태 배지.
- 필터(제목·본문 부분일치).
- 보기↔편집 토글, 저장 시 `wikiSave` 프레임 전송(제목/카테고리/본문).
- 게시/숨기기 버튼 → `wikiPublish` 전송.
- `wikiChanged` 수신 시 목록/열린 페이지 갱신.

---

## 7. 파일 영향 요약

| 파일 | 변경 |
|------|------|
| `shared/protocol.ts` | wiki 프레임(wikiList/Get/Save/Publish, wikiPages/Page/Changed) + `WikiPageMeta`/`WikiPageDto` |
| `src/edge/messenger/self.adapter.ts` | WikiEngine 옵셔널 주입 + wiki 프레임 핸들러 + wikiChanged 브로드캐스트 |
| `src/main.ts` | `app.get(WikiEngine)` → SelfMessenger에 전달 |
| `renderer/src/config.ts` | `WIKI` 영역 flag(또는 areaTabs 확장) |
| `renderer/src/areas.ts` | `wiki` 탭 |
| `renderer/src/components/Wiki*.tsx` | (신규) 위키 영역: 목록·필터·문서 보기/편집 |
| `renderer/src/App.tsx` | wiki 영역 배선(진입 시 wikiList, get/save/publish, wikiChanged 갱신, 단일연결 스코프) |
| `renderer/src/i18n.ts` | wiki UI 문구 |
| `README.md` | Wiki 영역 사용법 |

두뇌 코어·오케스트레이터·WikiEngine 메서드 자체(신규 추가 없음 — 기존 것만 호출)
무변경. WikiEngine에 신규 메서드 추가 없음(하드 삭제 미구현).

---

## 8. YAGNI로 자른 것 (되살릴 신호)

- **하드 삭제 / 소유권 기반 권한 / 작성자 신원 기록** → Phase 16(계정).
- **의미검색(RAG) 위키 노출** → 이미 Ask가 담당. 위키 화면 안 검색이 필요하면 후속.
- **중앙/원격 저장(NAS·git 원격)** → 15b.
- **여러 두뇌 동시 쓰기** → 15c.
- **사용자별 위키 네임스페이스** → Phase 16.
- **편집 충돌 병합(동시 편집 머지)** → last-write-wins + git 복구로 충분. 실시간
  공동편집이 필요하면 후속.
