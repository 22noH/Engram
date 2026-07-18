# Phase 8c-2 엔그램 MCP 서버 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 엔그램을 MCP 서버로 열어 외부 클라이언트(Claude Code 등)가 위키 검색·읽기·목록·제안과 두뇌 위임(ask_brain)을 도구로 쓰게 한다. HTTP 내장(/mcp, 루프백 전용) + stdio 브리지.

**Architecture:** 저수준 SDK `Server`에 도구 5종을 장착하는 순수 빌더(`buildMcpServer(deps)`, 의존성 주입) → self.adapter `/mcp` 경로에 StreamableHTTPServerTransport(stateless)로 노출(루프백 강제·mcpDeps 미주입=404) → main.ts가 WikiEngine/ProposalStore/BrainDelegator로 실 배선 → 독립 stdio 브리지가 HTTP로 패스스루. 스펙: `docs/superpowers/specs/2026-07-18-phase8c2-mcp-server-design.md`

**Tech Stack:** @modelcontextprotocol/sdk 1.29.0(이미 dep — 8c-1), NestJS 상주, Electron 설정창.

## Global Constraints

- 명령은 PowerShell. jest 백그라운드 금지 — 포그라운드만. 테스트 `npm test -- --testPathPattern="<이름>"`, 빌드 `npm run build`.
- ★SDK API는 설치본(node_modules/@modelcontextprotocol/sdk)의 타입 선언이 소스 오브 트루스 — 서버측 저수준 `Server`+`ListToolsRequestSchema`/`CallToolRequestSchema`·`StreamableHTTPServerTransport`(stateless = `sessionIdGenerator: undefined`)·`StdioServerTransport`·클라측 `StreamableHTTPClientTransport`를 먼저 확인하고 코드 조정(계약 유지).
- 도구 실행 never-throw — 실패는 `{content:[{type:'text',text:...}], isError:true}`. 출력 상한 50k(8c-1과 동일 값) 절단.
- 코어(WikiEngine·ProposalStore·BrainDelegator·RagStore) 무변경 — 전부 주입으로 감싼다. CLI 두뇌·Orchestrator·8c-1 클라이언트 무변경.
- /mcp는 **루프백 전용**(127.0.0.1/::1/::ffff:127.0.0.1 외 403)·**mcpDeps 미주입(brain 모드)=404**.
- UI 문구 영어 기본+ko. 커밋에 Co-Authored-By 금지.

---

### Task 1: buildMcpServer — 도구 5종 순수 빌더 (src/edge/mcp/engram-mcp.ts)

**Files:**
- Create: `src/edge/mcp/engram-mcp.ts`, `src/edge/mcp/engram-mcp.spec.ts`

**Interfaces:**
- Produces (Task 2·3이 사용):

```typescript
export interface McpDeps {
  search(query: string, limit: number): Promise<Array<{ slug: string; title: string; snippet: string }>>;
  read(slug: string): Promise<{ title: string; content: string } | null>;
  list(): Promise<Array<{ slug: string; title: string; category?: string }>>;
  propose(input: { slug?: string; title: string; content: string; reason?: string }): Promise<string>;
  askBrain: ((brain: string, task: string) => Promise<string>) | null;
  brainNames(): string[];
}
export function buildMcpServer(deps: McpDeps): Server; // 저수준 SDK Server (8c-1 mcp-client.spec의 테스트 서버 패턴 참조)
```

- [ ] **Step 1: SDK 서버측 API 확인** — 8c-1의 `src/brain/mcp-client.spec.ts`가 저수준 `Server`+setRequestHandler로 테스트 서버를 만든 패턴을 그대로 참조(zod 직접 의존 없음). CallToolResult의 isError 형태 확인.
- [ ] **Step 2: 실패하는 테스트 작성** — InMemoryTransport + 8c-1의 `McpSession`(이미 있는 클라이언트!)으로 실 프로토콜 왕복. 가짜 deps(jest.fn)로:
  1. tools/list: askBrain 주입 시 5종(wiki_search·wiki_read·wiki_list·wiki_propose·ask_brain), null이면 4종(ask_brain 없음)
  2. wiki_search: {query:'x'} → deps.search('x', 5) 호출(기본 limit 5)·결과 텍스트에 slug/title/snippet 포함; limit:50 → 20으로 클램프
  3. wiki_read: 존재 slug → title+content 텍스트; null 반환 slug → isError('not found' 포함)
  4. wiki_list: 목록 텍스트(slug·title)
  5. wiki_propose: {title,content,reason} → deps.propose에 정확 전달·응답에 제안 id와 'review' 문구
  6. ask_brain: 등록 이름 → deps.askBrain(brain, task) 결과 텍스트; 미등록 이름 → isError(등록 목록 포함); askBrain=null인데 호출 → isError
  7. 출력 상한: deps.read가 60k content → 50k 절단+표식
  8. deps가 throw → isError 텍스트(never-throw)

(클라이언트로 8c-1 `McpSession.createForTest` 재사용 — 도구 이름은 세션 프리픽스가 붙으므로 `mcp__test__wiki_search`로 호출하고 tools/list 매핑으로 이름 검증.)

