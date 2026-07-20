# 서버 콘솔 S3(설정 이관: 모델·MCP·위키·서버 설정·배포) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 웹 콘솔에서 서버의 모델·MCP·위키 동기화·서버 설정(이름·공개범위·SSO·코딩 허용)·클라이언트 배포(preset)를 관리한다.

**Architecture:** admin-http에 설정 api 추가(기존 electron-free 파일 헬퍼 brains-file·mcp-file·wiki-remote-file·permissions-file·ollama·api-brain 재사용) → 콘솔 5화면(확정 목업 ⑥⑦⑧⑨). 스펙: `docs/superpowers/specs/2026-07-19-server-edition-design.md` · **확정 목업: `docs/superpowers/mockups/2026-07-19-server-console.html` ⑥모델·⑦MCP·⑧위키·⑨서버설정+배포(픽셀 기준)**

**Tech Stack:** 기존 스택. 신규 dep 없음. 파일 헬퍼는 이미 백엔드 안전(electron import 없음 — 확인됨).

## Global Constraints

- **API 키·시크릿은 절대 브라우저로 반환 금지(쓰기 전용).** GET은 `hasApiKey: boolean`류만; POST는 값 받되 빈 입력=기존 보존. (데스크톱 설정 UI화 때 Critical이었던 원문 유출 재발 방지 — [[engram-project-state]] 참조.)
- 모든 설정 api owner 게이트(requireOwner: 미설정 401·무토큰 401·비owner 403). 헤더만 신뢰. readBody 400.
- 포트·바인드 등 부팅 시점 설정은 저장 후 **재시작 시 적용**(헤드리스는 UI 재시작 힌트 대신 "재시작 후 적용" 문구). 저장은 설정 파일에만.
- 공개 범위 매핑: 이 컴퓨터만→bind `127.0.0.1` · 내부망(LAN)/인터넷 공개→bind `0.0.0.0`(인터넷 선택 시 HTTPS 안내 문구 추가). bind는 실제 2값, 3라벨은 표시.
- 데스크톱 앱 백엔드는 ENGRAM_DESKTOP=1로 /admin 404 유지(회귀 0) — 이 api들도 그 경로 안이라 자동 차단.
- 프로토타입 오염 안전(모델/서버 이름 키는 hasOwnProperty/defineProperty·기존 파일 헬퍼 관례 재사용). UI en 기본+ko. PowerShell·jest/vitest 포그라운드만(백그라운드 jest 행). 커밋 Co-Authored-By 금지. 무관 더티 파일 스테이징 금지.

---

### Task 1: admin-http 모델·MCP API

**Files:**
- Modify: `src/edge/admin/admin-http.ts`(+spec), `src/main.ts`(adminDeps에 configDir 접근 확인 — 이미 paths 있음)

**Interfaces:**
- 모델(brains-file.ts·ollama.ts·api-brain.ts 재사용):
  - `GET /admin/api/models` → `{ default: string, harness: 'cli'|'engram', models: [{key, provider, model, isDefault, hasApiKey: boolean}] }` (hasApiKey = 프로필에 apiKey 존재 여부만; **키 값 금지**). harness = 기본 모델의 provider가 anthropic/openai-api면 'engram' 아니면 'cli'.
  - `POST /admin/api/models/ollama` `{model, name, setDefault?}` → addOllamaProfile.
  - `POST /admin/api/models/api-key` `{apiKey, setDefault?}` → saveAnthropicApiKey(빈 문자열이면 400 — 저장할 게 없음).
  - `POST /admin/api/models/default` `{key}` → setDefaultBrain.
  - `DELETE /admin/api/models/:key` → removeBrainProfile(기본 모델이면 400 "먼저 다른 모델을 기본으로").
- MCP(mcp-file.ts 재사용 — Task 2 S1에서 이미 구성됨):
  - `GET /admin/api/mcp` → `{ servers: [{name, command?, args?, url?, source?}] }` (source='claude'는 읽기 전용 표시).
  - `POST /admin/api/mcp` `{name, commandOrUrl}` → addMcpServer(이름 slug 검증, 중복 409).
  - `DELETE /admin/api/mcp/:name` → removeMcpServer(source='claude' 거부 403 — 기존 가드 재사용).

