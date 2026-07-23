# Quiet Library 디자인 적용 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 승인된 Quiet Library 디자인 시스템(토큰·세리프=지식 시그니처)을 앱 렌더러·데스크톱 설정창·웹 콘솔 세 표면에 적용.

**Architecture:** 기존 CSS 변수명 유지+값 교체(회귀 최소) + 신규 토큰 추가. 폰트는 @fontsource npm 패키지로 로컬 번들(렌더러·콘솔 — vite가 woff2 동봉). 기능 DOM 불변, 표현용 라벨만 추가.

**Tech Stack:** CSS 변수·@fontsource/inter·@fontsource/newsreader(OFL)·vite. 코드 로직 변경 0.

**Spec:** `docs/superpowers/specs/2026-07-23-quiet-library-design.md` — 토큰 표(라이트/다크 hex 전부)·타이포 스케일·컴포넌트 규칙. **모든 hex 값은 스펙 표에서 verbatim 복사**(이 플랜에 중복 기재하지 않음 — 스펙이 단일 진실원).

## Global Constraints

- 기능 배치·기존 클래스명·기능 DOM 유지. 순수 표현용 정적 요소(눈썹 라벨)만 추가 — 동작·핸들러·기존 테스트 셀렉터 무영향.
- 문구 변경 없음·신규 기능 0·그림자/그라데이션 금지·라이트/다크는 기존 `prefers-color-scheme` 그대로.
- 폰트 로컬 번들(런타임 네트워크 요청 0). 세리프는 지식 표면만: 위키 본문·제목·사이드바 Wiki 항목(이탤릭). 채팅 내 위키 유래 메시지 식별은 신뢰 식별자 없으면 스킵(1차=위키 영역만) — 구현자가 실코드 확인 후 보고서에 결정 기록.
- 콘솔·설정창은 세리프 미사용(색·간격·눈썹만). 설정창(settings.html, 번들러 없음)은 폰트 파일 미동봉 — 색 토큰+시스템 산세리프 스택만.
- 검증: 각 태스크에서 해당 표면 전체 테스트+빌드. jsdom 테스트는 스타일 값에 무의존이므로 실패 시 = 기능 DOM을 건드렸다는 신호로 취급하고 원인 제거(테스트 수정으로 우회 금지, 표현용 추가가 셀렉터를 깨면 추가 방식을 바꿀 것).
- 커밋 Co-Authored-By 금지·무관 더티 파일 스테이징 금지·jest 포그라운드.

---

### Task 1: 렌더러 — 폰트 번들 + 토큰 교체

**Files:**
- Modify: `renderer/package.json`(+@fontsource 의존성), `renderer/src/main.tsx` 또는 엔트리(@fontsource import), `renderer/src/theme.css`(:root 라이트/다크 값 교체+신규 토큰+body font-family)

**Interfaces:**
- Consumes: 스펙 토큰 표.
- Produces(T2가 사용): CSS 변수 — 기존 `--bg --panel --line --text --dim --accent --accent-soft --accent-line --accent-text --hover --code-bg --pre-bg` 값 교체 + 신규 `--panel-2 --faint --me-bg --me-line --danger --font-serif`. body는 `font-family: 'Inter', system-ui, ...` 13px.

- [ ] **Step 1: 의존성** — `npm --prefix renderer i @fontsource/inter @fontsource/newsreader` 후 엔트리에서 필요한 웨이트만 import(Inter 400/500/600, Newsreader 400/500/600+italic — @fontsource 서브패스 import 방식은 패키지 README/설치된 파일 구조 확인). vite build로 woff2 동봉 확인.
- [ ] **Step 2: 토큰 교체** — theme.css :root(라이트)와 `@media (prefers-color-scheme: dark)` 블록의 값을 스펙 표 verbatim으로 교체, 신규 토큰 추가. `--font-serif: 'Newsreader', 'Noto Serif KR', 'Batang', Georgia, serif`. 기존 셀렉터의 하드코딩 색(있다면 grep `#[0-9a-f]{3,6}` in theme.css)을 토큰으로 정리.
- [ ] **Step 3: 검증·커밋** — `npm --prefix renderer test -- --run` 전체 green(스타일 값 교체는 무영향이어야 함)·`npm run renderer:build`(정확한 스크립트명 package.json 확인) clean·산출물에 woff2 포함+네트워크 URL 참조 0 확인(grep dist에 fonts.googleapis 없음). `git commit -m "feat(design): Quiet Library 토큰+폰트 번들(렌더러) — 값 교체·회귀 0"`