- [ ] **Step 3: 실패 확인** — Run: `npm test -- --testPathPattern="engram-mcp"` / Expected: FAIL.
- [ ] **Step 4: 구현** — 저수준 Server(name 'engram', capabilities {tools:{}}), ListTools 핸들러가 deps.askBrain 유무로 4/5종 반환(각 도구 inputSchema는 JSON Schema 리터럴), CallTool 핸들러가 switch(name)로 라우팅. 전 케이스 try/catch → isError. 헬퍼 `cap(text)` 50k 절단. 도구 설명은 영어(외부 클라이언트 대상 — 모델이 읽음): 예 wiki_search='Semantic search over the Engram wiki (team knowledge base). Returns matching pages with slug/title/snippet.', wiki_propose='Propose new knowledge for the wiki. A human reviews and approves it in the Engram app — nothing is written directly.', ask_brain='Delegate a subtask to one of the registered Engram brains: {names}'.
- [ ] **Step 5: 통과 확인** — Run: `npm test -- --testPathPattern="engram-mcp"` PASS + `npm run build` clean.
- [ ] **Step 6: 커밋** — `git commit -m "feat(8c2): buildMcpServer — 위키4+ask_brain 도구(주입식·never-throw·50k상한, InMemory 실프로토콜 테스트)"`

---

### Task 2: /mcp HTTP 노출 + main 실 배선

**Files:**
- Modify: `src/edge/messenger/self.adapter.ts` (+spec), `src/main.ts`
- Create: `src/edge/mcp/mcp-http.ts` (+spec) — 루프백 검사+transport 처리 순수 모듈

**Interfaces:**
- Consumes: Task 1 `buildMcpServer`/`McpDeps`; WikiEngine(`search(query, limit)`→SearchResult[]·`getPage(slug)`→WikiPage|null·`listPages(...)` — 시그니처·published 필터는 wiki-engine.ts 읽고 확인), ProposalStore(`NewProposal{userId,op,targetSlug,title,category,payload,sources,importance,verdict}` — create 계열 메서드 시그니처 확인), BrainDelegator(`handle(): DelegateSession` — brain-delegator.ts에서 run 계약 확인).
- Produces: `http://127.0.0.1:<port>/mcp` 동작. SelfMessenger 생성자에 `mcpDeps?: McpDeps` 옵션 인자(authDeps 관성 — 미주입=404).

- [ ] **Step 1: mcp-http.ts** — `isLoopback(remoteAddress)` 순수 함수 + `handleMcpRequest(server, req, res)`(StreamableHTTPServerTransport stateless로 요청당 처리 — SDK 권장 패턴을 설치본 예제/타입에서 확인). TDD: isLoopback('127.0.0.1'/'::1'/'::ffff:127.0.0.1' true, '192.168.0.5'/undefined false).
- [ ] **Step 2: self.adapter 배선** — start()의 라우팅에 `/auth/*` 패턴대로: `if (this.mcpDeps && req.url === '/mcp') { if (!isLoopback(req.socket.remoteAddress)) { 403; return; } void handleMcpRequest(...); return; }`. spec: mcpDeps 주입+루프백 → initialize 왕복 성공(실 http+8c-1 StreamableHTTP 클라 또는 raw POST), 비루프백 모킹 → 403, 미주입 → 404.
- [ ] **Step 3: main.ts 배선** — isServer 갈래에서 McpDeps 구성해 SelfMessenger에 전달:
  - search: `wiki.search(q, limit)` 결과 매핑(SearchResult의 snippet/text 필드명 확인)
  - read: `wiki.getPage(slug)` → 미게시/null → null (WikiPage의 published 판별 필드 확인)
  - list: `wiki.listPages(...)` 게시본만 매핑
  - propose: `proposals.create류({ userId: DEFAULT_USER 상수 확인, op: slug 기존 페이지면 'append' 아니면 'create', targetSlug: slug ?? slugify(title — WikiEngine에 slugify 헬퍼 있으면 재사용, 없으면 8c-1 slug와 유사 소문자-하이픈), title, category: 'external', payload: content, sources: ['mcp'], importance: 3, verdict: { confidence: 0.5, reason: `external MCP client proposal${reason ? ': '+reason : ''}` } })` → id 반환
  - askBrain: BrainDelegator 인스턴스가 main에서 접근 가능한지 확인(agent-layer.module 내부면 app.get으로) — 가능하면 `(brain, task) => delegator.handle() 경유 run`(8d 계약: 깊이1), 불가능하면 null 주입+보고서에 명시(ask_brain 미노출은 스펙상 유효 상태)
  - brainNames: `listBrainNames(paths.getConfigDir())` (brain.config 기존 함수)
- [ ] **Step 4: 검증** — `npm test` 전체 PASS·`npm run build` clean.
- [ ] **Step 5: 커밋** — `git commit -m "feat(8c2): /mcp HTTP 노출(루프백 전용·미주입 404)+main 실 배선(위키·제안·위임)"`

---

