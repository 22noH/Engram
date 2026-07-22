# 앱 채팅 /clear · /compact + 자동 compact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱 채팅에 `/clear`(즉시 삭제+실행취소)와 `/compact`(요약→위키 저장→정리)를 넣고, 보존 프루닝 직전 자동 compact를 붙인다.

**Architecture:** chat-store에 백업기반 clear/undo + compact는 채널 브레인으로 요약→위키 게시(기존 ProposalStore+ProposalApplier 재사용, dedup append)→기록 정리 → ws 프레임(self.adapter) + 렌더러(팔레트 인터셉트·⋯메뉴·요약 메시지·실행취소 토스트) → 보존 프루닝 훅에서 자동 compact → 서버 콘솔·데스크톱 설정에 자동정리 토글.

**Tech Stack:** 기존 스택(NestJS/TS·React 렌더러·Electron settings.html·LanceDB 위키). 신규 dep 없음. 스펙: `docs/superpowers/specs/2026-07-22-clear-compact-design.md` · **확정 목업(픽셀 계약): `docs/superpowers/mockups/2026-07-21-clear-compact.html`**

## Global Constraints

- **위키/RAG 지식은 절대 삭제하지 않는다** — /clear·/compact·auto-compact 모두 채널 대화 jsonl만 건드린다(S4 안전선 계승). knowledge 폴더 무관.
- **continuity = RAG는 게시된 위키만 읽는다** → compact 요약은 승인 대기열이 아니라 **바로 게시**(자동/수동 공통). 명령/토글이 곧 동의(채팅 동의=사람 승인).
- **/clear는 되돌릴 수 있다** — 삭제는 파일을 백업으로 원자적 rename, 실행취소 창(~6초) 동안 복원. 창 종료/다음 clear/부팅 정리 시 백업 완전 삭제.
- chat-store 신규 메서드는 전부 **never-throw·원자적**(기존 pruneChannel 관례: tmp/backup rename, try/finally). 손상 줄 skip 유지.
- 보존 기본 무제한 → 프루닝 없음 → auto-compact 없음(회귀 0). autoCompact 기본 **true**지만 보존이 count/days일 때만 발동.
- 권한: 자기 채널 대화 정리 = 채팅 참여 권한 동급. 팀 공유 채널은 기존 `canAdminChannel` 게이트 준수.
- 프로토타입 오염 안전(hasOwnProperty). 설정 부분갱신 보존(saveChatBootConfig 관례). UI en 기본+ko(하드코딩 금지). 목록/메시지 행은 컨테이너 직계(구분선 회귀 방지). PowerShell·jest/vitest 포그라운드만. 커밋 Co-Authored-By 금지. 무관 더티 파일(아이콘·docs/pitch·test-output.txt·.claude·release·root package-lock·engram-mcp.ts·mcp-bridge.ts) 스테이징 금지.

---

### Task 1: chat-store clear/undo/백업 정리

**Files:**
- Modify: `src/edge/messenger/chat-store.ts`(+`chat-store.spec.ts`)

**Interfaces:**
- Consumes: 기존 `messagesPath(id)`, `safeId(id)`, `has(id)`, `history(id, opts)`, 원자적 rename 관례(pruneChannel).
- Produces:
  - `clearChannel(id: string): void` — jsonl을 `${messagesPath(id)}.cleared`로 원자적 rename. 기존 `.cleared` 백업이 있으면 먼저 삭제(백업 1개만 유지). jsonl 없으면 no-op. never-throw.
  - `undoClear(id: string): boolean` — `.cleared` 백업을 jsonl로 되돌림(원자적 rename). 백업 없으면 false. 현재 jsonl이 있으면(다시 대화가 쌓였으면) 덮어쓰지 말고 false. never-throw.
  - `dropClearBackup(id: string): void` — `.cleared` 백업 삭제(존재하면만). never-throw.
  - 부팅 정리: 생성자에서 chatDir의 잔여 `.cleared` 파일 제거(이전 세션 토스트 미확정분) — 선택(간단하면 포함, 아니면 보고).
- 위키/RAG 무관.

