# 클로드 MCP 패리티 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 클로드에 등록된 MCP(user 스코프+플러그인)가 엔그램에서도 그대로 — 자동 미러링+HTTP 지원+설정창 표시+CLI 하네스 전체 개방.

**Architecture:** 신규 판독기(claude-mcp-import)가 `~/.claude.json`+플러그인 캐시를 읽음 → 부트/새로고침 때 mcp.json에 source='claude'로 병합(수동 항목 불가침) → mcp-client가 http url 항목도 연결 → claude-cli 스폰 allowedTools를 판독 이름들로 동적 구성 → 설정창 두 그룹 표시. 스펙: `docs/superpowers/specs/2026-07-19-claude-mcp-parity-design.md`

**Tech Stack:** 기존 스택 그대로. HTTP 전송은 이미 설치된 공식 SDK의 `StreamableHTTPClientTransport`(신규 dep 없음).

## Global Constraints

- 파일 판독 전부 fault-tolerant(없음/깨짐=빈 결과·never-throw). 이름은 기존 `isValidMcpName`(__proto__류 명시 거부)·객체 순회는 hasOwnProperty — 하우스룰.
- 미러는 source='claude' 항목만 소유(갱신·삭제). **수동 항목(소스 표시 없음) 절대 불가침** — 이름 충돌=수동 승리+로그.
- 클로드가 없는 머신 = 소스 0개 = 전부 no-op(회귀 0). 기존 stdio MCP·설정창 수동 추가 경로 회귀 0.
- CLI 하네스 allowedTools: 프로필이 직접 지정하면 그것 우선(기존 관성). 판독 실패=현행 고정 기본으로 폴백.
- 경로는 `os.homedir()` 기준(하드코딩 금지). PowerShell·jest 포그라운드만. UI 문구 en 기본+ko. 커밋 Co-Authored-By 금지.
- 스펙 §3.1 순서 정정(문구 모순 해소): **먼저 읽은 것이 이김** — user 스코프 → 플러그인(알파벳순), 즉 user 최우선.

---

### Task 1: claude-mcp-import — 클로드 MCP 소스 판독기

**Files:**
- Create: `src/brain/claude-mcp-import.ts`(+spec)

**Interfaces:**
- Produces (T2·T4 사용):
  ```ts
  export interface ClaudeMcpEntry {
    name: string;                 // slug 검증 통과한 서버명
    command?: string; args?: string[]; env?: Record<string, string>; // stdio형
    url?: string;                 // http형({type:'http'|'sse', url})
    pluginName?: string;          // 플러그인 유래면 플러그인명(디렉터리명) — CLI 도구명 변형용
  }
  export function readClaudeMcpServers(home?: string): ClaudeMcpEntry[]; // home 기본 os.homedir()
  ```
- 소스 ①: `<home>/.claude.json`의 `mcpServers` — 값이 `{command,args?,env?}`(stdio) 또는 `{type:'http'|'sse', url}`(http). ②: `<home>/.claude/plugins/installed_plugins.json`(version 2, `plugins["이름@마켓"] : [{installPath,...}]` — 항목 배열 첫 원소의 installPath 사용, 플러그인명=`이름@마켓`의 @ 앞부분)에서 각 `installPath/.mcp.json`(`{서버명: {command,args?}|{type,url}}`) — 플러그인명 알파벳순.
- 규칙: 이름 `isValidMcpName` 실패·command와 url 둘 다 없음 = 스킵. **먼저 등록된 이름이 이김**(user 스코프 최우선). env는 문자열 값만. command/url은 trim 후 빈 값=스킵.

- [ ] **Step 1: TDD** — 임시 home 디렉터리에 실제 파일 구조를 만들어 검증: ①user 스코프 stdio+http 판독 ②플러그인 .mcp.json 판독+pluginName 부여 ③이름 충돌 시 user 승리 ④__proto__·잘못된 형·빈 command 스킵 ⑤파일 없음/깨진 JSON=[] ⑥installed_plugins.json의 빈 배열 항목 무해.
- [ ] **Step 2: 검증·커밋** — `npx jest --testPathPattern="claude-mcp-import"` PASS·`npm run build` clean. `git commit -m "feat(mcp-parity): 클로드 MCP 소스 판독기(user 스코프+플러그인, fault-tolerant)"`

---

### Task 2: mcp-config http 허용 + 미러 병합 + 부트 배선

