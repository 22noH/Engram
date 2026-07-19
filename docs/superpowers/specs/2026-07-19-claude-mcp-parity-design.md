# 클로드 MCP 패리티 — 설계

날짜: 2026-07-19
상태: 승인 대기 (브레인스토밍 완료)

## 1. 목적

사용자가 클로드(Claude Code/Desktop)에 붙여둔 MCP들을 엔그램에서도 그대로 쓴다.
클로드와 엔그램을 번갈아 쓸 때 도구 환경이 달라지면 쓸 이유가 없다 — "클로드에 붙이면
엔그램에도 있는 게 기본"이 목표. (사용자 명시 요구: 동기화되거나, 똑같이 설치할 수
있는 모든 수단 제공.)

## 2. 사용자 결정

- 방식 = **클로드 설정을 원본으로 자동 미러링** (별도 등록 작업 없음, 재시작 시 갱신).
- CLI 하네스 허용 목록 = **전 경로 전부 개방** (채팅·observe·예약·ambient 구분 없음).
  차단 대신 **자동 실행 경로의 프롬프트에 판단 지침**("자동 맥락에서는 밖에 쓰는
  도구[발송·수정]는 명시 지시가 있을 때만, 아니면 읽기 위주") — 사용자 결정: 자물쇠보다
  판단. 프롬프트는 prompts/에서 사용자가 수정 가능.
- claude.ai 계정 커넥터(OAuth)는 물리적으로 미러 불가 — 정직한 비범위. CLI 하네스로
  쓸 때는 claude가 자체 로드하므로 커버됨.

## 3. 설계

### 3.1 클로드 MCP 소스 판독 (신규 claude-mcp-import.ts, desktop 쪽)

읽기 전용 판독. 두 소스:

1. **user 스코프**: `~/.claude.json`의 `mcpServers` — stdio(`{command,args,env}`)와
   http(`{type:'http'|'sse', url[, headers]}`) 항목.
2. **설치된 플러그인**: `~/.claude/plugins/installed_plugins.json`(version 2,
   `plugins[name][].installPath`)에서 각 `installPath/.mcp.json`을 읽음 — 포맷은
   `{ 서버명: {command,args[,env]} | {type,url} }`.

파싱은 기존 mcp-config.ts 관성 그대로: 이름 slug 검증(`isValidMcpName` — __proto__류
명시 거부), 형 검증 실패 항목은 조용히 스킵(never-throw). 파일 없음/깨짐 = 빈 결과.
경로는 os.homedir() 기준(하드코딩 금지). 플러그인 서버명이 겹치면 뒤에 읽은 것이 이김
(결정적 순서: user 스코프 → 플러그인 알파벳순 — user가 최우선).

### 3.2 엔그램 mcp.json으로 미러 병합

- mcp.json 스키마 확장: 서버 항목에 `source?: 'claude'` 표시. source='claude' 항목은
  미러가 소유(다음 동기화 때 갱신·삭제 대상). source 없는 항목 = 사용자 수동 등록(불가침).
- **동기화 시점 = 앱 시작 시 1회** (main 부트에서 judge 전). 클로드에서 지운 서버는
  미러에서도 지움. 수동 항목과 이름 충돌 시 수동이 이김(미러 스킵 + 로그).
- 클로드가 아예 없는 머신 = 소스 0개 = 미러 no-op — 기존 동작 그대로(회귀 0).

### 3.3 MCP 클라이언트 HTTP 지원 (mcp-client.ts)

- 현재 stdio(StdioClientTransport)만 지원 → `{type:'http', url}` 항목은
  StreamableHTTPClientTransport로 연결(공식 SDK 지원). sse 타입은 http로 시도 후
  실패하면 스킵+로그(구식 전송 — 완전 구현은 비범위).
- 기존 계약 유지: connect 10s 타임아웃·callTool 60s·출력 50k 상한·never-throw·
  finally 전세션 close. OAuth 요구 서버(401)는 조용히 스킵+로그(비범위 — §2).

### 3.4 CLI 하네스 허용 목록 전체 개방

- claude-cli 스폰 기본 `--allowedTools`를 "웹검색+엔그램 MCP 고정 목록"에서
  **"웹검색+`mcp__<이름>` 전 서버"**로: 3.1의 판독 결과 이름들 + 플러그인 등록명
  변형(`mcp__plugin_<플러그인>_<서버>`) + 기존 engram 항목. 판독 실패 시 현행 기본으로
  폴백. 프로필이 --allowedTools를 직접 주면 그게 우선(기존 관성).
- 자동 실행 경로 프롬프트(관련 프롬프트 파일: conductor/observe/ambient 계열 — 플랜에서
  실파일 확정)에 판단 지침 1~2문장 추가: "예약·자동 맥락에서 외부에 쓰는 도구(메시지
  발송·문서 수정 등)는 작업 지시문에 명시된 경우에만. 그 외 자동 맥락은 읽기 위주."

### 3.5 설정창 MCP 섹션 개편

- 목록을 두 그룹으로 표시: **"Claude에서 동기화됨"**(source='claude', 읽기 전용 —
  삭제·수정 불가, "Claude에서 관리하세요" 캡션) + **"직접 추가"**(기존 편집 UI 그대로).
- 동기화 그룹 헤더에 새로고침 버튼(재판독+병합 — 재시작 없이 반영. 두뇌 연결은 다음
  대화부터라는 캡션). HTTP 항목은 url 표시.
- i18n en 기본+ko. 기존 인셋 리스트 문법 그대로.

## 4. 테스트

- claude-mcp-import: user 스코프/플러그인 판독·형 오류 스킵·이름 충돌 우선순위·파일
  없음=빈 결과.
- 미러 병합: source='claude' 갱신·삭제, 수동 항목 불가침, 이름 충돌=수동 승리.
- mcp-client: http 항목 연결(InMemory/로컬 http 목), 401 스킵, 기존 stdio 회귀 0.
- claude-cli: allowedTools가 판독 이름들로 구성·판독 실패 폴백·프로필 우선 유지.
- 설정창: 두 그룹 렌더·동기화 항목 편집 불가·새로고침.
- 실스모크: 실제 ~/.claude.json+플러그인 캐시에서 미러 생성 확인, 로컬 stdio MCP 1개
  실왕복(엔그램 하네스 모델로), CLI 하네스 allowedTools 실스폰 인자 확인.

## 5. 비범위

- claude.ai 계정 커넥터(OAuth) 미러 · MCP OAuth 플로우 구현 · sse 완전 지원 ·
  프로젝트 스코프 .mcp.json(작업 폴더 개념이 엔그램에 없음) · 실시간 파일 감시
  동기화(시작 시+수동 새로고침으로 충분) · 도구별 세밀 권한 매트릭스(이월 후보).
