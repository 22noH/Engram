# 서버 콘솔 S1(코어: 서빙+셋업+로그인+개요) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 브라우저로 `http://서버:포트/admin` 접속 → 셋업 마법사(1회) → owner 로그인 → 개요 화면. 서버 에디션 웹 콘솔의 뼈대.

**Architecture:** 새 `console/` vite 앱(확정 목업의 토큰·문법 그대로) → 빌드 산출물을 self.adapter http 서버가 `/admin`에서 정적 서빙 → `/admin/api/*`는 owner 세션 필수 게이트 → 개요 통계 API 1개. 인증은 기존 /auth/setup·/auth/login 재사용(신규 인증 발명 금지). 스펙: `docs/superpowers/specs/2026-07-19-server-edition-design.md` · **확정 목업: `docs/superpowers/mockups/2026-07-19-server-console.html`(①셋업·②개요가 이 플랜 범위 — 픽셀 기준)**

**Tech Stack:** console/ = vite+react+ts(renderer와 동일 스택·버전). 신규 dep 없음(renderer package.json 관성 복제).

**서브페이즈 로드맵(이 플랜은 S1만):** S2 사람 관리(멤버 직접 생성·그룹 신규 모델·채널) → S3 설정 이관(모델·MCP·위키·서버 설정·preset) → S4 상태·로그+대화 보존(/clear 공유) → S5 배포물(engram-server CLI·서비스 설치).

## Global Constraints

- **UI는 확정 목업과 픽셀 일치** — 목업의 셋업 카드·개요(통계 타일 4개+처리할 일 리스트)·네비(10항목, 미구현 섹션은 자리+"곧 제공" 비활성 상태로 렌더). 목업에 없는 요소 추가 금지(실데이터 제약으로 불가피하면 보고서에 명시하고 컨트롤러가 사용자 승인 후 목업 갱신).
- 인증: 기존 /auth/setup(1회용 코드)·/auth/login·세션 토큰 재사용. `/admin/api/*`는 **owner 세션만**(다른 role 403). 헤더 신뢰 금지.
- `/admin` 서빙은 authDeps 주입된 서버(=서버 모드)에서만 — brain 모드·데스크톱 스탠드얼론(미설정+localFree)은 404 유지(콘솔은 서버 에디션 물건). 단 미설정+계정 생성 전이라도 셋업 마법사는 서버 모드에서 접근 가능해야 함(셋업이 첫 관문).
- 정적 서빙 보안: path traversal 차단(정규화 후 루트 밖 접근 404), 콘텐츠 타입 화이트리스트.
- UI 문구 en 기본+ko(직역체 금지). PowerShell·jest/vitest 포그라운드만. 커밋 Co-Authored-By 금지. 무관 더티 파일 스테이징 금지.

---

### Task 1: console/ 앱 뼈대 — 셋업 마법사·로그인·개요(목업 그대로)

**Files:**
- Create: `console/` (vite react-ts 앱: package.json·vite.config.ts·index.html·src/{main.tsx,App.tsx,api.ts,i18n.ts,theme.css}·src/views/{Setup.tsx,Login.tsx,Overview.tsx}·src/components/Nav.tsx + vitest 설정·테스트)
- Modify: 루트 `package.json` scripts(`console:install`·`console:build`·`console:test`)

**Interfaces:**
- Consumes: `/auth/status`(configured·serverName)·`/auth/setup {code,loginId,password}`·`/auth/login {loginId,password}`(기존 — 시그니처는 src/edge/auth/auth-http.ts에서 확인) · T2의 `/admin/api/overview`.
- Produces: `console/dist/`(T2가 서빙) — 라우팅: status.configured=false→Setup, 세션 없음→Login, 있음→Overview(네비 포함). 세션 토큰은 localStorage(`engram.console.session`), api.ts가 Authorization 헤더로 전달(T2 게이트 계약).