**Files:**
- Modify: `src/brain/mcp-config.ts`(+spec) — McpServerConfig 확장, `src/desktop/mcp-file.ts`(+spec) — 병합 함수, `src/main.ts` — 부트 1회 호출

**Interfaces:**
- Consumes: T1 `readClaudeMcpServers`.
- Produces:
  ```ts
  // mcp-config.ts — 확장(기존 필드 유지, 하위호환)
  export interface McpServerConfig { command?: string; args: string[]; env: Record<string, string>; url?: string }
  // loadMcpServers: command 또는 url 있으면 유효(기존엔 command 필수였음 — url형 통과 추가). source 필드는 로더에서 무시(클라이언트에 불필요).
  // mcp-file.ts — T5·main 사용
  export function mirrorClaudeMcp(configDir: string, entries: ClaudeMcpEntry[]): void;
  ```
- mirrorClaudeMcp: mcp.json을 읽어(기존 readMcpConfig 재사용) ①`source==='claude'`인 기존 항목 전부 제거 ②entries를 `source:'claude'`로 삽입(stdio는 {command,args,env,source}·http는 {url,source}) ③이름이 수동 항목과 겹치면 스킵+console.warn ④그 외 top-level 키 보존, 파일 저장. 쓰기 실패=warn(throw 금지).
- main.ts 부트: configDir 확정 직후 `try { mirrorClaudeMcp(paths.getConfigDir(), readClaudeMcpServers()); } catch { /* 미러 실패는 부팅을 못 막음 */ }` — 두뇌 생성 이전 시점.

- [ ] **Step 1: TDD** — mcp-file.spec: ①미러 삽입(source 표시) ②재실행 시 클로드에서 지운 항목 제거·수동 항목 보존 ③이름 충돌=수동 승리 ④mcp.json 없음=생성. mcp-config.spec: url형 항목 로드·command도 url도 없으면 스킵·기존 stdio 케이스 회귀 0.
- [ ] **Step 2: 검증·커밋** — `npx jest --testPathPattern="(mcp-config|mcp-file)"` PASS·build clean. `git commit -m "feat(mcp-parity): mcp.json 미러 병합(source=claude 소유·수동 불가침)+http형 로드+부트 동기화"`

---

### Task 3: mcp-client HTTP 전송

**Files:**
- Modify: `src/brain/mcp-client.ts`(+spec)

**Interfaces:**
- Consumes: T2의 McpServerConfig(url 필드).
- Produces: `McpSession.create(name, cfg)`가 `cfg.url` 있으면 `StreamableHTTPClientTransport(new URL(cfg.url))`(`@modelcontextprotocol/sdk/client/streamableHttp.js`)로, 아니면 기존 Stdio로. 그 외 계약 무변경(connect 10s·callTool 60s·50k 상한·never-throw·close 멱등). 401/연결 실패는 기존 connect false 경로 그대로(호출부가 스킵+로그 — 코드 확인 후 로그 없으면 warn 1줄 추가).

- [ ] **Step 1: TDD** — ①url 항목이 Streamable 전송으로 생성됨(전송 타입 확인 또는 로컬 http 목 서버 연결) ②연결 거부(빈 포트)=connect false·throw 없음 ③기존 stdio·InMemory 테스트 전부 무변경 통과.
- [ ] **Step 2: 검증·커밋** — `npx jest --testPathPattern="mcp-client"` PASS·build clean. `git commit -m "feat(mcp-parity): MCP 클라이언트 http 전송(StreamableHTTP) 지원"`

---

### Task 4: CLI 하네스 allowedTools 동적 구성 + 자동 경로 프롬프트 지침

**Files:**
- Modify: `src/brain/claude-cli.brain.ts`(+spec), `prompts/conductor.md`+자동 실행 경로 프롬프트(digest/ambient/예약 — 실파일은 prompts/ 및 해당 서비스 코드에서 추적해 보고서에 기록)

**Interfaces:**
- Consumes: T1 `readClaudeMcpServers`(이름·pluginName만 사용).
- Produces: spawnOnce에서 `!hasAllowed`일 때 허용 목록 =
  ```
  ['WebSearch','WebFetch','mcp__engram','mcp__plugin_engram_engram',
   ...판독 항목마다 `mcp__${name}`, 플러그인 유래면 추가로 `mcp__plugin_${pluginName}_${name}`]
  ```
  중복 제거 후 콤마 결합. 판독은 스폰 시점마다(요청시점 재조회 관성 — listBrainNames와 같은 결), try/catch로 실패=현행 고정 기본 4개. 프로필 --allowedTools 직접 지정=기존대로 그것만.
