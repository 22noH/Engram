# Phase 15a — 클라이언트 위키 (읽기 + 승인함) 설계

작성일: 2026-07-09
상태: 설계 확정(브레인스토밍 산출) — 구현 플랜 대기

---

## 0. 이 문서의 위치 — 큰 그림 속 조각

위키(지식 코어)는 지금까지 **두뇌만** 읽고 쓴다. 사람이 위키를 보거나, 두뇌가 대화에서
뽑아 올린 지식 **제안을 승인**하는 화면이 클라이언트에 없다. 승인은 `engram review`
**CLI에만** 있다. 팀은 채팅으로 두뇌와 대화만 할 뿐, 쌓이는 공용 지식을 보지도,
무엇이 위키에 들어갈지 승인하지도 못한다.

Phase 15는 "여러 Engram 지식을 한 공간으로"라는 큰 목표이고 3조각으로 분해했다:

| # | 조각 | 이번 |
|---|------|------|
| **15a (이번)** | **클라이언트 위키: 읽기 + 승인함** | 위키 보기 + 두뇌 제안을 클라에서 승인/거부 |
| 15b | 원격/중앙 저장(NAS·git 원격) | 저장 위치를 두뇌에서 분리·중앙화 |
| 15c | 여러 두뇌 동시 공유 | 공유 저장소 다중 두뇌 동시 쓰기 |

**15a 초점 재조정(사용자 지적)**: 이 플랫폼에서 위키가 채워지는 자연스러운 길은
"사람이 손으로 위키를 쓴다"가 아니라 **두뇌가 대화에서 지식을 제안 → 사람이 승인**이다.
그 결재 백엔드(ProposalStore·ProposalApplier)는 이미 완성돼 있고 **CLI에만 갇혀 있다.**
그래서 15a의 핵심은 **① 위키 읽기 + ② 승인함(approval inbox)**이다. 사람이 직접
페이지를 생성·편집하는 수동 CRUD는 부차적 → 후속으로 미룬다(§8).

---

## 1. 개념

`Wiki` 영역 = **선택된 두뇌(그 서버)의 공용 지식을 보고, 그 두뇌의 지식 제안을 승인하는
화면.** Phase 14에서 팀이 이미 그 두뇌에 접속해 있으니 곧 팀 공용 지식판 + 결재함이 된다.

- **네임스페이스** = 공유 위키 하나(`DEFAULT_USER`). 사용자별 분리는 Phase 16.
- **연결 스코프** = 선택된 두뇌(`defaultConnId`) 하나(Team 영역과 동형 — 위키는 두뇌별).
- **실시간** = 누가 승인/거부하면 그 두뇌에 접속한 다른 클라의 위키·승인함도 갱신(브로드캐스트).
- **동시성** = 승인 반영은 기존 페이지별 락(WikiEngine)로 직렬화·git 커밋.

## 2. 파괴 불가

15a는 **추가만 가능하고 파괴는 불가능**하다:
- **승인** = 제안을 위키에 반영(생성/추가/교체 → published + git 커밋). 지식이 는다.
- **거부** = 그 제안을 버림(pending → rejected). 그 제안은 **애초에 페이지가 아니었다**
  (라이브 위키 무손상).
- **하드 삭제·게시된 페이지 제거·수동 편집 없음**(15a 범위 밖). 따라서 위키가 소실될
  경로가 없다.
- 소유권 기반 권한(누가 무엇을 승인/편집할 수 있나)은 계정이 붙는 **Phase 16**에서.

---

## 3. 서버 설계

### 3.1 의존성 배선

`SelfMessenger`는 `main.ts`에서 수동 생성된다(`new SelfMessenger(chatCfg, chatStore, {logger})`).
위키·결재 3개를 **옵셔널 의존성 객체**로 추가하고 main.ts가 `app.get()`으로 넘긴다:

```ts
new SelfMessenger(chatCfg, chatStore, { logger }, {
  wiki: app.get(WikiEngine),
  proposals: app.get(ProposalStore),
  applier: app.get(ProposalApplier),
})
```

미주입(테스트 등) 시 wiki/proposal 프레임은 무시(no-op) — 하위호환. 세 서비스는 모두
`@Injectable` Nest provider라 `app.get` 가능(CLI gateway가 같은 방식으로 주입받음).

### 3.2 ws 프레임 (`shared/protocol.ts`)

