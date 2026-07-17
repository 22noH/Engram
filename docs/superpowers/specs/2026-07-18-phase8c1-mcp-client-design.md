# Phase 8c-1 — MCP 클라이언트 설계

날짜: 2026-07-18
상태: 승인됨 (브레인스토밍 완료)

## 1. 문제 / 목적

엔그램 하네스 두뇌(anthropic-api·openai-api)의 도구는 직접 만든 것뿐이다(웹 2종·
파일 5종·Bash). 도구를 늘리려면 매번 코드를 짜야 한다. MCP(Model Context Protocol)는
"AI에 도구를 꽂는 공개 표준"이고, 이미 생태계(GitHub·브라우저·DB·노션 등 서버들)가
있다. 8c-1은 엔그램을 그 표준의 **클라이언트**로 만든다 — 사용자가 MCP 서버를
등록하면 두뇌가 그 도구들을 채팅·코딩 루프에서 그대로 쓴다. 도구 추가가 "코딩"에서
"설정 한 줄"이 된다.

★사용자 방향 결정: **공식 표준 준수가 페이즈의 존재 이유** — "Engram 없이도 성립하는
표준"에 올라탄다. 손수 구현(방언 위험) 대신 공식 SDK 채택.

## 2. 범위 결정 (사용자 확정)

- 8c를 쪼갠다: **8c-1 = 클라이언트만** (이 스펙). 서버 방향은 8c-2.
- 설정창 UI 포함 (MCP 섹션).
- **8c-2 이월 — 필수 포함(잊지 말 것, 사용자 명시 요청)**: 엔그램이 MCP **서버**가
  되어 외부 MCP 클라이언트(Claude Code·codex 등)에게 노출: ①위키 의미검색·페이지
  읽기 ②위키 제안(proposal — 승인은 여전히 사람) ③`ask_brain`(=CLI 두뇌를 지휘자로,
  8d 이월분). "위키가 앱 밖 도구들의 공유 기억이 되는 그림".

## 3. 설계

### 3.1 의존성 — 공식 SDK

- `@modelcontextprotocol/sdk` 프로덕션 dep 추가. 8a의 "무SDK" 관례는 안정 HTTP API
  대상이었고, MCP는 버전 협상이 살아있는 표준이라 손 구현은 방언 위험 — 예외 사유를
  여기 명시한다. SDK가 stdio 외 원격 전송(Streamable HTTP)도 갖고 있어 후속 확장이
  싸진다(이번엔 stdio만 사용).

### 3.2 클라이언트 래퍼 (신규 src/brain/mcp-client.ts)

- `McpSession` — 서버 config 한 항목으로 SDK `Client`+`StdioClientTransport` 생성.
  - `connect(): Promise<boolean>`: initialize 핸드셰이크. 실패 = false(throw 안 함,
    사유는 logger) — 호출측(두뇌)은 false인 세션을 도구 병합에서 제외.
  - `listToolDefs(): WebToolDef[]` — SDK `listTools()` 결과를 기존 `WebToolDef`
    {name, description, parameters}로 매핑. 이름 = `mcp__{서버이름}__{도구이름}`
    (Claude Code 관례와 동일 — 충돌 없고 라우팅이 프리픽스로 끝남).
  - `callTool(toolName, input): Promise<string>` — 결과 content 배열 평탄화:
    text 항목은 이어붙이고 비텍스트(image 등)는 `[image]`류 표기. **never-throw**
    (실패 = 에러 텍스트 반환 — 웹도구와 동일 계약). 호출 타임아웃 + 출력 상한
    (웹도구 50k 상수 재사용).
  - `close()`: transport 종료(자식 프로세스 정리). 이중 호출 안전.
- 서버 프로세스는 SDK transport가 spawn — ★8b-2 교훈 적용 확인: SDK가 에러를
  이벤트로 노출하면 반드시 구독(언핸들드 'error' = 호스트 크래시 클래스).

