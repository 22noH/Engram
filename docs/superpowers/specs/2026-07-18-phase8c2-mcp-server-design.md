# Phase 8c-2 — 엔그램 MCP 서버 설계

날짜: 2026-07-18
상태: 승인됨 (브레인스토밍 완료 — 업계 표준 패턴 검증 포함)

## 1. 목적

엔그램을 MCP **서버**로 열어, 외부 MCP 클라이언트(Claude Code·Codex·Cursor 등)가
엔그램의 위키(지식 코어)와 두뇌 위임을 도구로 쓰게 한다. "위키가 앱 밖 도구들의 공유
기억"이 되는 그림 — 8c-1 스펙 §2가 사용자 명시로 이월한 필수 항목.

업계 검증(2026-07 검색): "기억/지식창고를 MCP 서버로"는 확립된 카테고리(Basic Memory·
Mem0·Obsidian vault MCP — 전부 검색·읽기·추가 도구 셋). Claude Code 접속 표준은
stdio+HTTP(streamable) 2종, SSE는 폐기 수순. 엔그램 차별점: add 대신 **propose**
(사람 승인 게이트=파괴 불가 원칙 유지)와 **ask_brain**(두뇌 위임 — 저들에겐 없음).

## 2. 범위 결정 (사용자 확정)

- 접속 = **둘 다**: HTTP 내장(코어) + stdio 브리지(호환용).
- 인증 = **루프백 전용**(127.0.0.1만, 원격 차단). 원격+토큰은 후속.
- 도구 5종: wiki_search·wiki_read·wiki_list·wiki_propose·ask_brain.

## 3. 설계

### 3.1 MCP 서버 코어 (신규 src/edge/mcp/engram-mcp.ts)

- SDK(이미 dep) `McpServer`(고수준, zod는 SDK 전이 의존) 또는 저수준 `Server`+
  setRequestHandler(8c-1 테스트 패턴 재사용 — zod 직접 의존 회피 위해 **저수준 채택**).
- 의존성 주입 인터페이스(테스트는 가짜 주입, main이 실 배선):

```typescript
export interface McpDeps {
  search(query: string, limit: number): Promise<Array<{ slug: string; title: string; snippet: string }>>;
  read(slug: string): Promise<{ title: string; content: string } | null>;   // 게시본만, 없으면 null
  list(): Promise<Array<{ slug: string; title: string; category?: string }>>; // 게시본만
  propose(input: { slug?: string; title: string; content: string; reason?: string }): Promise<string>; // 제안 id
  askBrain: ((brain: string, task: string) => Promise<string>) | null;      // 미주입=도구 미노출
  brainNames(): string[];                                                    // ask_brain 설명·검증용
}
export function buildMcpServer(deps: McpDeps): Server; // tools/list·tools/call 핸들러 장착
```

- 도구 계약(전부 never-throw — 실패는 isError content 텍스트):
  - `wiki_search {query, limit?}`: limit 기본 5·상한 20. 결과 텍스트(각 히트 slug·title·snippet).
  - `wiki_read {slug}`: 없는/미게시 slug → isError 'not found'.
  - `wiki_list {}`: slug·title·category 목록.
  - `wiki_propose {title, content, slug?, reason?}`: 제안 생성 → "proposal <id> created —
    a human will review it in the Engram app" 텍스트. **직접 쓰기 아님**(승인은 앱 승인함).
  - `ask_brain {brain, task}`: deps.askBrain 미주입이면 도구 자체를 tools/list에서 제외.
    미등록 brain 이름 → isError(등록 이름 목록 안내).
- 출력 상한: 도구 결과 50k(8c-1 상수와 동일 값) 절단.

### 3.2 HTTP 내장 (self.adapter /mcp)

- self.adapter HTTP 서버에 `/mcp` 경로 위임 — `/auth/*`와 같은 패턴. SDK
  `StreamableHTTPServerTransport`(stateless 모드)로 요청 처리.
- **루프백 강제**: `req.socket.remoteAddress`가 127.0.0.1/::1/::ffff:127.0.0.1 아니면
  403 (ws가 0.0.0.0에 열린 팀 서버 모드에서도 /mcp는 잠김).