---

### Task 2: 렌더러 — 컴포넌트 폴리시(위키 세리프·눈썹·버블·카드·모달)

**Files:**
- Modify: `renderer/src/theme.css`(대부분), `renderer/src/components/WikiArea.tsx`(눈썹 줄·본문 래퍼 — 표현용 정적 추가만), `renderer/src/App.tsx`(사이드바 섹션 눈썹 라벨 — 표현용), 관련 컴포넌트의 표현용 클래스 추가가 필요한 곳(최소).

**Interfaces:**
- Consumes: T1 토큰.
- Produces: 스펙 컴포넌트 규칙 반영 —
  - 메시지: Engram=`--panel-2`, 나=`--me-bg`/`--me-line`, 타인=`--code-bg`, 타임스탬프 `--faint`. radius 10px.
  - qcard: 토큰 재적용(선택 칩 accent·비선택 `--line` 톤) — 구조 무변경.
  - 위키 읽기: 눈썹(카테고리·갱신일 — 10px 대문자 ls1.2px accent)→세리프 제목 21px/600→세리프 본문 14.5px/1.75·`max-width:62ch`→컨트롤 산세리프(Unpublish=`--danger`). WikiArea에 이미 있는 데이터(category·updated)로 눈썹 구성 — 없으면 스킵하고 보고.
  - 사이드바: 섹션 눈썹 라벨(CHANNELS·KNOWLEDGE — i18n 신규 키가 아니라 정적 영어 라벨? → **아니오, 문구는 i18n 규칙 적용**: `T.sideChannels`/`T.sideKnowledge` 신규 키 en/ko 추가는 허용된 표현용 추가) + Wiki 항목 세리프 이탤릭. 활성 채널 = `--accent-soft`+2px 우측 바(기존 유지).
  - 모달(ManageEngrams·ChannelMembers·팔레트): 토큰 정리+섹션 라벨 눈썹화(기존 .sectionLabel 재스타일).
- [ ] **Step 1: 구현** — theme.css 중심, DOM 추가는 표현용 최소(핸들러·기존 셀렉터 무영향). 각 추가 요소에 기존 테스트 영향 없는지 실행으로 확인.
- [ ] **Step 2: 검증·커밋** — 렌더러 전체 테스트 green(실패=기능 DOM 침범 신호, 원인 제거)·빌드 clean. `git commit -m "feat(design): 위키 세리프·눈썹·버블/카드/모달 폴리시(렌더러)"`

---

### Task 3: 데스크톱 설정창(settings.html) 색 토큰

**Files:**
- Modify: `src/desktop/settings.html`(인라인 CSS의 색 값들을 스펙 토큰 값으로 교체 — CSS 변수 블록 도입, 라이트/다크 모두)

**Interfaces:** 색·간격 토큰만(폰트는 시스템 산세리프 스택 유지 — 번들러 없음). 기존 id/구조·인라인 스크립트 무변경.

- [ ] **Step 1: 구현** — :root+다크 미디어쿼리로 스펙 값 이식, 기존 하드코딩 색 교체. 위험 지점: 기존 기능성 스타일([hidden] 규칙 등) 유지.
- [ ] **Step 2: 검증·커밋** — desktop 테스트 스위트 green·`npm run build` clean(settings.html은 정적 — 육안 검증은 T5). `git commit -m "feat(design): 설정창 Quiet Library 색 토큰"`

---

### Task 4: 웹 콘솔(/admin) 토큰

**Files:**
- Modify: `console/src`의 전역 CSS(파일 구조 확인 — index.css/theme 류)·필요시 @fontsource/inter를 console/package.json에 추가(콘솔은 vite라 번들 가능). 세리프 미사용.

**Interfaces:** 스펙 색·간격·눈썹 토큰. 기존 컴포넌트 구조·클래스 무변경.

- [ ] **Step 1: 구현** — 콘솔 CSS 변수 교체(+다크 대응이 기존에 있으면 다크 값도, 없으면 라이트만+보고). Inter 번들.
- [ ] **Step 2: 검증·커밋** — 콘솔 테스트 전체 green·콘솔 빌드 clean·백엔드 full `npm test`(console/dist 동봉 경로 회귀 0). `git commit -m "feat(design): 웹 콘솔 Quiet Library 토큰"`