전부 **인증 소켓만** 처리(Phase 13 auth 게이트가 auth 외 프레임을 막음).

**클라 → 서버:**
```ts
| { t: 'wikiList' }                          // 위키 페이지 목록
| { t: 'wikiGet'; slug: string }             // 페이지 전체
| { t: 'proposalsList' }                     // pending 제안 목록(승인함)
| { t: 'proposalApprove'; id: string }       // 승인 → 위키 반영
| { t: 'proposalReject'; id: string }        // 거부 → 버림
```

**서버 → 클라:**
```ts
| { t: 'wikiPages'; list: WikiPageMeta[] }   // 목록(메타)
| { t: 'wikiPage'; page: WikiPageDto }       // 단일 페이지 전체
| { t: 'proposals'; list: ProposalDto[] }    // pending 제안(승인함)
| { t: 'wikiChanged' }                       // 위키 변경 알림(브로드캐스트) → 목록/열린 페이지 갱신
| { t: 'proposalsChanged' }                  // 승인함 변경 알림(브로드캐스트) → 승인함 갱신
```

DTO(클라가 서버 내부 타입에 의존하지 않게 평탄화):
```ts
WikiPageMeta = { slug, title, category, status, updated }
WikiPageDto  = { slug, title, category, status, body, updated }
ProposalDto  = { id, op, targetSlug, title, category, payload, sources, importance,
                 confidence, reason, conflictSlugs }   // Proposal + verdict 평탄화
```

### 3.3 핸들러 매핑 (`self.adapter.ts`)

| 프레임 | 동작 | 서비스 |
|--------|------|--------|
| `wikiList` | `listPages()` → 메타 매핑 → `wikiPages`(요청 소켓) | `WikiEngine.listPages` |
| `wikiGet` | `getPage(slug)` → `wikiPage`; 없으면 error | `WikiEngine.getPage` |
| `proposalsList` | `listPending(DEFAULT_USER)` → DTO → `proposals`(요청 소켓) | `ProposalStore.listPending` |
| `proposalApprove` | `get(id)` → `applier.apply(p)`(위키 반영 + markApproved) → `wikiChanged` + `proposalsChanged` **브로드캐스트** | `ProposalStore.get` + `ProposalApplier.apply` |
| `proposalReject` | `get(id)` → `applier.reject(p)`(markRejected) → `proposalsChanged` 브로드캐스트 | `ProposalStore.get` + `ProposalApplier.reject` |

- 승인/거부는 존재하지 않는/이미 처리된 id면 조용히 무시(에러 없이 — 경합 안전).
- `applier.apply`는 op(create/append/supersede)를 이미 처리하고 락·git·색인을 WikiEngine에
  위임 → 어댑터는 위임만.
- 브로드캐스트는 인증 소켓만(기존 broadcast 게이트 재사용).

---

## 4. 클라이언트 설계 (renderer)

### 4.1 Wiki 영역

- `areaTabs`에 `wiki` 추가(Ask/Team/Code 옆 최상위 탭).
- **선택된 두뇌(`defaultConnId`)로 스코프**(위키는 두뇌별, 단일 연결).
- 진입 시 `wikiList` + `proposalsList` 전송.

### 4.2 레이아웃 (아티팩트 스타일)

Wiki 영역 안에 **두 탭/구획**:

**① 페이지(읽기)**
- 왼쪽: 페이지 목록(제목 + 상태 배지[draft/published] + 카테고리) + **필터 입력칸**
  (제목·본문 부분일치 클라 필터).
- 오른쪽: **아티팩트 스타일 문서**(기존 `render/markdown.ts` DOM 빌더 재사용, XSS 안전)
  — 제목·카테고리·렌더된 본문.

**② 승인함(Inbox)**
- pending 제안 카드 목록. 각 카드:
  - **무엇을**: op 배지(신규/추가/교체) + 대상 페이지(`targetSlug`, title).
  - **왜**: `reason` + 신뢰도(`confidence`) + 출처(`sources`) + 충돌 시 `conflictSlugs` 경고.
  - **내용 미리보기**: `payload`를 마크다운 렌더.
  - **[승인] [거부]** 버튼.
- 대기 건수 배지(탭에 N).

아티팩트 느낌(타이포·여백·문서/카드)은 구현 시 frontend-design 스킬로 다듬는다.

### 4.3 데이터 흐름