### Task 3: stdio 브리지 (src/mcp-bridge.ts)

**Files:**
- Create: `src/mcp-bridge.ts`, `src/mcp-bridge.spec.ts`

**Interfaces:**
- Consumes: SDK StdioServerTransport(서버측)+StreamableHTTPClientTransport(클라측)+Client. `/mcp` HTTP 엔드포인트(Task 2).
- Produces: `node dist/src/mcp-bridge.js [--port N]` — stdio MCP 서버로서 요청을 HTTP로 패스스루.

- [ ] **Step 1: 구현 설계 확인** — 가장 단순한 패스스루: 저수준 `Server`(stdio transport)를 만들고 ListTools/CallTool 핸들러가 내부 SDK `Client`(StreamableHTTPClientTransport로 상주 /mcp에 연결)의 listTools/callTool을 그대로 호출·반환. initialize는 각자 계층에서 SDK가 처리. 연결 실패 → CallTool은 isError 텍스트, ListTools는 빈 목록+stderr 로그.
- [ ] **Step 2: TDD** — spec: 실 http로 Task 1 buildMcpServer(가짜 deps)를 /mcp에 띄우고, 브리지의 핵심 함수(`makeBridgeServer(url)` — 엔트리에서 분리한 순수 조립부)를 InMemoryTransport로 왕복: tools/list 패스스루·wiki_search 호출 패스스루·상주 다운(닫힌 포트) → isError. 엔트리(main 실행부)는 인자 파싱(`--port`/ENGRAM_PORT/기본 포트 — chat.config의 기본 포트 상수 재사용)만 — 파싱 함수 유닛.
- [ ] **Step 3: 검증** — `npm test -- --testPathPattern="mcp-bridge"` PASS·빌드 clean·`node dist/src/mcp-bridge.js --port 1` 실행이 즉사하지 않고 stdio 대기(수동 1회, Ctrl-C).
- [ ] **Step 4: 커밋** — `git commit -m "feat(8c2): stdio 브리지 — HTTP /mcp 패스스루(구형 클라이언트 호환)"`

---

### Task 4: 설정창 안내 카드 + 문서

**Files:**
- Modify: `src/desktop/settings.html`, `README.md`(접속 안내 한 절)

**Interfaces:**
- Consumes: 기존 MCP 섹션(sec-mcp)·인셋 문법·`window.engram.status()`(포트는 chat.config — preload에 포트 노출이 없으면 status 응답이나 신규 IPC 없이 **기본 포트 텍스트로 표기**, 플랜 단순화).

- [ ] **Step 1: 카드** — sec-mcp 하단 `.grp-h`(t.mcpExpose) + `.grp` 한 줄: mono로 `claude mcp add --transport http engram http://127.0.0.1:<포트>/mcp` 표시 + 복사 버튼(navigator.clipboard) + `.cap`(t.mcpExposeCap: 루프백 전용·앱 실행 중이어야 함·stdio 브리지 경로 안내 한 줄). 포트: `window.engram.status()`에 포트가 없으면 chat.config 기본 포트 하드코딩 대신 **신규 IPC 없이 status에 이미 있는 값 확인 후 결정**(없으면 기본 포트 상수 문자열 — 구현자가 chat.config 확인).
- [ ] **Step 2: i18n** — ko: `mcpExpose: '이 엔그램을 외부 도구에서 쓰기', mcpExposeCap: '같은 PC의 Claude Code·Codex 등에서 위 명령으로 접속 — 위키 검색·읽기·제안과 두뇌 위임(ask_brain)이 도구로 제공돼요 (앱 실행 중일 때, 이 PC에서만)', copied: '복사됨'(기존 t.copied 있으면 재사용)` / en 대응. SECTION_LABELS 갱신.
- [ ] **Step 3: README** — "Use Engram from Claude Code (MCP)" 한 절: HTTP 한 줄 + 브리지 한 줄 + 도구 5종 표.
- [ ] **Step 4: 검증·커밋** — build+`npm test` 전체 PASS. `git commit -m "feat(8c2): 설정창 외부 접속 안내 카드+README — 전면 완성"`

---

## Self-Review 결과

- 스펙 §3.1→Task 1, §3.2→Task 2, §3.3→Task 3, §3.4→Task 4, §3.5(루프백·미주입 404)→Task 2, §4 테스트→각 태스크(8c-1 McpSession을 테스트 클라이언트로 재사용 = 클라·서버 상호검증 보너스), §4 실스모크(controller가 claude mcp add)→SDD 최종 단계에서 컨트롤러 수행. 갭 없음.
- 시그니처 일관성: McpDeps(1↔2), buildMcpServer(1↔2↔3 테스트), isLoopback/handleMcpRequest(2), makeBridgeServer(3). 코어 API는 확인 지시(시그니처가 다층이라 구현자가 원본 파일 확인 — getPage/listPages/NewProposal/DelegateSession).
- 불확실 지점 명시: SDK Streamable 서버 stateless 패턴(설치본 확인)·main에서 BrainDelegator 접근 가능성(불가면 null=유효 폴백)·status의 포트 노출 여부.
