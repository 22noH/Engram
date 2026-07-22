# 서버 에디션 S5 — engram-server CLI + 윈도우 서비스 + 도커 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 헤드리스 데몬을 한 명령으로 상주 서버화(윈도우 서비스+방화벽)하고, 웹 콘솔과 동등한 `engram-server` 관리 CLI + 도커 배포를 제공한다.

**Architecture:** `engram-server`(신규 bin → `dist/src/server-cli.js`)는 **Nest 부트 없이** PathResolver+스토어(AccountStore·GroupStore·ChatStore·chat.config·preset-file·permissions-file)를 데이터 디렉터리로 직접 생성해 admin-http와 동일 로직을 터미널에서 수행한다. 서비스는 기존 `src/pal/supervisor`(createSupervisor·WindowsSupervisor=node-windows) 재사용 + 방화벽 규칙(netsh) 추가. 도커는 Dockerfile+compose. 스펙: `docs/superpowers/specs/2026-07-22-server-edition-s5-design.md`.

**Tech Stack:** 기존 스택. 신규 dep 없음(node-windows·@types/node-windows 이미 있음). argv 수동 파싱(기존 cli.ts 관례).

## Global Constraints

- **회귀 0**: 데스크톱 앱·`node dist/src/main.js` 수동 실행·웹 콘솔·기존 `engram` CLI 전부 불변. CLI/서비스/도커는 순수 추가.
- CLI는 **Nest 부트 금지**(경량·빠른 시작): 스토어를 `new AccountStore(paths.getStateDir())` 식으로 직접 생성(전부 plain class로 확인됨). WikiEngine 불필요(status는 `paths.getWikiDir()` 디렉터리 크기만).
- CLI는 admin-http와 **동일 스토어/검증 로직 재사용**(로직 중복 0). retention/config 검증은 admin-http/chat.config 규칙 그대로.
- 서비스는 기존 `createSupervisor(process.platform, spec)` 재사용. 서버용 ServiceSpec은 **데스크톱 supervisor의 `Engram` 서비스와 다른 이름**(예 `EngramServer`)으로 충돌 방지. 서비스 env는 `ENGRAM_DATA_DIR`만(데몬이 그 폴더의 chat.json에서 bind/port/role 읽음). **`ENGRAM_DESKTOP`는 설정 안 함**(설정하면 /admin 미서빙 — main.ts:166).
- 방화벽 규칙·서비스 설치는 **관리자 권한 필요** — 권한 없으면 명확한 안내(크래시 금지). netsh 규칙 이름 고정(uninstall이 같은 이름으로 멱등 제거).
- 비윈도우에서 `service *`는 "윈도우 전용 — 도커/수동 안내" 메시지(크래시 아님). 도커/수동은 OS 무관.
- 셋업 코드 1회용·owner 게이트 기존 유지. 커밋 Co-Authored-By 금지. 무관 더티 파일 스테이징 금지.

---

### Task 1: engram-server CLI 골격 + status + setup

**Files:**
- Create: `src/server-cli.ts`(+`server-cli.spec.ts`), `src/edge/server-admin.ts`(CLI가 부르는 순수 로직 — 테스트 용이하게 argv 파싱과 분리)
- Modify: `package.json`(bin에 `engram-server` 추가)