- 진입 → `wikiList`→페이지 목록, `proposalsList`→승인함.
- 페이지 클릭 → `wikiGet{slug}` → 문서 렌더.
- 승인 클릭 → `proposalApprove{id}` → 서버 반영 + `wikiChanged`·`proposalsChanged`
  브로드캐스트 → 모든 클라가 위키 목록·승인함 갱신.
- 거부 클릭 → `proposalReject{id}` → `proposalsChanged` 브로드캐스트.
- `wikiChanged` 수신: `wikiList` 재요청(+ 열린 페이지면 `wikiGet` 재요청).
- `proposalsChanged` 수신: `proposalsList` 재요청.

### 4.4 필터·검색

- 15a는 **클라 필터**(목록에서 제목·본문 부분일치)만. 의미검색(RAG)은 이미 Ask 채널이
  담당 → 15a 비범위.

---

## 5. 문서 (README)

"클라이언트 UI"에 Wiki 영역 추가:
- Wiki 탭 = 그 서버 두뇌의 공용 지식 + **승인함**.
- 두뇌가 대화에서 뽑은 지식 제안이 승인함에 뜬다 → 승인하면 위키에 반영, 거부하면 버림.
  (`engram review` CLI와 같은 결재를 클라에서.)
- 실시간으로 다른 접속자에게 반영. **삭제·수동편집은 없다**(추가만 — 파괴 불가). 소유권
  권한·수동 편집은 이후 단계.

---

## 6. 테스트

**서버(self.adapter.spec, 가짜 WikiEngine/ProposalStore/Applier 주입):**
- `wikiList` → 페이지 메타 목록.
- `wikiGet` → 페이지 전체; 없는 slug → error.
- `proposalsList` → pending 제안 DTO 목록.
- `proposalApprove` → applier.apply 호출 + `wikiChanged`·`proposalsChanged` 브로드캐스트.
- `proposalReject` → applier.reject 호출 + `proposalsChanged` 브로드캐스트.
- 없는/처리된 id 승인·거부 → 조용히 무시(에러 없음).
- 의존성 미주입 시 wiki/proposal 프레임 no-op(하위호환).

**클라(renderer):**
- Wiki 영역 페이지 목록·상태 배지·필터.
- 문서 보기(마크다운 렌더).
- 승인함 카드(op/대상/이유/신뢰도/payload 미리보기) 렌더.
- 승인/거부 버튼 → `proposalApprove`/`proposalReject` 프레임 전송.
- `wikiChanged`/`proposalsChanged` 수신 시 각각 재요청.

---

## 7. 파일 영향 요약

| 파일 | 변경 |
|------|------|
| `shared/protocol.ts` | wiki/proposal 프레임 + `WikiPageMeta`/`WikiPageDto`/`ProposalDto` |
| `src/edge/messenger/self.adapter.ts` | 위키·결재 옵셔널 주입 + wiki/proposal 핸들러 + 브로드캐스트 |
| `src/main.ts` | `app.get(WikiEngine/ProposalStore/ProposalApplier)` → SelfMessenger에 전달 |
| `renderer/src/areas.ts` | `wiki` 탭 |
| `renderer/src/components/Wiki*.tsx` | (신규) 위키 영역: 페이지 읽기 + 승인함 |
| `renderer/src/App.tsx` | wiki 영역 배선(진입 시 wikiList/proposalsList, get/approve/reject, 변경 브로드캐스트 갱신, 단일연결 스코프) |
| `renderer/src/i18n.ts` | wiki/승인함 UI 문구 |
| `README.md` | Wiki 영역·승인함 사용법 |

**두뇌 코어·오케스트레이터·WikiEngine·ProposalStore·ProposalApplier 로직 무변경** —
기존 메서드만 ws로 노출한다. 신규 백엔드 메서드 없음.

---

## 8. YAGNI로 자른 것 (되살릴 신호)

- **사람 수동 CRUD(직접 생성·편집·게시된 페이지 수정)** → 후속 슬라이스(교정용). 15a는
  읽기+승인에 집중.
- **하드 삭제 / 게시된 페이지 숨기기·제거 / 소유권 권한 / 작성자 신원** → Phase 16(계정) 또는 관리 후속.
- **의미검색(RAG) 위키 노출** → 이미 Ask 담당.
- **중앙/원격 저장(NAS·git 원격)** → 15b. **여러 두뇌 동시 쓰기** → 15c.
- **사용자별 위키 네임스페이스** → Phase 16.