- 주입 패턴: `mcpDeps` 옵션 주입 — **메인 서버에만 주입, brain 모드(로컬 두뇌) 미주입**
  (미주입이면 /mcp는 404 = 현행과 동일). authDeps 관성 그대로.
- main.ts(서버) 배선: WikiEngine.search/게시 read·list, ProposalStore 제안 생성(15a
  경로 재사용), BrainDelegator 있으면 askBrain 핸들(깊이1 재사용).
- 접속: `claude mcp add --transport http engram http://127.0.0.1:<포트>/mcp`.

### 3.3 stdio 브리지 (신규 src/mcp-bridge.ts → dist/src/mcp-bridge.js)

- 독립 엔트리: SDK stdio **서버** transport로 클라이언트를 받고, 같은 SDK의
  streamable HTTP **클라이언트**로 상주 `/mcp`에 그대로 중계(initialize·tools/list·
  tools/call 패스스루). HTTP를 못 쓰는 구형 클라이언트용.
- 포트: `ENGRAM_PORT` env 또는 `--port` 인자, 기본 chat.config 기본 포트.
- 상주 미실행이면 연결 에러를 MCP 에러로 그대로 반환(재시도·감독 없음 — ponytail).
- 접속: `claude mcp add engram -- node <앱경로>/dist/src/mcp-bridge.js`.

### 3.4 설정창 안내 카드 (표시 전용)

- MCP 섹션 하단 그룹 "이 엔그램을 외부 도구에서 쓰기": HTTP 접속 명령 한 줄 표시
  (mono)+복사 버튼. 새 설정 항목 아님. i18n en+ko.

### 3.5 보안 모델

- 루프백 전용 = 같은 PC의 프로세스만. 위키 게시본 읽기·검색은 기존 ws 무게이트 관성과
  동일 수준. 쓰기는 propose뿐(승인 게이트). ask_brain은 두뇌 비용 소모 가능 — 같은 PC
  사용자의 도구 호출 = 본인 사용으로 간주(현행 신뢰 모델). 원격 노출 시 토큰은 후속.
- ★알려진 풋건(최종리뷰 승인·수용): 사용자가 어떤 두뇌의 mcp.json에 엔그램 자신의
  /mcp(브리지)를 등록하면, ask_brain→두뇌→8c-1 MCP 클라이언트→다시 /mcp의 ask_brain으로
  8d 깊이1 가드를 넘는 홉 체인이 구성 가능하다. 기본 설정으론 불가(의도적 자기참조
  등록 필요)·루프백 한정·홉마다 실 API 비용+반복 상한이라 자기제한적 — 수용. 후속
  완화 후보: 홉 예산 또는 ask_brain 경유 요청에 ask_brain 재노출 억제.

## 4. 테스트

- engram-mcp: SDK InMemoryTransport로 실 프로토콜 왕복(8c-1 패턴) — tools/list(askBrain
  미주입 시 4종/주입 시 5종)·각 도구 성공·not found·미등록 brain·50k 절단·propose가
  deps.propose에 정확 전달.
- /mcp HTTP: 실 http 서버로 initialize+tools/list 왕복, ★루프백 아닌 remoteAddress
  모킹 → 403, mcpDeps 미주입 → 404.
- 브리지: 실 http /mcp 띄우고 stdio 왕복 1회(InMemory 아닌 실 자식 프로세스는 스모크로).
- 실스모크: **이 Claude Code 세션에서 직접** `claude mcp add`로 등록해 wiki_search·
  wiki_propose 왕복 — 클라이언트가 컨트롤러 본인이라 진짜 엔드투엔드 가능.

## 5. 비범위

- 원격 접속(토큰 인증)·resources/prompts 노출·위키 직접 쓰기(제안만)·채팅 참여·
  브리지의 상주 자동기동. CLI-as-conductor의 나머지 반쪽(claude CLI가 이 MCP로
  ask_brain을 쓰는 실사용)은 이번 산출물로 자동 성립 — 별도 코드 불필요.