- 프롬프트 지침(스펙 §3.4, 사용자 결정=차단 대신 판단): conductor.md와 자동 실행 경로 프롬프트에 1~2문장 — "예약·자동 실행 맥락에서는 외부에 쓰는 도구(메시지 발송·문서 수정 등)를 작업 지시문에 명시된 경우에만 사용하고, 그 외에는 읽기 위주로." en 기본+ko 파일 구조 따름(프롬프트 파일이 단일 언어면 그 언어로).

- [ ] **Step 1: TDD** — claude-cli.brain.spec: ①판독 목 주입(모듈 목) 시 allowedTools에 mcp__<이름>·플러그인 변형 포함 ②판독 throw=고정 기본 4개 폴백 ③프로필 지정 우선 회귀 ④중복 이름 1회만.
- [ ] **Step 2: 검증·커밋** — `npx jest --testPathPattern="claude-cli"` PASS·build clean. `git commit -m "feat(mcp-parity): CLI 하네스 allowedTools를 클로드 MCP 전체로 동적 구성+자동 경로 프롬프트 판단 지침"`

---

### Task 5: 설정창 MCP 섹션 — 동기화 그룹 + 새로고침

**Files:**
- Modify: `src/desktop/mcp-file.ts`(listMcpServersFile에 source·url 노출), `src/desktop/main.ts`(IPC 1개 추가), `src/desktop/preload.ts`, `src/desktop/settings.html`

**Interfaces:**
- Consumes: T1·T2 (`readClaudeMcpServers`+`mirrorClaudeMcp`).
- Produces:
  - `listMcpServersFile` 반환형에 `source?: 'claude'`·`url?: string` 추가(command 없는 url형도 목록에 포함).
  - IPC `engram:sync-claude-mcp` → `mirrorClaudeMcp(configDir, readClaudeMcpServers())` 실행 후 목록 반환. preload `syncClaudeMcp: () => ...`.
  - settings.html MCP 섹션: 그룹 2개 — **"Claude에서 동기화됨"**(source='claude', ⊖ 없음, 캡션 "Claude에서 관리하세요"/"Managed in Claude", 헤더에 새로고침 버튼→syncClaudeMcp→목록 재렌더, "두뇌 연결은 다음 대화부터"/"applies from the next conversation" 캡션) + **"직접 추가"**(기존 UI 그대로). url형은 command 자리에 url 표시. 기존 인셋 리스트(.grp/.li) 문법·검색 인덱스에 새 라벨 추가.

- [ ] **Step 1: 기존 MCP 섹션 마크업·렌더 함수를 읽고 동형 확장.** 설정창은 유닛테스트 부재(플레인 HTML) — mcp-file 변경만 spec으로, UI는 스크립트 블록 문법 검사(new Function)+실스모크로.
- [ ] **Step 2: TDD(mcp-file)** — listMcpServersFile이 source·url 노출·url형 포함. `npx jest --testPathPattern="mcp-file"` PASS.
- [ ] **Step 3: 검증·커밋** — build clean. `git commit -m "feat(mcp-parity): 설정창 MCP 동기화 그룹(읽기 전용+새로고침)+직접 추가 병행"`

---

## Self-Review 결과

- 스펙 §3.1→T1, §3.2→T2, §3.3→T3, §3.4→T4, §3.5→T5, §4 실스모크→SDD 최종(controller: 실제 이 머신 클로드 설정에서 미러 생성 확인·로컬 stdio MCP 1개 엔그램 하네스 실왕복·CLI 스폰 인자 확인).
- 시그니처 일관: ClaudeMcpEntry(1↔2·4), McpServerConfig.url(2↔3), mirrorClaudeMcp(2↔5). 순서 1→2→3→4→5 (3·4는 2 이후 병렬 가능하나 SDD는 순차).
- 스펙 §3.1 "뒤에 읽은 것이 이김" 문구는 "user 최우선"과 모순 — Global Constraints에서 **먼저 읽은 것이 이김**으로 정정(스펙 의도=user 최우선 유지).
- 불확실 지점 명시: 자동 경로 프롬프트 실파일(T4 Step 1에서 추적·보고)·설치본 SDK의 StreamableHTTP export 경로(T3 구현자가 node_modules에서 확인).