- [ ] **Step 1: TDD** — clearChannel: 3줄 채널 clear→jsonl 없음·`.cleared` 존재·history()=[]. undoClear: clear 후 undo→history 원복·`.cleared` 없음. undo(백업없음)=false. clear 두 번: 첫 백업이 지워지고 두 번째 것만 남음(백업 1개). dropClearBackup: 백업 제거 후 undo=false. clear 후 새 append→jsonl 생김→undo=false(덮어쓰기 방지). 손상/없는 채널 무해. safeId 아닌 id 무해.
- [ ] **Step 2: 검증·커밋** — `npx jest --testPathPattern="chat-store"` PASS·full `npm test`·build clean. `git commit -m "feat(clear-compact): chat-store clearChannel/undoClear/dropClearBackup(백업 rename·되돌리기·위키무관)"`

---

### Task 2: compact 코어 — 요약→위키 게시→정리

**Files:**
- Create: `src/agent-layer/compact.ts`(요약 프롬프트 빌더 + CompactService), `prompts/compact-summary.md`(기본 프롬프트), `src/agent-layer/compact.spec.ts`
- Reference(수정 안 함, 시그니처만): `src/knowledge-core/proposal-store.ts`(enqueue), `src/edge/proposal-applier.ts`(apply), `src/edge/mcp/mcp-propose.ts`(dedup 규칙), `src/brain/brain.port.ts`(complete), `src/agent-layer/prompt-store.ts`(loadPrompt)

**Interfaces:**
- Consumes:
  - `BrainProvider.complete(prompt: string): Promise<{ text: string; isError: boolean }>` (`brain.port.ts:28`).
  - `ChatStore.history(id, { limit })` (대화 읽기), `ChatStore.clearChannel(id)`·`appendMessage(id, {authorId, authorName, text})`(Task 1 + 기존).
  - `proposals.enqueue(NewProposal): Promise<Proposal>` + `applier.apply(Proposal): Promise<void>` — MCP wiki_propose+approve와 동일 경로(dedup: 기존 slug 있으면 op='append', 없으면 'create'). `wiki.getPage(slug)`로 존재 확인.
  - `loadPrompt('compact-summary', DEFAULT)` + `buildCompactSummaryPrompt(instruction, { transcript })`.
- Produces:
  - `buildCompactSummaryPrompt(instruction: string, ctx: { transcript: string }): string`.
  - `class CompactService { async compact(channelId: string, opts: { brain: BrainProvider; auto?: boolean }): Promise<{ summary: string; slug: string } | null> }`
    - 순서: history 읽기(비었으면 null) → brain.complete(요약 프롬프트) → 요약 텍스트 확보(isError면 null·정리 안 함) → 위키 저장(enqueue+apply, category=`auto`면 'auto-compact' 아니면 'compact-summary', dedup slug) → `clearChannel` → 요약을 채널에 append(작성자=Engram, text=요약 본문+"📄 위키: [slug]") → `{summary, slug}` 반환.
    - **요약 메시지는 clear 이후 append**(백업/undo 대상 아님·새 앵커). auto=true면 사후 검토용 category 태그.
    - never-throw 래핑: 위키 저장/정리 실패는 로그+부분성공 보고(단 요약 실패면 정리 안 함 — 지식 유실 방지).

- [ ] **Step 1: 프롬프트** — `prompts/compact-summary.md` 작성(대화 transcript를 위키 페이지용 간결 요약으로 — 제목 + 핵심 불릿, 위키 지식화 톤). `DEFAULT` 상수도 코드에 동봉.
- [ ] **Step 2: TDD** — mock brain(고정 요약 반환)·mock proposals/applier/wiki·실제 ChatStore(tmp dir). compact: 3줄 채널→enqueue 호출됨(op=create, category 'compact-summary', payload=요약)·apply 호출·clearChannel 후 요약 메시지 1줄만 history에 남음·반환 {summary,slug}. 기존 slug 있으면 op='append'(dedup). auto=true면 category 'auto-compact'. brain.isError면 null·정리 안 함(history 그대로). 빈 채널=null. **위키 저장 payload에 대화 원문이 아니라 요약만**(원문 유출 아님) 확인.
- [ ] **Step 3: 검증·커밋** — `npx jest --testPathPattern="compact"` PASS·full `npm test`·build clean. `git commit -m "feat(clear-compact): compact 코어(브레인 요약→위키 게시[dedup]→기록 정리)+compact-summary 프롬프트"`