- [ ] **Step 1: 목업의 토큰·CSS를 console/src/theme.css로 이식하고 Setup·Login·Overview·Nav를 목업 픽셀 그대로 구현.** 네비 10항목 중 S1 미구현 8개는 비활성(dim+커서 기본·툴팁 "곧 제공"/"Coming soon").
- [ ] **Step 2: TDD(vitest)** — ①미설정 상태=Setup 렌더(코드·아이디·비번 3필드) ②setup 성공 시 Overview 전환+토큰 저장 ③configured+무세션=Login ④로그인 성공=Overview(타일 4개+처리할 일) ⑤api 401 응답=Login 복귀.
- [ ] **Step 3: 검증·커밋** — `npm --prefix console test -- --run` PASS·`npm run console:build` clean. `git commit -m "feat(console): 콘솔 앱 뼈대 — 셋업 마법사·로그인·개요(확정 목업 픽셀 기준)"`

---

### Task 2: 서버 — /admin 정적 서빙 + owner 게이트 + 개요 API

**Files:**
- Modify: `src/edge/messenger/self.adapter.ts`(+spec) — /admin 라우팅, Create: `src/edge/admin/admin-http.ts`(+spec) — 정적 서빙+api, `src/main.ts` — 배선

**Interfaces:**
- Consumes: T1 console/dist(경로 해석: 패키징 고려 — resolveResourceFile/prompts 로딩 관성 참고), 기존 AccountStore(count·list)·SessionStore(resolve)·ChatStore(listChannels)·WikiEngine(페이지 수)·ProposalStore(대기 수).
- Produces:
  - `GET /admin`·`/admin/*` → console/dist 정적 서빙(index.html 폴백 — SPA 라우팅). authDeps 있는 서버에서만.
  - `GET /admin/api/overview` → `{ members, pendingMembers, channels, wikiPages, pendingProposals, todayMessages }` — **owner 세션 필수**(Authorization: Bearer <token> → sessions.resolve → role==='owner' 아니면 403; 미설정 서버(계정 0)는 overview 자체가 401 — 셋업 전에 데이터 노출 금지).
  - todayMessages: 오늘자 대화 수 — 기존 저장 구조에서 싸게 셀 수 있는 방법을 코드에서 확인(비싸면 채널 수 기반 생략하고 타일을 위키 승인 대기로 교체 — 보고서에 명시, 목업 갱신은 컨트롤러 몫).
- [ ] **Step 1: TDD** — ①/admin이 index.html 서빙(서버 모드)·brain 모드 404 ②path traversal(../) 404 ③overview: owner 세션 200+실수치·비owner 403·무토큰 401·미설정 401 ④SPA 폴백.
- [ ] **Step 2: 검증·커밋** — `npx jest --testPathPattern="(admin-http|self.adapter)"` PASS·full `npm test`·build clean. `git commit -m "feat(console): /admin 정적 서빙(서버 모드 한정·traversal 차단)+owner 게이트 개요 API"`

---

### Task 3: 빌드 편입 + 실스모크

**Files:**
- Modify: 루트 `package.json`(files에 console/dist·desktop:build 체인에 console:build), Create: `scripts/smoke-console.ts`

**Interfaces:**
- Consumes: T1·T2 전부.
- Produces: 실스모크 — 임시 데이터 디렉터리로 실서버 부팅(서버 모드=ENGRAM_CHAT_ROLE 미설정+계정 0) → ①GET /admin=200 html ②/auth/status configured:false ③setup-code 파일로 /auth/setup→owner 생성 ④로그인→토큰 ⑤/admin/api/overview 200 실수치·무토큰 401·비owner(가입 계정) 403 ⑥brain 모드 /admin 404.

- [ ] **Step 1: 빌드 체인 편입 후 `npm run desktop:build`가 console까지 포함하는지 확인(전체 빌드는 스모크에서 dist 확인으로 갈음 가능 — 인스톨러 풀빌드는 컨트롤러 몫).**
- [ ] **Step 2: 실스모크 작성·실행 — 전 항목 PASS.** `git commit -m "test(console): 실스모크(서빙·셋업·로그인·개요 게이트)+빌드 편입"`

---

## Self-Review 결과

- 스펙 §2.2 중 S1 범위(서빙·셋업·로그인·개요·네비 자리) 커버. 나머지 화면은 S2~S4(네비 비활성 자리로 존재).
- 시그니처: console/dist(1↔2), /admin/api/overview(1↔2), 스모크(3). 순서 1→2→3.
- 불확실 지점 명시: todayMessages 집계 비용(T2에서 확인·대체안 규정)·패키징 경로 해석(기존 prompts 관성 참조)·auth 엔드포인트 정확한 시그니처(T1이 auth-http.ts에서 확인).
