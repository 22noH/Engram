# 배포 형태 분리(스탠드얼론 무게이트) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스탠드얼론(=preset 없음)은 채팅(team) 탭·로그인·계정 화면이 아예 없다. preset 클라이언트만 그 서버 로그인. "내 서버 만들기"는 앱에서 삭제.

**Architecture:** 서버: 미설정+루프백 ws 무인증(brain 권한 경로 재사용)+`/auth/status.localFree` → 렌더러: PRESET 유무로 team 탭 표시·게이트는 preset 연결만·setup 뷰 삭제·비밀번호 입력칸 CSS 픽스. 스펙: `docs/superpowers/specs/2026-07-19-local-no-gate-design.md`

**Tech Stack:** 기존 스택 그대로, 신규 dep 없음.

## Global Constraints

- 판정은 요청 시점 `accounts.count()` 재조회(캐시 금지 — 첫 계정 생성 즉시 게이트 재가동).
- 루프백 판정: 소켓 remoteAddress(127.0.0.1/::1/::ffff:127.0.0.1)만 — 헤더 신뢰 금지(8c-2 isLoopback 관성, 기존 헬퍼 재사용 우선).
- 무인증 통과는 기존 brain 모드 권한 경로 재사용 — 새 권한 분기 발명 금지.
- 비루프백·계정 있는 서버·brain 모드·setup-code API·기존 로그인/가입 폼 현행 무변경(회귀 0).
- UI en 기본+ko(직역체 금지). PowerShell·jest/vitest 포그라운드만. 커밋 Co-Authored-By 금지. 무관 더티 파일 스테이징 금지.

---

### Task 1: 서버 — 미설정+루프백 무인증 + localFree

**Files:**
- Modify: `src/edge/auth/auth-http.ts`(+spec), `src/edge/messenger/self.adapter.ts`(+spec)

**Interfaces:**
- Produces (T2 사용): `/auth/status` 응답 `{ configured, oidc, serverName?, localFree: boolean }` — localFree = `accounts.count()===0 && isLoopback(req.socket.remoteAddress)`.
- self.adapter: ws 소켓이 `계정 0개 && 루프백`이면 기존 brain 모드(무인증)와 동일 취급 — role==='brain' 판정 지점을 찾아 확장. accounts 접근은 기존 authDeps 배선 확인 후 최소 결합(count 함수 주입 허용).

- [ ] **Step 1: TDD** — auth-http.spec: ①미설정+루프백=localFree true ②계정 1개+루프백=false ③미설정+비루프백=false. self.adapter.spec: ④미설정+루프백 ws가 무인증으로 채널 프레임 사용 가능 ⑤계정 생성 후 같은 소켓 조건=현행 거부 ⑥비루프백은 미설정이어도 현행 ⑦brain 모드 기존 테스트 무변경.
- [ ] **Step 2: 검증·커밋** — `npx jest --testPathPattern="(auth-http|self.adapter)"` PASS·full `npm test` PASS·build clean. `git commit -m "feat(standalone): 미설정+루프백 무인증(brain 권한 경로 재사용)+/auth/status localFree"`

---

### Task 2: 렌더러 — team 탭 preset 게이팅 + setup 뷰 삭제 + CSS

**Files:**
- Modify: `renderer/src/config.ts`(TEAM_CHAT), `renderer/src/App.tsx`(게이트 조건·탭), `renderer/src/areas.ts`(필요시), `renderer/src/components/LoginGate.tsx`(setup 뷰 제거), `renderer/src/auth-api.ts`(AuthStatus.localFree), `renderer/src/i18n.ts`(안내 문구), `renderer/src/theme.css`(:120-122), 관련 테스트

**Interfaces:**
- Consumes: T1 `localFree`.
- Produces:
  - `TEAM_CHAT` 하드코딩 true → `PRESET !== null`(스탠드얼론=team 탭 미표시). areaTabs 호출부 확인.
  - App 게이트: 기존 defConn 상태 조회에서 `status.localFree===true`면 게이트 생략(현행 null 처리와 같은 결). preset 연결 로그인/가입 폼 현행 유지.
  - LoginGate: `!status.configured` 셋업 폼("내 서버 만들기") 제거 → 미설정 원격엔 안내 1줄(en: "This server isn't set up yet — ask the server owner." / ko: "아직 준비되지 않은 서버예요 — 서버 관리자에게 문의하세요.").
  - CSS: `input[type=text]` 선택자(:120)와 `:focus`(:122)에 `input[type=password]` 병기.

- [ ] **Step 1: TDD(vitest)** — ①PRESET 없음=team 탭 미렌더 ②PRESET 있음=team 탭 렌더 ③localFree=true면 LoginGate 미렌더 ④configured=true면 로그인 폼(회귀) ⑤미설정 원격=셋업 폼 없음+안내 문구 ⑥기존 게이트 테스트 정리(setup 케이스 갱신).
- [ ] **Step 2: 검증·커밋** — `npm --prefix renderer test -- --run` PASS·`npm run renderer:build` clean·백엔드 `npm test` 회귀. `git commit -m "feat(standalone): 채팅(team) 탭 preset 전용+'내 서버 만들기' 삭제+localFree 게이트 생략+비밀번호 입력칸 CSS"`

---

## Self-Review 결과

- 스펙 §2.1→T1, §2.2→T2, §2.3=비범위(백로그), §3 실스모크→SDD 최종(스탠드얼론 부팅=게이트·채팅 탭 없음·챗봇/위키 동작·무인증 ws 실왕복·임시 데이터로 계정 생성 시 재가동).
- 시그니처: localFree(1↔2). 순서 1→2.
- 불확실 지점: brain 모드 판정 위치·authDeps 형태(T1 추적), areaTabs 호출부·게이트 조건식 원형(T2 확인), TEAM_CHAT을 참조하는 기존 테스트 존재 여부(T2에서 정리).