---

### Task 3: ws 프레임 — clearHistory/undoClear/compact

**Files:**
- Modify: `src/edge/messenger/self.adapter.ts`(+spec), `shared/protocol.ts`(ClientFrame 타입에 신규 프레임)
- Reference: `self.adapter.ts:352`(switch), `:406`(setChannelBrain 패턴), `:461`(wikiDelete 패턴), `broadcastChannels()`·`broadcastToChannel()`

**Interfaces:**
- Consumes: `this.store`(ChatStore, Task 1 메서드), `canAdminChannel(ws, ch)`, `broadcastToChannel(channelId, frame)`/`broadcastChannels()`, Task 2 `CompactService`(self.adapter에 주입 — DI 확인, 없으면 옵셔널 dep), `ChannelBrainResolver`(채널 브레인 해소 — 기존).
- Produces(신규 ws 케이스, setChannelBrain 결 그대로):
  - `case 'clearHistory'`: `f.id:string` 검증·`canAdminChannel`→`store.clearChannel(f.id)`→`broadcastToChannel(f.id, { t:'historyCleared', channelId, undoable:true })`(클라가 transcript 비우고 토스트).
  - `case 'undoClear'`: →`store.undoClear(f.id)` 성공 시 `broadcastToChannel(f.id, { t:'historyRestored', channelId })`(클라 재로드).
  - `case 'dropClearBackup'`: →`store.dropClearBackup(f.id)`(응답 불필요, 토스트 만료 통지).
  - `case 'compact'`: `canAdminChannel`→채널 브레인 해소→`compactService.compact(f.id, {brain})`→성공 시 `broadcastToChannel(f.id, { t:'compacted', channelId, slug })`(클라 재로드→요약 메시지 표시). compactService 미주입(brain 모드 등)이면 무시.
  - ClientFrame 유니온에 `{t:'clearHistory',id}` `{t:'undoClear',id}` `{t:'dropClearBackup',id}` `{t:'compact',id}` 추가. 서버→클라 `historyCleared`/`historyRestored`/`compacted` 프레임 타입.
- 권한: 전부 `canAdminChannel` 게이트(비공개/팀 채널 감시 방지 기존 관례).

- [ ] **Step 1: TDD** — mock ws + 실 ChatStore + mock CompactService. clearHistory: 권한 있는 소켓→clearChannel 호출·historyCleared 브로드캐스트. 권한 없으면 무동작. undoClear→undoClear 호출·historyRestored. compact→compactService.compact 호출·compacted{slug} 브로드캐스트. compactService 미주입이면 compact 무시(무크래시). 잘못된 f.id 타입 무해.
- [ ] **Step 2: 검증·커밋** — `npx jest --testPathPattern="self.adapter"` PASS·full `npm test`·build clean. `git commit -m "feat(clear-compact): ws clearHistory/undoClear/compact 프레임(owner 게이트·채널 브로드캐스트)"`

---

### Task 4: 렌더러 — 팔레트·⋯메뉴·요약 메시지·실행취소 토스트

**Files:**
- Modify: `renderer/src/components/Palette.tsx`(COMMANDS 2개), `renderer/src/App.tsx`(pickCmd 인터셉트·ws 프레임 수신·토스트·요약 메시지), `renderer/src/components/Channels.tsx`(⋯메뉴 2버튼), `renderer/src/i18n.ts`, `renderer/src/theme.css`(토스트), `shared/protocol.ts`(클라 프레임 타입 재사용). 관련 spec.
- Reference: `App.tsx:327`(sendText)·`:357`(pickCmd, MANAGE_ENGRAMS_INSERT 특수분기)·`:564`(Enter 픽), `connections-client.ts:101`(send), `Channels.tsx:98`(popmenu), `Palette.tsx:10`(COMMANDS)

