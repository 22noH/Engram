# 서버 콘솔 S2(사람 관리: 멤버·그룹·채널) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 웹 콘솔에서 멤버(직접 생성·승인·권한)·그룹(권한/채널 묶음, 신규)·채널을 관리한다. 개인+그룹 권한은 합집합.

**Architecture:** 신규 GroupStore(groups.json) + effective-권한/채널 해소기(개인 ∪ 소속 그룹) → admin-http에 멤버/그룹/채널 api → 콘솔 3화면(확정 목업 기준). 스펙: `docs/superpowers/specs/2026-07-19-server-edition-design.md` §2.2 · **확정 목업: `docs/superpowers/mockups/2026-07-19-server-console.html` ③멤버·④그룹·⑤채널(픽셀 기준)**

**Tech Stack:** 기존 스택. GroupStore는 AccountStore 관례 복제(json 단일 파일·손상 시 빈 목록). 신규 dep 없음.

## Global Constraints

- **권한 모델(사용자 확정): 더하기(합집합).** 멤버 유효 권한 = 개인 permissions ∪ 소속 그룹들의 permissions. 채널 접근(비공개) = 채널 memberIds ∪ (그 채널을 접근 목록에 넣은 그룹들의 멤버). 그룹은 권한을 **주기만** 함(뺄셈 없음). owner는 전권(그룹 무관).
- 모든 쓰기 api는 **owner 세션 필수**(admin-http overview와 동일 게이트: 미설정 401·무토큰 401·비owner 403). 헤더 신뢰 금지.
- 신규 권한 토큰 없음 — 기존 PERMISSIONS 5종(wiki.approve·channels.manage·wiki.unpublish·wiki.edit·wiki.delete) 그대로. 그룹 UI 체크박스도 이 5종.
- 데스크톱 앱 백엔드는 ENGRAM_DESKTOP=1로 /admin 404(S1 관성) — 이 api들도 그 경로 안이라 자동 차단. 회귀 0.
- 이름 slug/소독: 그룹명·loginId 등 사용자 입력은 trim+길이 제한+제어문자 제거. `__proto__`류 키는 hasOwnProperty/defineProperty(하우스룰).
- 기존 계정/채널/권한 게이트(16b/16c) 동작은 그룹 미사용 시 바이트 동일(회귀 0). UI en 기본+ko. PowerShell·jest/vitest 포그라운드만. 커밋 Co-Authored-By 금지. 무관 더티 파일 스테이징 금지.

---

### Task 1: GroupStore + 유효 권한/채널 해소기

**Files:**
- Create: `src/edge/auth/group-store.ts`(+spec), `src/edge/auth/effective-access.ts`(+spec)
- Modify: 유효 권한을 쓰는 게이트 — 코드 확인 후 self.adapter의 `can(...)`/`canAccessChannel(...)` 판정부(권한 해소를 effective-access 경유로)

**Interfaces:**
- Produces:
  ```ts
  export interface Group { id: string; name: string; memberIds: string[]; permissions: string[]; channelIds: string[]; createdAt: string }
  export class GroupStore {
    constructor(stateDir: string);
    list(): Group[]; get(id): Group|null;
    create(name: string): Group;                     // 빈 그룹
    rename(id, name): boolean; remove(id): boolean;
    setMembers(id, memberIds: string[]): boolean;    // 계정 id 검증은 호출자
    setPermissions(id, perms: string[]): boolean;    // sanitizePermissions
    setChannels(id, channelIds: string[]): boolean;
    groupsOf(accountId): Group[];                    // 소속 그룹
  }
  // effective-access.ts
  export function effectivePermissions(acc: Account, groups: Group[]): Permission[]; // 개인 ∪ 그룹(owner=전권 별도 처리 유지)
  export function groupChannelIdsFor(accountId, groups: Group[]): string[];          // 그 계정이 그룹 경유로 접근 가능한 채널 id
  ```
- 게이트 배선: 기존 `can(account, perm)`(permissions.ts) 호출부가 account.permissions만 보던 것을, 그룹 합산한 effective로. 최소 결합 — 판정 함수에 groups를 넘기거나, self.adapter가 GroupStore를 주입받아 effective를 계산해 넘김(기존 시그니처 확인 후 결정). 채널 접근도 동일.

- [ ] **Step 1: TDD** — group-store: create/rename/remove·setMembers/Permissions(소독)/Channels·groupsOf·손상 파일=빈목록·`__proto__` 이름 거부. effective-access: 개인∪그룹 합집합·owner 전권·중복 제거·그룹 없는 계정=개인 그대로(회귀).
- [ ] **Step 2: 게이트 배선 TDD** — 그룹으로만 wiki.approve 받은 멤버가 승인 가능·그룹 채널 접근으로 비공개 채널 열람 가능·그룹 미사용 시 기존 판정 무변경.
- [ ] **Step 3: 검증·커밋** — `npx jest --testPathPattern="(group-store|effective-access|self.adapter|permissions)"` PASS·full `npm test`·build clean. `git commit -m "feat(console-s2): GroupStore+유효 권한/채널 해소기(개인∪그룹 합집합)+게이트 배선"`

---

### Task 2: admin-http 멤버·그룹·채널 API

**Files:**
- Modify: `src/edge/admin/admin-http.ts`(+spec), `src/main.ts`(adminDeps에 GroupStore·ChatStore 주입 확인)