**Interfaces:**
- Consumes: `PathResolver`(`new PathResolver(dataDir?)` — env ENGRAM_DATA_DIR 우선), `AccountStore(new(stateDir))`·`ChatStore(new(chatDir, retention))`, `ensureSetupCode/readSetupCode(stateDir)`, `loadChatConfig(configDir)`, `paths.getHeartbeatPath()/getWikiDir()/getRagDir()`, `ChatStore.historyBytes()/listChannels()`.
- Produces:
  - `src/server-cli.ts` — 엔트리: `process.argv.slice(2)` 수동 디스패치(`setup|status|user|group|config|preset|start|service|--help`). Nest 안 씀. 미지 명령/`--help`=사용법 출력. 각 명령은 `server-admin.ts`의 순수 함수 호출.
  - `src/edge/server-admin.ts`:
    - `runStatus(paths): { uptimeSec?, lastHeartbeatMs, chatBytes, knowledgeBytes, memberCount, channelCount, listening: boolean }` — admin-http getStatus 계산 재현(heartbeat 파일·dirSize·historyBytes·counts) + 포트 리슨 여부(loadChatConfig의 port에 TCP 접속 시도). uptime은 실행 중 서버 기준이 아니라 heartbeat로 "살아있음" 표시(로컬 CLI라 process.uptime 무의미) — lastHeartbeatMs로 최근 생존 표시.
    - `runSetup(paths): { code: string; alreadyConfigured: boolean }` — accounts.count()>0면 alreadyConfigured=true(코드 안 만듦), 아니면 ensureSetupCode 반환 + 웹 콘솔 주소(bind:port/admin) 안내.
    - `dirSizeBytes(dir)` 공용 헬퍼(admin-http의 private과 동일 — 여기로 추출하거나 복제, 플랜에서 복제 택). 없는 디렉터리=0·항목 실패 skip.
- bin: `"engram-server": "dist/src/server-cli.js"`.

- [ ] **Step 1: TDD** — runStatus(빈 데이터 디렉터리=counts 0·heartbeat 없음 null·bytes 0·listening false)·heartbeat 파일 있으면 lastHeartbeatMs 반환·chat 메시지 넣으면 chatBytes>0·채널 수. runSetup(계정 0=코드 생성·재호출 동일 코드·owner 만든 뒤=alreadyConfigured). argv 디스패치(미지 명령→사용법·exit 비0). dirSizeBytes 합산·없는 디렉터리 0.
- [ ] **Step 2: 검증·커밋** — `npx jest --testPathPattern="server-cli|server-admin"` PASS·full `npm test`·`npm run build`(server-cli.js 산출). `git commit -m "feat(server-s5): engram-server CLI 골격+status+setup(Nest 무부트·스토어 직접)"`

---

### Task 2: 관리 명령 user·group·config·preset

**Files:**
- Modify: `src/edge/server-admin.ts`(+spec), `src/server-cli.ts`(디스패치 연결)

**Interfaces:**
- Consumes: `AccountStore`(list/get/setStatus/setPassword/createPassword), `GroupStore`(list/create/remove/setPermissions/setMembers/setChannels), `saveChatBootConfig(configDir, patch)`·`loadChatConfig`, `getCommandMode/setCommandMode`(`src/desktop/permissions-file.ts`), `buildPreset/writePresetFile`(`src/desktop/preset-file.ts`), `PERMISSIONS`(권한 목록·검증). retention 검증은 admin-http와 동일 규칙(mode count/days/unlimited·양수).
- Produces(server-admin.ts 함수 + CLI 서브디스패치):
  - `user list` → 계정 표(id·loginId·displayName·role·status). `user approve <id>` → setStatus(active)(pending만). `user suspend <id>` → setStatus(suspended). `user reset-password <id>` → 임시 비번 생성(admin-http generateTempPassword 재사용/복제)+setPassword+출력. 없는 id·이미 상태면 명확한 메시지.
  - `group list|create <name>|delete <id>|set-perms <id> <perm,perm>|set-channels <id> <id,id>` → GroupStore. 잘못된 perm은 거부(PERMISSIONS 화이트리스트).
  - `config get [key]` → 현재 chat.config(port·bind·retention·autoCompact) + codingMode 출력. `config set <key> <value>` → 키별 검증 후 saveChatBootConfig/setCommandMode. 재시작 적용 필드 안내. retention은 `count:1000`/`days:90`/`unlimited` 문자열 파싱.
  - `preset export [path]` → buildPreset(configDir, {bind, port, hostHint?})+writePresetFile(또는 지정 경로)로 preset.json 기록·경로 출력.
- 전부 순수 함수(스토어 주입)로 테스트.

- [ ] **Step 1: TDD** — user: pending→approve→active·suspend·reset(임시비번 반환·setPassword 호출)·없는 id 에러. group: create/list/delete·set-perms(잘못된 perm 거부)·set-channels. config: get 현재값·set port/bind/retention(count:2)/autoCompact/codingMode 각각 저장·잘못된 값 거부·get으로 왕복. preset: export가 preset.json 생성(name·endpoint). 임시 디렉터리 격리.
- [ ] **Step 2: 검증·커밋** — `npx jest --testPathPattern="server-admin"` PASS·full `npm test`·build. `git commit -m "feat(server-s5): CLI user·group·config·preset(웹 콘솔 파리티·스토어 직접)"`