**Interfaces:**
- Consumes: `send(connId, frame)`, `pickCmd` 특수분기 패턴, ws 수신 프레임(`historyCleared`/`historyRestored`/`compacted` — 기존 프레임 수신 핸들러에 케이스 추가), `mergedMsgs` 재조회.
- Produces:
  - Palette COMMANDS에 `{insert:'clear', label:'/clear', desc:...}`·`{insert:'compact', label:'/compact', desc:...}`(로케일). `CLEAR_INSERT`/`COMPACT_INSERT` 센티넬(MANAGE_ENGRAMS_INSERT처럼).
  - `pickCmd`: insert가 clear/compact면 입력창 채우지 말고 `send(defaultConnId, {t:'clearHistory'|'compact', id: currentChannelId})`. clear는 즉시(확인 없음)·compact는 그대로 전송(요약은 서버가 메시지로 push).
  - ⋯메뉴(Channels.tsx popmenu)에 "🧹 요약해서 정리"(compact)·"🗑 대화 기록 삭제"(clear, danger) 2항목(구분선). 슬래시와 동일 콜백.
  - `historyCleared` 수신: 그 채널 transcript 비우고 **실행취소 토스트**(~6초). 클릭→`send({t:'undoClear',id})`. 만료/다음 clear→`send({t:'dropClearBackup',id})`. `historyRestored`/`compacted` 수신→해당 채널 메시지 재로드.
  - `compacted` 후: 서버가 이미 요약 메시지를 append했으므로 재로드 시 요약 메시지가 앵커로 보임(추가 렌더 특수처리 불필요, 일반 메시지로 표시 — 목업 ④는 작성자 라벨만 "요약해서 정리했어요").
  - theme.css 토스트 스타일(목업 ③: 하단중앙 오버레이·실행취소 강조). i18n en/ko.

- [ ] **Step 1: 목업 ①②③④ 렌더러 이식**(픽셀). 목업에 없는 요소 추가 금지(불가피=보고).
- [ ] **Step 2: TDD(vitest)** — 팔레트에 /clear·/compact 노출·필터. pickCmd(clear)→send clearHistory(입력창 안 채움). pickCmd(compact)→send compact. ⋯메뉴 2버튼 클릭→동일 send. historyCleared 수신→토스트 표시+실행취소 클릭 send undoClear. 토스트 만료→dropClearBackup. compacted 수신→재로드. 목록/토스트 접근성.
- [ ] **Step 3: 검증·커밋** — `npm --prefix renderer test -- --run` PASS·`npm run renderer:build` clean·백엔드 `npm test` 회귀. `git commit -m "feat(clear-compact): 렌더러 팔레트·⋯메뉴 /clear·/compact+요약 메시지+실행취소 토스트(목업 픽셀)"`

---

### Task 5: 자동 compact — 보존 프루닝 직전 요약

**Files:**
- Modify: `src/edge/messenger/chat-store.ts`(프루닝 훅), `src/edge/messenger/chat.config.ts`(autoCompact 필드), `src/main.ts`(배선), 관련 spec
- Reference: `chat-store.ts:197`(appendMessage→pruneChannel), `chat.config.ts:10`(ChatConfig)·`:64`(saveChatBootConfig)·`main.ts:114`(new ChatStore)

**Interfaces:**
- Consumes: Task 2 `CompactService`, 기존 `pruneChannel`(자를 줄 판정), `RetentionPolicy`.
- Produces:
  - `ChatConfig.autoCompact?: boolean`(기본 true) + `loadChatConfig` 읽기 + `saveChatBootConfig` patch에 `autoCompact` 추가(retention과 동일 부분갱신).
  - ChatStore에 자동 compact 훅: 프루닝이 실제로 줄을 **버릴 때**(unlimited/변경없음이면 skip), autoCompact 켜졌으면 버려질 구간을 CompactService로 요약→위키 게시 **후** 프루닝. 콜백/의존 주입(ChatStore가 CompactService를 직접 알면 순환 위험 → main에서 `chatStore.setAutoCompactHook(async(id, brain)=>compactService.compact(id,{brain,auto:true}))` 식 훅 주입, 미주입이면 기존 프루닝). 브레인 해소는 채널 브레인 or 기본.
  - 디바운스: 같은 채널 짧은 시간 다발 append/prune은 요약 1회로 묶음(과다 AI 호출 방지). never-throw(요약 실패해도 append는 성공 — 단 실패 시 프루닝 스킵 여부는 안전 우선: 요약 실패면 이번 프루닝 건너뛰어 지식 유실 방지, 다음 기회에 재시도).
  - `main.ts`: `chatCfg.autoCompact`를 훅 주입 조건으로 사용.