**Interfaces:**
- 전부 owner 게이트(overview와 동일 헬퍼로 추출 — `requireOwner(req): Account|null`, 실패 시 401/403 응답+null). 라우팅은 decoded url 기준(S1 관성).
- 멤버:
  - `GET /admin/api/members` → `{ members: {id,loginId,displayName,role,status,permissions,groups:string[]}[] }`(groups=그룹명)
  - `POST /admin/api/members` `{loginId,displayName,password,groupId?}` → createPassword(role member·status active[관리자 생성은 즉시 활성])+옵션 그룹 편입. loginId 중복=409.
  - `POST /admin/api/members/:id/status` `{status}` (approve=active·suspend·restore)
  - `POST /admin/api/members/:id/permissions` `{permissions}` (sanitize)
  - owner 자신 정지/강등 금지(가드).
- 그룹:
  - `GET /admin/api/groups` → `{ groups: Group[] }`
  - `POST /admin/api/groups` `{name}` · `PATCH /admin/api/groups/:id` `{name?,memberIds?,permissions?,channelIds?}` · `DELETE /admin/api/groups/:id`
- 채널:
  - `GET /admin/api/channels` → `{ channels: {id,name,mode,visibility,memberCount,brain?}[] }` (대화 내용 비노출 — 메타만)
  - `POST /admin/api/channels/:id/visibility` `{visibility}` · `DELETE /admin/api/channels/:id`
  - (모델 지정은 S3 모델 화면 소관 — 여기선 목록에 brain만 표시)
- REST 규약: 메서드 불일치 404/405 일관·본문 파싱 실패 400·존재하지 않는 id 404.

- [ ] **Step 1: TDD** — 각 엔드포인트: owner 200·비owner 403·무토큰 401. 멤버 생성(중복 409·즉시 active)·상태 변경·권한·owner 자기정지 거부. 그룹 CRUD+부분 PATCH(넘긴 필드만). 채널 목록 메타만·visibility·삭제. 계정/채널 없는 id 404.
- [ ] **Step 2: 검증·커밋** — `npx jest --testPathPattern="admin-http"` PASS·full `npm test`·build clean. `git commit -m "feat(console-s2): admin-http 멤버·그룹·채널 API(owner 게이트·메타만 노출)"`

---

### Task 3: 콘솔 멤버·그룹·채널 화면 (목업 픽셀)

**Files:**
- Modify: `console/src/api.ts`(타입·호출), `console/src/App.tsx`(라우팅·네비 활성), `console/src/components/Nav.tsx`, `console/src/i18n.ts`, `console/src/theme.css`
- Create: `console/src/views/{Members,Groups,Channels}.tsx`(+테스트)

**Interfaces:**
- Consumes: Task 2 api 전부.
- Produces(확정 목업 ③④⑤ 픽셀 일치):
  - **Members**: 우상단 "＋ 멤버 추가" → 인라인 폼(아이디·표시이름·임시 비밀번호[생성 버튼]·그룹 셀렉트) → 만들기. "가입 대기" 그룹(승인/거절) + "멤버" 그룹(소속 그룹 칩·상태 칩·권한/비번리셋/정지·복구). 목업의 .grp/.row/.chip 그대로.
  - **Groups**: "＋ 그룹 만들기" + 그룹 목록(이름·인원·권한요약·편집/삭제) + 편집 폼(이름·멤버 칩 추가/제거·권한 체크박스 5종·채널 접근 칩). 목업 ④.
  - **Channels**: 채널 목록(이름·접근범위 칩·모델·멤버수)+visibility 전환·삭제. 목업 ⑤. 대화 내용 없음.
  - 네비: 멤버·그룹·채널 활성화(S1의 "곧 제공" 비활성 해제). 나머지(모델·MCP·위키·설정·배포·상태로그)는 계속 비활성.
- i18n en 기본+ko, 하드코딩 금지.

- [ ] **Step 1: 목업 ③④⑤를 console 컴포넌트로 픽셀 이식.** 목업에 없는 요소 추가 금지(불가피=보고서 명시·컨트롤러 승인).
- [ ] **Step 2: TDD(vitest)** — 멤버 목록 렌더+추가 폼 제출→api 호출·승인/정지 호출·그룹 편집(멤버/권한/채널 변경)→PATCH 페이로드·채널 visibility 전환. 네비 3항목 활성.
- [ ] **Step 3: 검증·커밋** — `npm --prefix console test -- --run` PASS·`npm run console:build` clean·백엔드 `npm test` 회귀. `git commit -m "feat(console-s2): 멤버·그룹·채널 화면(확정 목업 픽셀)+네비 활성"`

---

### Task 4: 실스모크

**Files:**
- Create: `scripts/smoke-console-s2.ts`

**Interfaces:** Task 1~3 전부. 실서버 부팅(서버 모드)→owner 셋업→토큰.

- [ ] **Step 1: 실스모크** — ①멤버 직접 생성(즉시 active)→목록에 보임 ②그룹 생성+권한(wiki.approve)+그 멤버 편입→그 멤버 유효권한에 wiki.approve(effective api나 승인 동작으로 실증) ③채널 목록 메타만·비owner 403·무토큰 401 ④owner 자기정지 거부 ⑤데스크톱(ENGRAM_DESKTOP=1) 이 api들 404.
- [ ] **Step 2: 실행·커밋** — 2회 연속 PASS. `git commit -m "test(console-s2): 실스모크(멤버 생성·그룹 권한 합산·채널 메타·게이트)"`

---

## Self-Review 결과

- 스펙 §2.2 멤버·그룹·채널 커버. 그룹=신규(권한 합집합, 사용자 확정). 모델/MCP/위키/설정/배포/상태로그=S3~S5.
- 시그니처: GroupStore·effective-access(1)→api(2)→console(3)→smoke(4). 순서 1→2→3→4.
- 불확실 지점: self.adapter의 기존 can/canAccessChannel 정확한 시그니처·GroupStore 주입 지점(T1 Step2에서 확인)·owner 자기정지 가드가 이미 있는지(T2에서 확인).