---

### Task 5: 실기기 육안 검증 + 픽스 패스

**Steps:**
- [ ] **Step 1: 렌더러 dev 서버 실측** — vite dev 서버 띄워 브라우저로 채팅(버블 3종·질문카드·팔레트)·위키(세리프 본문·눈썹)·모달 화면을 라이트/다크 각각 스크린샷. CSS 실측 버그(잘림·겹침·대비 부족·폰트 미적용) 발견 시 즉시 픽스.
- [ ] **Step 2: 콘솔·설정창 실측** — 콘솔 dev(또는 빌드 서빙)·설정창 파일 열기로 동일 확인.
- [ ] **Step 3: 마무리** — 전체 테스트·빌드 재확인 후 픽스 커밋 `fix(design): 실측 폴리시 픽스(발견 항목 나열)`. 발견 0이면 검증 결과만 원장에 기록.

---

## Self-Review 결과

- 스펙 커버: 토큰(T1)·렌더러 컴포넌트+시그니처(T2)·설정창(T3)·콘솔(T4)·실측 검증(T5). 비목표(구조 재설계·모션 시스템) 미포함.
- hex 중복 없음: 스펙 표가 단일 진실원, 플랜은 참조만.
- 불확실(구현 중 확정·보고): @fontsource 서브패스 import 형태·renderer 빌드 스크립트명·WikiArea에 category/updated 데이터 존재 여부·콘솔 다크 모드 기존 지원 여부·채팅 내 위키 유래 메시지 식별자(없으면 스킵).
- 함정 명시: 테스트 실패=기능 DOM 침범 신호(테스트 수정 우회 금지)·폰트 네트워크 참조 0 검증·기능성 CSS([hidden]) 유지.

---

## 라운드 2 (사용자 승인 목업 — 2026-07-23)

### Task R2-1: 탭 명칭·순서 + 중앙 고정폭 채팅

**Files:**
- Modify: `renderer/src/i18n.ts`(tabAsk→'Chat'·tabTeam→'Team'·tabCode→'Code' — 양 로케일 공통 고유명, Wiki/Admin 유지), 탭 순서 소스(`areaTabs` — renderer 내 위치 grep)에서 **Team 최전방**(Team·Chat·Code·Wiki·Admin, 기본 선택 모드는 기존 유지), `renderer/src/theme.css`+필요시 App.tsx(채팅 칼럼 중앙 고정 — 메시지 목록+입력창을 max-width 760px·margin auto 칼럼으로, 사이드바 불변. 순수 표현용 래퍼 1개 허용).
- 기존 테스트의 라벨/순서 의존은 의도 변경이므로 갱신 정당(의도 보존 확인 필수).

- [ ] Step 1: 구현+렌더러 전체 테스트 green+빌드 clean.
- [ ] Step 2: `git commit -m "feat(design): 탭 Team·Chat·Code 개명+Team 최전방+채팅 중앙 고정폭 칼럼(760px)"`

### Task R2-2: Admin 탭 재설계(목업 ② 픽셀)

**Files:**
- Modify: `renderer/src/components/AdminArea.tsx`(+test), `renderer/src/theme.css`, `renderer/src/i18n.ts`(필요 문구 en/ko)

목업 ② 요소: 눈썹(WORKSPACE · N MEMBERS)+제목 / 승인 대기=상단 앰버톤 하이라이트 카드(Approve 주버튼·Reject는 danger 텍스트) / 멤버=카드 리스트(이니셜 아바타·이름+Owner/Active 필·권한 칩[+추가 칩은 대시 보더]·행 ⋯ 메뉴로 suspend/reset-password/권한 토글 이동) / SERVER SETTINGS 눈썹 섹션(서버명 입력·SSO 상태). **기능 패리티 유지**: 기존 AdminArea의 모든 액션(approve/suspend/restore/reset/forceLogout/권한 setPermissions/설정 저장) 전부 새 UI에서 도달 가능해야 함 — 누락 금지. ws 프레임·App 배선 무변경(프레젠테이션 재구성만).

- [ ] Step 1: 구현+기존 AdminArea 테스트 의도보존 갱신+전체 green+빌드.
- [ ] Step 2: `git commit -m "feat(design): Admin 탭 재설계(승인 대기 하이라이트·멤버 카드·권한 칩·눈썹 섹션) — 목업 픽셀·기능 패리티"`