- [ ] **Step 1: TDD** — mock CompactService. autoCompact=true+count=2 정책: 3개 append→프루닝 전 compact 호출(auto=true)·요약 게시 후 2줄. autoCompact=false: compact 미호출·기존 프루닝. unlimited: compact·프루닝 둘 다 없음. 요약 실패(mock reject): 프루닝 스킵(3줄 유지)·다음 성공 시 정리. chat.config 왕복(autoCompact 저장/로드·기본 true). **위키 페이지만 늘고 대화 jsonl만 줄어듦**(지식 무관) 검증.
- [ ] **Step 2: 검증·커밋** — `npx jest --testPathPattern="chat-store|chat.config"` PASS·full `npm test`·build clean. `git commit -m "feat(clear-compact): 자동 compact(보존 프루닝 직전 요약→위키 게시)+chat.config autoCompact(기본 true)"`

---

### Task 6: 서버 콘솔 — 자동정리 토글

**Files:**
- Modify: `src/edge/admin/admin-http.ts`(server-settings GET/POST에 autoCompact)+spec, `console/src/views/ServerSettings.tsx`(토글)+test, `console/src/api.ts`·`console/src/i18n.ts`
- Reference: `admin-http.ts:797`(GET retention)·`:853`(POST retention 검증)·`:874`(saveChatBootConfig)·`:879`(runtime apply), `ServerSettings.tsx:44`(retentionTouched 패턴)

**Interfaces:**
- Consumes: `saveChatBootConfig({autoCompact})`(Task 5), retentionTouched 게이트 패턴.
- Produces:
  - GET server-settings 응답에 `autoCompact: chatCfg.autoCompact ?? true` 추가.
  - POST: `body.autoCompact`가 boolean이면 saveChatBootConfig에 전달(touched 게이트: 안 보내면 미변경). 런타임 반영 필요하면 훅 재주입(재시작 적용도 허용 — 보고).
  - ServerSettings.tsx: 대화 보존 select 아래 자동정리 토글(체크박스, `autoCompactTouched` 게이트, 목업 ⑤ 픽셀·"기본 켜짐" 힌트). i18n en/ko.

- [ ] **Step 1: TDD** — admin: GET autoCompact 노출(기본 true)·POST 저장·비boolean 무시·owner 게이트. 콘솔(vitest): 토글 렌더·미변경 저장은 autoCompact 미전송(retention 회귀 테스트 패턴)·변경 시 전송.
- [ ] **Step 2: 검증·커밋** — `npx jest --testPathPattern="admin-http"`·`npm --prefix console test -- --run` PASS·`npm run console:build`·백엔드 `npm test`. `git commit -m "feat(clear-compact): 서버 콘솔 자동정리 토글(server-settings autoCompact·touched 게이트)"`

---

### Task 7: 데스크톱 개인앱 설정 — 보존 + 자동정리

**Files:**
- Modify: `src/desktop/settings.html`(대화 섹션), `src/desktop/preload.ts`(IPC), `src/desktop/main.ts`(IPC 핸들러·config 저장/조회), 관련 spec
- Reference: `settings.html`(section 패턴 `<section id="sec-X">`·`data-t` i18n·nav-items), `chat.config.ts`(loadChatConfig/saveChatBootConfig — Task 5 autoCompact 포함), preload의 기존 config IPC 채널

