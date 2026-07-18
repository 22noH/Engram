# 헤드리스 엔그램 MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npx engram-mcp` 한 줄로 앱 없이 엔그램 지식 코어를 stdio MCP로 쓰게 하고(승인함=채팅), 같은 승인·쓰기 도구를 앱 /mcp에도 모드로 지원한다. 패키징(npm pack 검증)까지, publish는 사용자.

**Architecture:** ①공용 승인 어댑터+buildMcpServer 도구 확장(proposals 3종+wiki_write) → ②앱 배선: self.adapter가 per-request로 자신의 `approving` Set·broadcast를 공유한 어댑터를 증강 주입(ws 승인함과 진짜 동시성 공유), permissions.json `allow.mcpWriteMode` 토글+설정창 → ③헤드리스 엔트리: OS별 앱 데이터 경로 계산→상주 감지→(떠있으면 기존 mcp-bridge 폴백/아니면 Nest 코어 부트)→stdio 서빙 → ④패키징(bin+files+shebang+npm pack 실검증)+README. 스펙: `docs/superpowers/specs/2026-07-18-headless-mcp-design.md`

**Tech Stack:** 기존 SDK·Nest·8c-1/8c-2 모듈 재사용. 신규 dep 없음.

## Global Constraints

- PowerShell·jest 포그라운드만(백그라운드 행)·`npm test`/`npm run build`.
- 코어(WikiEngine·ProposalStore·ProposalApplier·RagStore) 무변경 — 조합만. 8c-1/8c-2 기존 도구·계약 무변경(회귀 0).
- 도구 실행 never-throw(isError 텍스트)·출력 50k 상한·stdio 경로에서 stdout은 MCP 와이어 전용(로그는 stderr/파일).
- UI 문구 영어 기본+ko. 커밋 Co-Authored-By 금지.
- SDK API는 설치본 타입이 소스 오브 트루스.

---

### Task 1: 공용 승인 어댑터 + buildMcpServer 도구 확장

**Files:**
- Create: `src/edge/mcp/mcp-proposals.ts`, `src/edge/mcp/mcp-proposals.spec.ts`
- Modify: `src/edge/mcp/engram-mcp.ts`, `engram-mcp.spec.ts`

**Interfaces:**
- Consumes: `ProposalStore`(listPending(userId)·get(id)·상태는 'pending'|'approved'|'rejected')·`ProposalApplier`(apply(p)·reject(p)) — src/edge/proposal-applier.ts:11-34 참조, 무변경.
- Produces (Task 2·3 사용):

```typescript
// mcp-proposals.ts
export interface McpProposalsDeps {
  list(): Promise<Array<{ id: string; title: string; op: string; targetSlug: string; preview: string }>>;
  approve(id: string): Promise<string>; // 성공 요약 텍스트, 실패는 throw(도구층이 isError로)
  reject(id: string): Promise<string>;
}
export function makeMcpProposals(
  proposals: ProposalStore, applier: ProposalApplier,
  opts?: { approving?: Set<string>; onChanged?: () => void }, // approving 미전달=자체 Set, onChanged=적용 후 알림(앱 broadcast용)
): McpProposalsDeps;

// engram-mcp.ts McpDeps 확장(기존 필드 무변경):
proposals?: McpProposalsDeps | null;
write?: ((input: { slug?: string; title: string; content: string }) => Promise<string>) | null;
```

- [ ] **Step 1: mcp-proposals TDD** — spec 케이스: list=pending만·preview=payload 앞 200자 / approve 성공(applier.apply 호출+onChanged 호출+요약에 targetSlug) / 없는 id·이미 approved → throw(메시지에 사유) / ★동시 approve 두 번(같은 id, applier를 100ms 지연 가짜로) → 한 번만 apply·두 번째는 in-flight 거부 throw / 외부 approving Set 전달 시 그 Set 사용(사전에 add해두면 즉시 거부) / reject 동형. 구현: ws 경로(self.adapter.ts:361-375)와 같은 결 — `approving.has→throw / add / try{ get→pending 확인→apply→onChanged } finally{ delete }`.
- [ ] **Step 2: buildMcpServer 확장 TDD** — engram-mcp.spec에 추가(기존 14케이스 무변경 통과 = 회귀 0 확인): deps.proposals 주입 시 tools/list에 `list_proposals`·`approve_proposal`·`reject_proposal` 추가(미주입=기존과 동일 4/5종) / list_proposals 결과 텍스트(id·title·op·targetSlug·preview) / approve_proposal {id} 성공·어댑터 throw → isError / write 주입 시 `wiki_write` 추가, {title, content, slug?} 전달 확인 / 승인 도구 설명에 "human gate — only call when the user explicitly asks" 포함 확인. 구현: 기존 스위치에 4케이스 추가(전부 try/catch isError·50k cap 재사용).
- [ ] **Step 3: 검증·커밋** — `npm test -- --testPathPattern="mcp-proposals|engram-mcp"` PASS·build clean. `git commit -m "feat(headless): 공용 승인 어댑터+MCP 도구 4종 확장(list/approve/reject/write — in-flight 가드·human-gate 설명)"`