---

### Task 3: 윈도우 서비스 + 방화벽 + start(포그라운드)

**Files:**
- Create: `src/edge/server-service.ts`(서비스 설치/방화벽 오케스트레이션 — 순수 로직+주입), `src/edge/server-service.spec.ts`
- Modify: `src/server-cli.ts`(`service`·`start` 디스패치)
- Reference(수정 안 함): `src/pal/supervisor/supervisor.factory.ts`(createSupervisor)·`windows-supervisor.ts`(Service)·`supervisor.port.ts`(ServiceSpec)·`cli.gateway.ts:148-166`(기존 service 패턴)

**Interfaces:**
- Consumes: `createSupervisor(platform, spec)`(install/uninstall/start/stop/status)·`ServiceSpec`(name·scriptPath·dataDir), `loadChatConfig`(port·bind), `child_process.execFile`(netsh — 주입 가능한 러너로 감싸 테스트).
- Produces:
  - `ServiceSpec`: name=`'EngramServer'`(데스크톱 `Engram`과 구분), scriptPath=`dist/src/main.js`(레포 루트 해석), dataDir=paths.getDataDir(). env는 ENGRAM_DATA_DIR만(WindowsSupervisor 기본) — 데몬이 config에서 bind/port 읽음.
  - `installService(deps)` → `supervisor.install()` + `addFirewallRule(port, ruleName)`(netsh advfirewall firewall add rule name=EngramServer dir=in action=allow protocol=TCP localport=<port>). 관리자 아니면 명확한 안내(EPERM/실패 감지). netsh 러너는 주입(테스트는 fake로 호출 인자 검증).
  - `uninstallService(deps)` → `supervisor.uninstall()` + `removeFirewallRule(ruleName)`(netsh delete rule name=... — 없으면 무해). 둘 다 멱등.
  - `serviceControl('start'|'stop'|'status')` → supervisor 위임.
  - 비윈도우: `process.platform !== 'win32'`면 service 명령은 "윈도우 전용 — 도커(compose)나 `engram-server start`(수동/systemd) 사용" 안내 후 종료(크래시 아님).
  - `start`(포그라운드) → `node dist/src/main.js`를 현재 프로세스에서 부트(또는 spawn·상속 stdio) — 서비스 없이 그냥 서버 실행(도커 CMD·디버깅). 셋업 코드는 부팅 로그로.
- 관리자 권한 감지: 설치/방화벽 실패 시 "관리자 PowerShell에서 다시 실행하세요" 안내.

- [ ] **Step 1: TDD** — fake supervisor + fake netsh 러너 주입. installService→supervisor.install 호출·netsh add rule 인자(name·localport=config port) 검증. uninstall→supervisor.uninstall+netsh delete rule(없어도 무해). 멱등(두 번 호출 무해). netsh 실패(비관리자 모사)→throw 아닌 안내 반환. 비윈도우 platform→service 안내 메시지·서비스 미호출. ServiceSpec name=EngramServer·scriptPath=main.js.
- [ ] **Step 2: 검증·커밋** — `npx jest --testPathPattern="server-service"` PASS·full `npm test`·build. `git commit -m "feat(server-s5): 윈도우 서비스 설치/제거(supervisor 재사용)+방화벽 규칙(netsh)+start 포그라운드"`

---

### Task 4: 도커 (Dockerfile + compose)

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `.dockerignore`

**Interfaces:** 빌드 산출물(`dist/`)·`node dist/src/main.js` 데몬·env(ENGRAM_DATA_DIR·ENGRAM_CHAT_BIND·ENGRAM_CHAT_PORT).