**Interfaces:**
- Consumes: `loadChatConfig(configDir)`·`saveChatBootConfig(configDir, {retention, autoCompact})`(Task 5), settings.html 기존 IPC 관례(preload `window.engram.*`).
- Produces:
  - settings.html에 "대화" 섹션(nav-item + `<section id="sec-chat">`): 대화 보존 select(채널당 최근 N개/최근 N일/무제한 — 콘솔과 동일 3프리셋)+자동정리 토글(기본 켜짐)+"위키 지식은 유지" 힌트. 목업 ⑤ 픽셀.
  - preload/main IPC: 현재 retention·autoCompact 조회 + 저장(saveChatBootConfig). 저장 시 런타임 반영 or 재시작 안내(기존 서버설정 재시작 관례).
  - i18n(settings.html data-t 사전에 키 추가, en/ko).
- 개인앱은 로그인 없음 — 이 설정은 로컬 config 직접 편집(admin api 아님).

- [ ] **Step 1: 목업 ⑤ 설정 카드를 settings.html 대화 섹션으로 이식**(픽셀). 없는 요소 추가 금지.
- [ ] **Step 2: TDD** — main IPC 핸들러 단위테스트(조회=현재 config·저장=saveChatBootConfig 호출·기본 무제한/autoCompact true). settings.html은 렌더 스모크(섹션 존재·토글 존재)면 충분(순수 HTML+preload라 heavy 테스트 불필요, 보고).
- [ ] **Step 3: 검증·커밋** — 관련 jest PASS·full `npm test`·build clean. `git commit -m "feat(clear-compact): 데스크톱 개인앱 설정에 대화 보존+자동정리(로컬 config)"`

---

### Task 8: 실스모크

**Files:**
- Create: `scripts/smoke-clear-compact.ts`

**Interfaces:** Task 1~7. 실서버(서버 모드) 부팅→owner→토큰·ws.

- [ ] **Step 1: 실스모크** — ①/clear: 채널에 메시지 3개(ws)→clearHistory→history 빈 것·`.cleared` 백업 존재→undoClear→3개 원복→다시 clearHistory→dropClearBackup→undo 불가. ②/compact: 메시지 몇 개→compact→**위키에 요약 페이지 실제 생성**(wiki_read로 확인·요약만 담김)·채널은 요약 메시지 1줄·**다른 위키 페이지 수 불변**(지식 무관 실증). ③auto-compact: autoCompact=true+count=2→3개 append→위키에 auto-compact 페이지 생성+채널 2줄·**기존 위키 불변**. autoCompact=false→위키 안 생기고 그냥 프루닝. ④게이트: 비권한 소켓 clear/compact 무동작.
- [ ] **Step 2: 실행·커밋** — 2회 연속 PASS. `git commit -m "test(clear-compact): 실스모크(/clear+undo·/compact 위키 저장·위키 불변·auto-compact·게이트)"`

---

## Self-Review 결과

- 스펙 커버: /clear(T1 백업+T3 ws+T4 UI+토스트)·/compact(T2 코어+T3 ws+T4 UI)·auto-compact(T5)·설정(T6 콘솔·T7 데스크톱)·스모크(T8). 전 항목 태스크 매핑됨.
- 시그니처 일관: clearChannel/undoClear/dropClearBackup(T1)→ws(T3)→렌더러(T4)·CompactService.compact(T2)→ws(T3)+auto훅(T5)·autoCompact(T5)→콘솔(T6)·데스크톱(T7). 이름 일치 확인.
- 안전선: 모든 삭제는 대화 jsonl만·위키 게시는 요약만(원문 아님)·T2/T5/T8에서 위키 불변 명시 검증·/clear 되돌리기·기본 무제한 회귀0.
- 불확실 지점(구현 중 확정): CompactService의 self.adapter/ChatStore 주입 배선(DI 순환 회피=main 훅 주입)·auto-compact 디바운스 상세·데스크톱 설정 런타임 반영 vs 재시작·요약 실패 시 프루닝 스킵 정책. 각 태스크 보고서에 결정 기록.
- 순서: 1(clear)→2(compact 코어)→3(ws)→4(렌더러)→5(auto)→6(콘솔)→7(데스크톱)→8(스모크). 의존 체인 준수.