---

### Task 2: 앱 /mcp 모드 배선 (self.adapter 증강 + mcpWriteMode + 설정창)

**Files:**
- Modify: `src/edge/messenger/self.adapter.ts`(+spec), `src/desktop/permissions-file.ts`(+spec), `src/main.ts`, `src/desktop/main.ts`, `src/desktop/preload.ts`, `src/desktop/settings.html`

**Interfaces:**
- Consumes: Task 1 `makeMcpProposals`·확장 McpDeps. self.adapter의 `this.approving`(:364)·`this.wikiDeps`·`this.broadcast`.
- Produces: 앱 /mcp에 승인 도구 상시+wiki_write(모드), `window.engram.getMcpWriteMode()/setMcpWriteMode(mode)`.

- [ ] **Step 1: self.adapter 증강** — /mcp 분기의 per-request `buildMcpServer(this.mcpDeps)`를 다음으로: wikiDeps 있으면 `{...this.mcpDeps, proposals: makeMcpProposals(this.wikiDeps.proposals, this.wikiDeps.applier, { approving: this.approving, onChanged: () => { this.broadcast({t:'wikiChanged'}); this.broadcast({t:'proposalsChanged'}); } })}` — ★ws 승인함과 **같은 Set** 공유로 교차 경로 이중승인 원천 차단+앱 UI 실시간 갱신. wiki_write는 `this.mcpDeps.write`가 이미 담겨 오면 그대로(주입은 main 몫). spec: /mcp tools/list에 승인 도구 포함·ws로 먼저 approving.add된 id는 MCP approve가 거부.
- [ ] **Step 2: mcpWriteMode** — permissions-file.ts에 `getMcpWriteMode(configDir): 'propose'|'write'`(기본 propose)·`setMcpWriteMode(configDir, mode)`(commandMode와 동일 결·화이트리스트 검증) TDD. src/main.ts: `getMcpWriteMode`는 서버측이 못 쓰므로(desktop 모듈) — permissions.json을 직접 읽는 동일 로직을 main측 어디서 얻을지 확인: PermissionFence가 이미 permissions.json 로드함 — fence 설정에서 읽거나 간단히 main에서 직접 파일 파싱(둘 중 기존 결에 맞는 쪽, 구현자가 fence 로더 확인). 'write'면 mcpDeps.write에 어댑터 주입: `existing=await wiki.getPage(slug ?? slugifyMcpTitle(title))` → 있으면 `wiki.updatePage(slug, {body: content})`·없으면 `wiki.createPage({slug, title, category:'external', body:content, sources:['mcp'], status:'published'})` — mcp-propose.ts의 slugify 재사용(export 확인).
- [ ] **Step 3: 설정창 토글** — MCP 섹션(안내 카드 위)에 `.li` 줄: 라벨 t.mcpWrite + select(t.mcpWriteProposeOpt/t.mcpWriteWriteOpt) — cmd-mode 패턴 재사용. IPC `engram:get-mcp-write-mode`/`set-mcp-write-mode`+preload. i18n ko: `mcpWrite:'MCP 쓰기', mcpWriteProposeOpt:'제안만 (사람이 승인)', mcpWriteWriteOpt:'직접 쓰기 (승인 없이 반영)'` / en: `'MCP writes'·'Propose only (human approves)'·'Direct write (no approval)'`. SECTION_LABELS 갱신.
- [ ] **Step 4: 검증·커밋** — `npm test` 전체 PASS·build clean. `git commit -m "feat(headless): 앱 /mcp 모드 — 승인 도구 상시(ws와 in-flight 공유·broadcast)+mcpWriteMode 토글(설정창)"`

---

### Task 3: 헤드리스 엔트리 (mcp-headless.ts)

**Files:**
- Create: `src/mcp-headless.ts`, `src/mcp-headless.spec.ts`

**Interfaces:**
- Consumes: buildMcpServer+makeMcpProposals(Task 1)·makeBridgeServer(mcp-bridge)·DEFAULT_CHAT_PORT·AppModule(Nest)·WikiEngine·ProposalStore·ProposalApplier·makeMcpPropose·slugify.
- Produces: `node dist/src/mcp-headless.js [--data-dir D] [--write-mode] [--port N]` stdio MCP 서버.

- [ ] **Step 1: 조립부 순수 함수 TDD** —
  - `defaultDataDir(platform, env): string` — win32=`%APPDATA%/Engram`·darwin=`~/Library/Application Support/Engram`·기타=`$XDG_CONFIG_HOME||~/.config`/Engram (Electron userData와 동일 규칙 — spec 케이스 3플랫폼).
  - `parseHeadlessArgs(argv, env): { dataDir, writeMode, port }` — --data-dir/--write-mode/--port·ENGRAM_DATA_DIR·기본값.
  - `chooseMode(port): Promise<'bridge'|'core'>` — `http://127.0.0.1:port/` GET 2s 타임아웃: 200 ok:true→'bridge', 실패→'core' (실 http 서버로 spec).