- [ ] **Step 1: TDD** — 각 엔드포인트 owner 200·비owner 403·무토큰 401. models GET이 hasApiKey만·**apiKey 원문 응답에 없음 검증**(핵심). ollama 추가·기본 전환·기본 삭제 거부(400)·api-key 빈값 400. mcp 목록·추가(중복 409)·삭제(claude 소스 403).
- [ ] **Step 2: 검증·커밋** — `npx jest --testPathPattern="admin-http"` PASS·full `npm test`·build clean. `git commit -m "feat(console-s3): admin-http 모델·MCP API(키 쓰기전용·claude 소스 보호)"`

---

### Task 2: admin-http 위키·서버 설정·코딩·preset API

**Files:**
- Modify: `src/edge/admin/admin-http.ts`(+spec), `src/desktop/main.ts`(preset 생성 순수 헬퍼 추출), Create: `src/desktop/preset-file.ts`(+spec — writePresetFile/buildPreset 순수 함수)

**Interfaces:**
- 위키(wiki-remote-file.ts 재사용):
  - `GET /admin/api/wiki` → `{ remote: { url?, branch? }, pages: number, pendingProposals: number, lastSync?: string }` (통계는 overview에서 쓰는 소스 재사용).
  - `POST /admin/api/wiki/remote` `{url, branch}` → saveWikiRemote.
- 서버 설정(auth.config·chat.config):
  - `GET /admin/api/server-settings` → `{ serverName?, port, bind, exposure: 'local'|'lan'|'internet', oidcIssuer?, hasOidcSecret: boolean, codingMode: 'auto'|'restricted'|'off' }` (**oidc secret 값 금지**, hasOidcSecret만; codingMode는 permissions-file.getCommandMode).
  - `POST /admin/api/server-settings` `{serverName?, port?, bind?, exposure?, oidc?: {issuer,clientId,clientSecret?}, codingMode?}` → 해당 파일들 저장(clientSecret 빈값=보존). 부팅 설정 변경은 저장만(재시작 적용).
- 코딩 허용: codingMode='off'가 꺼짐, 'auto'/'restricted'가 켜짐(setCommandMode). 서버 설정에 포함.
- preset 배포:
  - `GET /admin/api/preset` → preset.json 내용을 다운로드용으로 반환(`{ name, endpoint }` — endpoint는 서버 자신의 접속 주소: serverName + bind/port로 구성, bind=0.0.0.0이면 LAN IP 안내 문구도. Content-Disposition: attachment; filename=preset.json 헤더로 파일 다운로드 유도).

- [ ] **Step 1: preset 순수 헬퍼 추출** — desktop/main.ts의 preset 생성 로직을 preset-file.ts로(buildPreset(configDir, serverInfo)→{name,endpoint} · 기존 호출부는 새 헬퍼 사용, 동작 무변경).
- [ ] **Step 2: TDD** — 위키 remote 저장·조회. 서버설정 GET이 **oidc secret 없음·hasOidcSecret만** 검증·저장(secret 빈값 보존)·codingMode 왕복·공개범위↔bind 매핑. preset 다운로드 헤더·내용. 전부 owner 게이트.
- [ ] **Step 3: 검증·커밋** — `npx jest --testPathPattern="(admin-http|preset-file)"` PASS·full `npm test`·build clean. `git commit -m "feat(console-s3): admin-http 위키·서버설정·코딩·preset API(secret 쓰기전용·재시작 적용)"`

---

### Task 3: 콘솔 모델·MCP·위키·서버설정·배포 화면 (목업 픽셀)

**Files:**
- Modify: `console/src/{api.ts,App.tsx,i18n.ts,theme.css}`, `console/src/components/Nav.tsx`
- Create: `console/src/views/{Models,Mcp,Wiki,ServerSettings}.tsx`(+테스트) — 배포(preset)는 ServerSettings 하단 카드(목업 ⑨) 또는 별도 뷰(목업 네비 "클라이언트 배포" 항목 — 별도 뷰가 네비 일치)

