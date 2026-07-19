# 로컬 무게이트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 혼자 로컬로 쓰는 동안 로그인/셋업 화면이 안 나온다 — 계정이 있는 서버에 붙을 때만 로그인.

**Architecture:** 서버가 "미설정+루프백"이면 `/auth/status`에 localFree=true를 주고 ws도 무인증(기존 brain 모드 권한 경로 재사용) → 렌더러는 localFree면 게이트 생략. 스펙: `docs/superpowers/specs/2026-07-19-local-no-gate-design.md`

**Tech Stack:** 기존 스택 그대로, 신규 dep 없음.

## Global Constraints

- 판정은 요청 시점 `accounts.count()` 재조회(캐시 금지 — 첫 계정 생성 즉시 게이트 재가동).
- 루프백 판정: 소켓 remoteAddress가 127.0.0.1/::1/::ffff:127.0.0.1 — 헤더 신뢰 금지(8c-2 isLoopback 관성 — 기존 헬퍼 있으면 재사용).
- 비루프백·계정 있는 서버·brain 모드·setup-code 흐름 전부 현행 무변경(회귀 0).
- 무인증 통과는 **기존 brain 모드 권한 경로 재사용** — 새 권한 분기 발명 금지.
- PowerShell·jest/vitest 포그라운드만. UI en 기본+ko. 커밋 Co-Authored-By 금지. 무관 더티 파일 스테이징 금지.

---

### Task 1: 서버 — localFree 판정 + ws 루프백 무인증

**Files:**
- Modify: `src/edge/auth/auth-http.ts`(+spec), `src/edge/messenger/self.adapter.ts`(+spec)

**Interfaces:**
- Produces (T2 사용): `/auth/status` 응답 `{ configured, oidc, serverName?, localFree: boolean }` — localFree = `accounts.count()===0 && isLoopbackAddr(req.socket.remoteAddress)`.
- self.adapter: ws 소켓이 `계정 0개 && 루프백`이면 인증 세션 없이 기존 brain 모드(무인증)와 동일 취급 — brain 모드 판정 지점을 찾아(role==='brain' 분기) `|| (accounts.count()===0 && 소켓 루프백)` 형태로 확장(권한 경로 재사용). accounts 접근이 self.adapter에 없으면 authDeps에서 얻거나 count 함수 주입(기존 authDeps 배선 확인 후 최소 결합).

- [ ] **Step 1: TDD** — auth-http.spec: ①미설정+루프백=localFree true ②계정 1개+루프백=false ③미설정+비루프백=false. self.adapter.spec: ④미설정+루프백 ws가 무인증으로 채널 프레임 사용 가능 ⑤계정 생성 후 같은 조건=거부(auth 요구) ⑥비루프백은 미설정이어도 현행(거부) ⑦brain 모드 기존 테스트 무변경 통과.
- [ ] **Step 2: 검증·커밋** — `npx jest --testPathPattern="(auth-http|self.adapter)"` PASS·full `npm test` PASS·build clean. `git commit -m "feat(local-no-gate): 미설정+루프백=무게이트 — localFree 판정+ws 무인증(기존 brain 권한 경로 재사용)"`

---

### Task 2: 렌더러 — localFree 게이트 생략 + 입력칸 CSS 픽스

**Files:**
- Modify: `renderer/src/auth-api.ts`(AuthStatus 타입), `renderer/src/App.tsx`(게이트 조건), `renderer/src/theme.css`(:120-122), 관련 테스트

**Interfaces:**
- Consumes: T1 `/auth/status`의 `localFree`.
- Produces: `AuthStatus`에 `localFree?: boolean`; App의 게이트 표시 조건이 `status && !status.localFree ...`(현행 null=무게이트 처리와 같은 결 — 기존 조건식 읽고 최소 수정). CSS: `input[type=text]` 선택자(:120)와 `:focus`(:122)에 `input[type=password]` 병기.

- [ ] **Step 1: TDD(vitest)** — ①localFree=true 상태면 LoginGate 미렌더 ②configured=true(localFree=false)면 로그인 폼 렌더(회귀) ③기존 게이트 테스트 무변경 통과.
- [ ] **Step 2: 검증·커밋** — `npm --prefix renderer test -- --run` PASS·`npm run renderer:build` clean·백엔드 `npm test` 회귀. `git commit -m "feat(local-no-gate): localFree면 게이트 생략+비밀번호 입력칸 스타일 통일(버그픽스)"`

---

## Self-Review 결과

- 스펙 §2.1→T1, §2.2·§2.3→T2, §4 실스모크→SDD 최종(미설정+루프백 ws 무인증 실왕복·계정 생성 후 재가동·localFree 실응답).
- 시그니처: localFree(1↔2). 순서 1→2.
- 불확실 지점: self.adapter의 brain 모드 판정 위치·accounts 접근 경로(T1 Step 1에서 추적), App 게이트 조건식 원형(T2에서 확인).