- Produces:
  - `Dockerfile` — 멀티스테이지 권장(builder: npm ci+build → runner: node-slim + dist + prod node_modules + prompts/ + 필요한 자산). `WORKDIR /app`, `EXPOSE 47800`, `ENV ENGRAM_DATA_DIR=/data`, `CMD ["node","dist/src/main.js"]`. non-root user 권장.
  - `docker-compose.yml` — service engram: build `.`·`ports: "47800:47800"`·`volumes: ./engram-data:/data`(또는 named volume)·`environment: ENGRAM_CHAT_BIND=0.0.0.0`·`restart: unless-stopped`. 첫 실행 셋업 코드=컨테이너 로그.
  - `.dockerignore` — node_modules·release·.git·docs·*.log 등 빌드 컨텍스트 축소.
- 임베딩 모델 캐시가 볼륨에 남게(데이터 볼륨) 안내는 문서(Task 5)에.

- [ ] **Step 1: 작성** — Dockerfile·compose·dockerignore. (도커 빌드 실행은 환경 의존 — 가능하면 Task 5 스모크에서 `docker build` 시도, 불가하면 문법/구성만 검토하고 보고.)
- [ ] **Step 2: 검증·커밋** — `npm run build`(dist 존재 확인)·Dockerfile/compose 문법 육안+`docker compose config`(도커 있으면) PASS. `git commit -m "feat(server-s5): 도커 배포(Dockerfile+compose·restart unless-stopped)"`

---

### Task 5: 문서(README 서버 에디션) + 실스모크

**Files:**
- Modify: `README.md`·`README.ko.md`(서버 에디션 배포 3방식 + CLI 표)
- Create: `scripts/smoke-server-cli.ts`

**Interfaces:** Task 1~4.

- Produces:
  - README 서버 에디션 섹션 확장: **배포 3방식**(① 윈도우 서비스: `engram-server service install` → 자동시작+방화벽 / ② 도커: `docker compose up -d` / ③ 수동: `node dist/src/main.js` 또는 `engram-server start`) + **CLI 명령 표**(setup·status·user·group·config·preset·service) + 방화벽·인터넷 공개(TLS 리버스 프록시) 주의. [[readme-user-facing-not-devlog]] 준수(기능·사용법만).
  - `scripts/smoke-server-cli.ts` — 격리 임시 ENGRAM_DATA_DIR에서 `node dist/src/server-cli.js` 실제 실행: setup(코드 생성)→config set port/retention→config get 왕복→user(실제 서버 부팅해 owner 만든 뒤 list/approve)→preset export(파일 생성)→status. 서비스는 install/uninstall을 **윈도우에서만** 멱등 검증(비관리자면 안내 확인·skip 노트). 도커는 `docker build` 가능하면 시도, 아니면 skip 노트.

- [ ] **Step 1: 문서+스모크 작성**
- [ ] **Step 2: 실행·커밋** — 스모크 2회 PASS(플랫폼 skip 노트 명시)·full `npm test`·build. `git commit -m "docs(server-s5): README 서버 에디션 배포 3방식+CLI 표 / test: engram-server 실스모크"`

---

## Self-Review 결과

- 스펙 커버: CLI 골격+status+setup(T1)·user/group/config/preset(T2)·윈도우 서비스+방화벽+start(T3)·도커(T4)·문서+스모크(T5). 전 항목 매핑.
- 시그니처 일관: server-admin 함수(스토어 주입)→server-cli 디스패치→server-service(supervisor+netsh). 스토어는 전부 plain class 직접 생성(Nest 무부트).
- 재사용: 서비스=기존 supervisor·admin=admin-http 스토어/검증·preset/setup/config=기존 헬퍼. 로직 중복 0.
- 회귀 0: 순수 추가(신규 bin·신규 파일·Dockerfile). 기존 경로 불변. 서비스 이름 EngramServer로 데스크톱과 분리.
- 불확실(구현 중 확정): dirSizeBytes 추출 vs 복제·`start` 포그라운드를 in-process 부트 vs spawn·도커 빌드 스모크 실행 가능 여부·netsh 관리자 권한 감지 방식(실패 캐치). 각 태스크 보고서에 결정 기록.
- 안전: 방화벽/서비스는 관리자 권한 필요(안내)·비윈도우 안내(크래시 금지)·셋업 코드 1회용 유지.