**Interfaces:**
- Consumes: Task 1·2 api.
- Produces(확정 목업 ⑥⑦⑧⑨ 픽셀):
  - **Models(⑥)**: 하네스 셀렉트(CLI/엔그램)·기본 모델 셀렉트·등록 목록(키·provider·model·기본 배지·편집/삭제)·추가(로컬 모델 select+이름+추가·API 키 입력[password]+저장). **키 입력칸은 저장 후 비움·hasApiKey면 "설정됨" 표시**.
  - **MCP(⑦)**: 등록 목록(이름·command/url·⊖, source='claude'는 ⊖ 없음)·추가(이름+명령/URL).
  - **Wiki(⑧)**: 통계 타일(페이지·승인 대기·마지막 동기화)+git 원격 폼(저장소·브랜치·저장).
  - **ServerSettings(⑨)**: 이름·포트·공개 범위 셀렉트·SSO(OIDC)·**코딩 허용 토글(off/auto)**·저장. + 클라이언트 배포 카드(preset.json 다운로드 — GET /admin/api/preset를 blob으로 받아 다운로드). 부팅 설정 옆 "재시작 후 적용" 힌트.
  - 네비: 모델·MCP·위키·서버설정·클라이언트배포 활성(상태·로그만 S4까지 비활성).
- i18n en 기본+ko, 하드코딩 금지. **API 키·시크릿 입력칸은 type=password.**

- [ ] **Step 1: 목업 ⑥⑦⑧⑨를 console 컴포넌트로 픽셀 이식.** 기존 화면(Members/Groups/Channels)의 .grp/.frow/.row 문법·Fragment 구분선 패턴 재사용(같은 CSS 함정 반복 금지). 목업에 없는 요소 추가 금지(불가피=보고서 명시).
- [ ] **Step 2: TDD(vitest)** — models 목록+추가 폼 호출·키 입력 후 응답에 키 없음(hasApiKey만 표시)·mcp 추가/삭제·wiki remote 저장·server-settings 저장 페이로드·preset 다운로드 트리거. 네비 활성. 목록 행이 .grp 직계(구분선 회귀 방지 — Members/Channels와 같은 테스트).
- [ ] **Step 3: 검증·커밋** — `npm --prefix console test -- --run` PASS·`npm run console:build` clean·백엔드 `npm test` 회귀. `git commit -m "feat(console-s3): 모델·MCP·위키·서버설정·배포 화면(확정 목업 픽셀·키 쓰기전용 UI)"`

---

### Task 4: 실스모크

**Files:**
- Create: `scripts/smoke-console-s3.ts`

**Interfaces:** Task 1~3. 실서버 부팅(서버 모드)→owner 셋업→토큰.

- [ ] **Step 1: 실스모크** — ①로컬 모델 추가→GET models에 보임·기본 전환 ②**API 키 저장 후 GET models 응답에 키 원문 없음·hasApiKey=true**(보안 핵심) ③MCP 추가/삭제·claude 소스 삭제 403 ④위키 remote 저장·조회 ⑤서버설정 저장·**GET에 oidc secret 없음** ⑥preset 다운로드 헤더/내용 ⑦비owner 403·데스크톱(ENGRAM_DESKTOP=1) 404.
- [ ] **Step 2: 실행·커밋** — 2회 연속 PASS. `git commit -m "test(console-s3): 실스모크(모델·MCP·위키·서버설정·preset·키 비유출)"`

---

## Self-Review 결과

- 스펙 §2.2 중 S3 범위(모델·MCP·위키·서버설정·배포) 커버. 상태·로그+대화보존+/clear=S4.
- 시그니처: models/mcp api(1)→wiki/settings/preset api(2)→console(3)→smoke(4). 순서 1→2→3→4.
- 보안 최우선선: API 키·OIDC secret 브라우저 미반환(GET=has* boolean만) — T1·T2·T4에서 명시 검증.
- 불확실 지점: preset 생성 로직의 정확한 현행 위치·serverInfo 구성(T2 Step1 추출 시 확인)·chat.config의 port/bind 저장 경로(T2에서 확인).