### 3.3 설정 파일 (mcp.json)

- `configDir/mcp.json`: `{ "mcpServers": { "이름": { "command": string,
  "args"?: string[], "env"?: Record<string,string> } } }` — **Claude Code `.mcp.json`과
  동일 포맷**(복붙 호환이 요구사항).
- 로더 `loadMcpServers(configDir)`: fault-tolerant(없음/깨짐 → {}), 형태 틀린 항목
  skip, command 빈 항목 skip.

### 3.4 두뇌 배선 (anthropic-api·openai-api complete())

- 진입 시 mcp.json에 서버가 있으면 각 서버 `McpSession` 연결(lazy). 연결 실패 서버는
  조용히 제외+logger. 도구 def를 기존 도구(웹/코딩/Bash/ask_brain) **뒤에** 병합.
- executeTool: 이름이 `mcp__` 프리픽스면 해당 세션으로 라우팅, 아니면 기존 경로.
- **finally에서 전 세션 close** — 대화 한 번(complete) 단위 spawn/kill.
  // ponytail: 상주 세션 캐시는 후속 신호 오면(스폰 비용이 실측으로 아플 때).
- 서버 0개(=mcp.json 없음)면 오늘과 완전 동일 — 회귀 0. CLI 두뇌 3종 무변경
  (claude CLI는 자체 MCP 지원이 있고, 엔그램 쪽 노출은 8c-2).
- 채팅·코딩 루프 공통(tool-loop이 이미 도구 배열 중립).

### 3.5 설정창 UI (MCP 섹션)

- 사이드바 항목 추가(타일 색 신규 1종), 인셋 문법 재사용: 서버 목록(이름 mono ·
  command+args 요약 muted · ⊖) + ＋ 추가 인라인 폼(이름·command·args[공백 구분 한 줄
  입력→배열 split]) + 캡션("Claude Code의 .mcp.json과 같은 포맷 — 파일 직접 편집도
  가능") + 재시작 힌트. env 편집은 UI 비범위(파일로).
- desktop 순수 함수 신규 `mcp-file.ts`: `listMcpServers`/`addMcpServer`(이름 충돌 시
  덮어쓰기 대신 false — brains 관례)/`removeMcpServer`. IPC 3종+preload. 정형 패턴
  5번째 반복.

### 3.6 보안 모델

- **등록 = 동의**: MCP 서버는 사용자가 설정창/파일로 명시 등록한 임의 프로그램이다
  (Claude Code와 동일 모델). 도구 개별 권한 게이트는 이번 비범위 — PermissionFence
  무변경. 도구 결과는 텍스트로만 되먹임(출력 상한).
- 서버 이름은 도구 이름에 들어가므로 `[a-z0-9_-]`만 허용(slug 검증 — 프리픽스 파싱
  안전). UI·파일 로더 양쪽에서 필터.

## 4. 테스트

- 래퍼: SDK의 `InMemoryTransport`로 **실제 프로토콜 왕복** 통합 테스트(모킹 없이) —
  연결→목록 매핑(mcp__ 프리픽스)→호출 성공→서버측 에러→타임아웃→출력상한→close 멱등.
- 두뇌: 서버 0개 회귀 0 · def 병합 순서 · mcp__ 라우팅 · 연결실패 서버 제외 ·
  finally close 호출 — 기존 두뇌 spec 패턴.
- mcp-file/IPC/UI: 기존 정형 패턴.
- 실 스모크(수동 또는 controller computer-use): `npx -y @modelcontextprotocol/server-everything`
  등록 → 채팅에서 도구 호출 왕복 확인.

## 5. 비범위

- **8c-2(다음 페이즈, §2의 이월 필수 포함 목록)** — 엔그램 MCP 서버(위키 검색·읽기·
  제안 + ask_brain=CLI 지휘자).
- 원격(HTTP) MCP 서버 연결 · resources/prompts · 서버 상주 캐시 · 도구 개별 권한
  게이트 · env 편집 UI.
