# 서버 콘솔 S4(상태·로그 + 대화 보존) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 웹 콘솔의 상태·로그 화면(가동·용량·예약 목록·최근 로그)과 대화 자동 보존(채널당 N개/일수/무제한)을 완성한다.

**Architecture:** chat-store에 보존 정책(설정 파일 값) + append 시 프루닝 → admin-http에 status/schedules/logs api + 보존 설정 저장 → 콘솔 ⑩ 상태·로그 화면 + ⑨ 대화 보존 select. 스펙: `docs/superpowers/specs/2026-07-19-server-edition-design.md`(§2.2 ⑩·대화보존) · **확정 목업: `docs/superpowers/mockups/2026-07-19-server-console.html` ⑩상태·로그·⑨대화 보존(픽셀 기준)**

**Tech Stack:** 기존 스택. 신규 dep 없음.

## Global Constraints

- **위키에 저장된 지식은 절대 안 지움** — 대화 보존/프루닝은 chat jsonl(대화 기록)만. wiki/*.md·RAG 무관.
- 모든 admin api owner 게이트(requireOwner: 미설정 401·무토큰 401·비owner 403). 데스크톱 ENGRAM_DESKTOP=1 → /admin 404 유지(회귀 0).
- 로그 노출은 **읽기 전용·최근 N줄만**(경로/전체 파일 노출 금지). 로그 라인에 시크릿이 있을 수 있으나 이건 owner 전용이고 기존 파일 로그 관례 — 그대로 최근 줄만.
- 보존 정책 기본값 = **무제한**(기존 동작 유지, 회귀 0). 프루닝은 정책이 양수 상한일 때만. 데이터 삭제는 opt-in 관례 유지(보존 설정이 그 opt-in).
- 예약 목록/삭제는 기존 schedules-file.ts(listSchedules/removeScheduleFromFile) 재사용. ★알려진 경합(서버 메모리 사본): 삭제는 파일에서만 — 발사 시점 재조회가 자가치유(기존 관성, 문서화만).
- 프로토타입 오염 안전·설정 부분갱신 보존(saveChatBootConfig 관례). UI en 기본+ko. PowerShell·jest/vitest 포그라운드만(백그라운드 jest 행). 커밋 Co-Authored-By 금지. 무관 더티 파일 스테이징 금지.

---

### Task 1: chat-store 보존 정책 + 프루닝 + 용량

**Files:**
- Modify: `src/edge/messenger/chat-store.ts`(+spec)

**Interfaces:**
- Produces:
  - `RetentionPolicy = { mode: 'count'|'days'|'unlimited', value?: number }` (count=채널당 최근 N개·days=최근 N일·unlimited).
  - `ChatStore` 생성자에 보존 정책 주입 or 세터 `setRetention(policy)`(기본 unlimited). append 후 정책이 count/days면 해당 채널 jsonl을 프루닝(count=마지막 N줄만 남김·days=ts가 now-N일 이내만). 프루닝은 원자적(임시파일 rename 또는 안전 재작성)·손상 줄 skip 관례 유지.
  - `pruneChannel(id)`(테스트·수동 트리거용) + `historyBytes()`→전체 chat jsonl 총 바이트(용량 타일용).
- 위키·RAG 무관. 보존 정책 소스(설정 파일)는 Task 2에서 배선(여기선 세터/생성자 인자만).

- [ ] **Step 1: TDD** — count=3 정책서 5개 append→마지막 3개만 남음·재로드에도 유지. days=1 정책서 오래된 ts 줄 제거·최근 유지. unlimited=프루닝 없음(회귀). 손상 줄 있어도 프루닝 안전. historyBytes 합산. 빈 채널/없는 채널 무해.
- [ ] **Step 2: 검증·커밋** — `npx jest --testPathPattern="chat-store"` PASS·full `npm test`·build clean. `git commit -m "feat(console-s4): chat-store 대화 보존 정책(count/days/unlimited)+프루닝+용량 집계(위키 무관)"`

---

### Task 2: admin-http 상태·예약·로그·보존 API

**Files:**
- Modify: `src/edge/admin/admin-http.ts`(+spec), `src/main.ts`(chat-store에 보존 정책 배선·adminDeps에 schedules 접근)

**Interfaces:**
- 보존 정책 저장/조회(chat.config에 retention 필드 추가 — saveChatBootConfig 관례로 부분 저장, 부팅 시 chat-store에 주입):
  - `GET /admin/api/server-settings` 응답에 `retention: {mode,value?}` 추가(S3 응답 확장).
  - `POST /admin/api/server-settings` `{retention?}` 처리 → 저장 + (재시작 적용, 또는 런타임 chat-store.setRetention 가능하면 즉시 — main 배선 확인).
- 상태:
  - `GET /admin/api/status` → `{ uptimeSec, lastHeartbeatMs, chatBytes, knowledgeBytes, memberCount, channelCount }`. uptime=process.uptime·heartbeat=heartbeat 파일·chatBytes=chat-store.historyBytes·knowledgeBytes=wiki+rag 폴더 크기(디렉터리 walk, 저비용 상한 없으면 그대로).
- 예약(schedules-file 재사용):
  - `GET /admin/api/schedules` → `{ schedules: [{id, channelId, cron, task, createdBy?}] }`(전 채널). listSchedules는 configDir 인자.
  - `DELETE /admin/api/schedules/:id` → removeScheduleFromFile.
- 로그:
  - `GET /admin/api/logs?lines=N` → `{ lines: string[] }`(engram.log 최근 N줄, 기본 50·상한 500). getLogsDir 경로만 접근·파일 없음=빈 배열.
- 전부 owner 게이트.

- [ ] **Step 1: TDD** — status(uptime>0·bytes 숫자·count)·schedules 목록+삭제(없는 id 404)·logs 최근 N줄(상한 클램프·파일 없음 빈)·retention 왕복(GET/POST). 전 엔드포인트 owner 200·비owner 403·무토큰 401.
- [ ] **Step 2: 검증·커밋** — `npx jest --testPathPattern="admin-http"` PASS·full `npm test`·build clean. `git commit -m "feat(console-s4): admin-http 상태·예약·로그·대화보존 API(owner 게이트·로그 최근줄만)"`

---

### Task 3: 콘솔 상태·로그 화면 + 대화 보존 select

**Files:**
- Modify: `console/src/{api.ts,App.tsx,i18n.ts,theme.css}`, `console/src/components/Nav.tsx`, `console/src/views/ServerSettings.tsx`(대화 보존 select 추가), Create: `console/src/views/StatusLog.tsx`(+테스트)

**Interfaces:**
- Consumes: Task 2 api.
- Produces(확정 목업 ⑩·⑨ 픽셀):
  - **StatusLog(⑩)**: 통계 타일(가동 시간·마지막 생존 신호·대화 기록 용량·위키+지식 용량) + 예약 작업 목록(이름=task·주기=cron·채널·등록자·삭제 버튼) + 최근 로그(monospace 블록). Fragment 구분선 패턴·목업 ⑩ 그대로.
  - **ServerSettings(⑨)**: 대화 보존 select 추가(채널당 최근 N개 / 최근 N일 / 무제한 — 목업 ⑨ "대화 보존" 행) + "위키에 저장된 지식은 유지" 힌트. 저장 시 retention 페이로드.
  - 네비: 상태·로그 활성(S4까지 마지막 비활성이던 것 해제). 이제 전 네비 활성.
- i18n en 기본+ko, 하드코딩 금지. 목록 행 .grp 직계(구분선 회귀 방지).

- [ ] **Step 1: 목업 ⑩·⑨ 대화보존을 console 컴포넌트로 픽셀 이식.** 목업에 없는 요소 추가 금지(불가피=보고서 명시).
- [ ] **Step 2: TDD(vitest)** — 상태 타일 렌더·예약 목록+삭제 호출·로그 렌더·대화 보존 select 저장 페이로드·네비 상태·로그 활성. 목록 행 .grp 직계.
- [ ] **Step 3: 검증·커밋** — `npm --prefix console test -- --run` PASS·`npm run console:build` clean·백엔드 `npm test` 회귀. `git commit -m "feat(console-s4): 상태·로그 화면+대화 보존 select(확정 목업 픽셀·전 네비 활성)"`

---

### Task 4: 실스모크

**Files:**
- Create: `scripts/smoke-console-s4.ts`

**Interfaces:** Task 1~3. 실서버 부팅(서버 모드)→owner 셋업→토큰.

- [ ] **Step 1: 실스모크** — ①retention count=2 저장→GET 확인→한 채널에 3개 append(ws 또는 직접)→그 채널 jsonl 2줄만·**위키 페이지 수 불변**(지식 무관 실증) ②status uptime>0·bytes 숫자 ③예약: 없으면 스킵 노트/있으면 목록·삭제 ④logs 최근 줄 ⑤비owner 403·무토큰 401·데스크톱(ENGRAM_DESKTOP=1) 404.
- [ ] **Step 2: 실행·커밋** — 2회 연속 PASS. `git commit -m "test(console-s4): 실스모크(보존 프루닝·위키 불변·상태·예약·로그·게이트)"`

---

## Self-Review 결과

- 스펙 §2.2 ⑩ 상태·로그 + 대화 보존 커버. /clear(앱 채팅 UI)는 별도 목업 필요 — S4 비범위(뒤이어 목업 승인 후).
- 시그니처: RetentionPolicy·historyBytes(1)→api(2)→console(3)→smoke(4). 순서 1→2→3→4.
- 안전선: 위키·RAG 절대 미삭제(대화 jsonl만)·로그 최근줄만·보존 기본 무제한(회귀 0). T1·T4에서 위키 불변 명시 검증.
- 불확실 지점: 보존 정책 런타임 즉시 적용 vs 재시작(main 배선 확인·T2)·knowledgeBytes 디렉터리 walk 비용(T2에서 확인, 크면 캐시/생략 보고).