- [ ] **Step 2: 부트 구현** — 엔트리(require.main 가드): parse→`process.env.ENGRAM_DATA_DIR ??= dataDir`→chooseMode. bridge면 `makeBridgeServer(url)`+stderr 안내("app is running — bridging to /mcp; write mode follows the app's setting"). core면: **AppModule 확인**(구현자: HeartbeatEmitter·WikiWatcher 등 @Cron/onModuleInit 항목이 헤드리스에 유해한지 — ENGRAM_RESIDENT 미설정으로 하트비트 억제 여부 확인, 유해 항목은 env 플래그로 조건 비활성이 필요하면 최소로) → `NestFactory.createApplicationContext(AppModule, { logger: false })`(Nest 부팅 로그가 stdout 오염 금지 — PinoLogger 파일 로그는 유지) → deps 조립: search/read/list/propose=main.ts의 기존 배선과 동일 매핑(코드 복제 대신 **main.ts의 해당 조립을 공용 함수로 추출** — `src/edge/mcp/mcp-wiring.ts` `makeWikiMcpDeps(wiki, proposals)` 신설, main.ts도 이걸 쓰도록 리팩터[동작 무변경]) + proposals=makeMcpProposals(자체 Set) + write=--write-mode일 때만 + askBrain=null → buildMcpServer→StdioServerTransport. SIGINT/트랜스포트 close 시 `app.close()`.
- [ ] **Step 3: 검증** — spec(조립부)+`npm test` 전체 PASS·build clean. 수동: 앱 꺼진 상태에서 `node dist/src/mcp-headless.js --port 1`이 stdio 대기(즉사 안 함)·stdout 무출력 확인.
- [ ] **Step 4: 커밋** — `git commit -m "feat(headless): mcp-headless 엔트리 — OS별 데이터경로·상주 감지 브리지 폴백·Nest 코어 stdio 서빙(mcp-wiring 공용 추출)"`

---

### Task 4: 패키징 + README

**Files:**
- Modify: `package.json`, `README.md`, `src/mcp-headless.ts`(shebang)

- [ ] **Step 1: bin·files** — mcp-headless.ts 첫 줄 `#!/usr/bin/env node`(nest build가 보존하는지 확인 — 안 되면 postbuild로 추가하거나 bin 래퍼 js). package.json: `"bin": { "engram-mcp": "dist/src/mcp-headless.js" }`, `"files": ["dist", "prompts", "personas", "README.md"]`(상주 코드가 런타임에 읽는 리소스를 grep으로 확인해 누락 방지 — prompts/·personas/ 로더 경로). private 필드가 있으면 pack을 위해 처리 방법 결정(private:true면 npm pack은 되지만 publish 불가 — 그대로 두고 보고서에 명시).
- [ ] **Step 2: npm pack 실검증** — `npm pack` → 타볼 크기·내용 확인(`tar -tf` 상위 항목) → 임시 폴더에서 `npm init -y; npm i <타볼 절대경로>` 후 `npx engram-mcp --port 1`이 기동하는지(의존성 해석 포함 실검증 — node_modules 통째 설치라 수 분 걸릴 수 있음, 타임아웃 여유).
- [ ] **Step 3: README** — "앱 없이 쓰기 (헤드리스 MCP)" 절: npx 등록 한 줄(`claude mcp add engram -- npx -y <패키지명-미정>` + 로컬 타볼 검증 안내), 승인 흐름("제안 → 채팅에서 '제안 보여줘/승인해'"), --write-mode, 데이터 위치(앱과 공유), 앱 실행 중이면 자동 브리지. 기존 MCP 절에 이어서, 한국어.
- [ ] **Step 4: 검증·커밋** — build+`npm test` 전체 PASS. `git commit -m "feat(headless): 패키징(bin·files·shebang)+README — npm pack 실검증, publish는 사용자 결정 대기"`

---

## Self-Review 결과

- 스펙 §3.1→Task 3, §3.2→Task 3(chooseMode·브리지 폴백), §3.3→Task 1, §3.4→Task 2, §3.5→Task 4, §3.6→도구 설명·opt-in 플래그(Task 1·2), §4 실스모크→SDD 최종(컨트롤러: 타볼 npx를 claude mcp add로 등록→propose→list→approve→위키 파일 확인→앱 켜고 브리지 폴백 확인).
- 시그니처 일관성: makeMcpProposals(1↔2↔3)·McpDeps.proposals/write(1↔2↔3)·makeWikiMcpDeps(3에서 신설, main.ts 리팩터 동작 무변경)·getMcpWriteMode(2). ws Set 공유는 self.adapter 내부라 가능(:364 this.approving).
- 리스크 명시: Nest 부팅 stdout 오염(logger:false+확인)·shebang 보존·AppModule 상주 훅의 헤드리스 유해성(구현자 확인 항목)·npm pack 의존성 해석(실검증 스텝).
