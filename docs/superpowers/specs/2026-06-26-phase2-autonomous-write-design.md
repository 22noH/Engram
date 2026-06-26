# Phase 2 — C 자율쓰기 설계 (수집 경로 B)

> 최종 갱신: 2026-06-26 · 상태: brainstorming 완료, 스펙 확정
> 기준선: `docs/DESIGN.md` §5.1·§5.3·§6·§7.4·§13. 선행: Phase 0(KnowledgeCore)·Phase 1(A 읽기) 완료.

---

## 1. 목표

대화에서 자율로 사실을 길어 올려 **검증 다층 파이프라인 + 사람 승인 게이트**를 거쳐 위키를 갱신한다.
stateful 위키의 최대 위험("틀린 사실이 진실원을 오염")을 §6 파이프라인으로 막는 것이 이 페이즈의 본질.

**이 페이즈에 넣는 것 (§6 "필수, 첫 쓰기 전"):**
diff 제안 · 출처 필수 · 중요도 게이트 · 근거 검증 · 모순 검사 · 별도 judge · 사람 승인 · git 이력·rollback.

**의도적으로 빼는 것 (§6 "나중"):**
다중투표 judge · 신뢰도별 자동반영 티어 · 주기 감사(⑧) · golden-question 회귀 테스트.
→ Phase 2는 **전부 사람 승인 경유**(자동반영 티어 없음). 신뢰가 쌓인 뒤 후속 페이즈에서 연다.

---

## 2. 확정 결정 (brainstorming)

| 결정 | 선택 | 비고 |
|---|---|---|
| 수집 경로 | **(B) 대화 로그 다이제스트** | 원안 충실. @Cron이 주기적으로 새 대화를 소화 |
| 스테이징 | **위키 밖 결재 대기함(ProposalStore)** | §5.1 draft-플래그 재해석. 승인 전 라이브 위키 무손상. 신규/수정/모순을 한 메커니즘으로 통일 |
| judge 두뇌 | **별도 judge 프로필** | brains.json multi-profile을 Phase 2에서 처음 가동. 작성자≠검증자 |
| 파이프라인 콜 수 | **2콜: writer + judge** | §6의 5개 논리 검사는 전부 유지, 두뇌 호출만 묶음. claude -p 프로세스 부팅 배치당 2회 |
| 승인 UX | **CLI `engram review`** | pending 목록 → diff+출처+판정 → 승인/거부 |
| 트리거 | **`engram digest` 수동 + @Cron 자동** | 둘 다 `orchestrator.digest()` 경유("모든 흐름 Orchestrator") |

---

## 3. 흐름

```
(대화) engram ask/REPL
  → Orchestrator.route() 턴 완료 후 ConversationStore에 append   [B의 소스 적재]

(스케줄 @Cron 또는 engram digest)
  → Orchestrator.digest()  →  IngesterAgent.run()
     ① 워터마크 이후 새 대화 배치 로드 (ConversationStore.since)
     ② writer 콜(default 두뇌): 후보 사실 추출 + 중요도 1~5 + 출처 인용   (§6 ①②③ 동봉)
     ③ ImportanceGate: importance < 3 폐기                              (§5.3, 순수 필터)
     ④ RagStore retrieval: 살아남은 사실마다 관련 기존 페이지 검색        (§6 ④, 기계적)
     ⑤ judge 콜(judge 프로필): 모순 비교 + 판정                          (§6 ⑤, 작성자≠검증자)
          verdict ∈ { create | append | conflict | reject }
     ⑥ reject 외 전부 ProposalStore에 enqueue (status: pending)         [자동반영 없음]
     ⑦ 워터마크 전진

(사람) engram review
  → pending 목록 → 각 제안의 diff + 출처 + judge 판정 표시
  → 승인: WikiEngine이 op 수행(create/append/supersede). 출처는 frontmatter sources로 페이지에 박힘.
          judge 판정은 approved ProposalStore 레코드로 보존(감사 흔적). git 이력은 기존 자동 커밋.
          → WikiWatcher가 RAG 증분 재색인 (자동, 기존 인프라)
  → 거부: 제안 status=rejected, 위키 무변경
  → rollback: git revert (WikiGit, 기존 이력)
```

**대원칙(§6) 매핑:**
통째 교체❌ → 제안은 항상 diff(append/supersede) · 출처 없으면 writer/judge 단계에서 거부 ·
작성자(writer 콜)≠검증자(judge 콜) · 모순은 덮어쓰기 금지 → `op: supersede`(기존을 superseded로 플래그, 이력 보존).

---

## 4. 컴포넌트

### 4.1 ConversationStore (`src/knowledge-core/conversation-store.ts`) — 신규
- append-only JSONL: `runtime/state/conversations/{userId}/YYYY-MM-DD.jsonl`
- 레코드: `{ ts: ISO, question: string, answer: string, sources: string[] }`
- API:
  - `append(userId, record)` — 한 턴 적재. 디렉토리 없으면 생성.
  - `since(userId, cursorTs)` — `ts > cursorTs`인 레코드 배열(시간순). 날짜 파일 여러 개 가로질러 읽음.
- 워터마크: `runtime/state/ingest-cursor.json` = `{ [userId]: lastTs }`. IngesterAgent가 읽고 전진.
- **호출처:** Orchestrator.route()가 턴(스트리밍 답변 완료) 후 `append`. 답변은 onChunk로 모은 전체 텍스트.

### 4.2 ImportanceGate (`src/knowledge-core/importance-gate.ts`) — 신규
- §5.3. Mem0식 1~5 채점은 **writer 추출에 동봉**(브레인이 사실마다 점수 부여). 게이트는 **임계치 필터**.
- API: `filter(facts, threshold = 3)` → `importance >= threshold`만 통과.
- 임계치 config: `ENGRAM_IMPORTANCE_THRESHOLD`(기본 3), 비숫자/범위밖이면 폴백(brain.config의 posIntEnv 패턴 재사용).

### 4.3 ProposalStore (`src/knowledge-core/proposal-store.ts`) — 신규
- `runtime/state/proposals/{id}.json` (id = 시간+슬러그 등 충돌없는 키; Date.now 금지 환경 아님 — 런타임이라 OK)
- 레코드:
  ```ts
  {
    id: string; userId: string; createdTs: string;
    op: 'create' | 'append' | 'supersede';
    targetSlug: string;            // create=새 슬러그, append/supersede=기존 슬러그
    payload: string;               // 추가/대체할 본문(diff 단위)
    sources: string[];             // 출처(대화 ts/인용)
    importance: number;
    verdict: { confidence: number; reason: string; conflictSlugs?: string[] };
    status: 'pending' | 'approved' | 'rejected';
  }
  ```
- API: `enqueue(p)`, `listPending(userId?)`, `get(id)`, `markApproved(id)`, `markRejected(id)`.

### 4.4 IngesterAgent (`src/agent-layer/ingester-agent.ts`) — 신규
- 배치 다이제스트 본체. stateless(매 run 독립). try/catch 에러 경계(한 배치 실패가 프로세스를 안 죽임 — §10.3).
- `run(userId)`: §3 ②~⑦. 의존: ConversationStore, ImportanceGate, RagStore, BrainProvider(writer+judge 해소), ProposalStore.
- **writer 프롬프트 계약:** 대화 배치 → JSON `[{ claim, importance, sourceQuote }]`. 출처 인용 없으면 그 사실 폐기.
- **judge 프롬프트 계약:** `{ fact, retrievedPages }` → JSON `{ verdict, targetSlug?, confidence, reason, conflictSlugs? }`.
- **JSON 파싱 방어:** 브레인 출력에서 JSON 블록 추출(코드펜스/잡텍스트 허용), 파싱 실패 시 그 항목 스킵 + pino 경고. (브레인은 텍스트를 반환 — 구조화는 프롬프트+파싱으로.)

### 4.5 brain multi-profile (`src/brain/brain.config.ts`·`brain.module.ts`) — 변경
- `loadActiveBrain` 외에 **named 프로필 해소** 추가: `loadBrainProfile(configDir, name, env)` → 지정 프로필(없으면 throw). env 덮어쓰기는 활성 프로필에만(judge는 파일 값 사용; 필요 시 후속 확장).
- brains.json 기본 파일에 `judge` 프로필 추가(기본은 default와 동일 claude-cli, 사용자가 모델 바꿔 분리 가능).
- BrainModule: writer(=default)와 judge 두 BrainProvider 인스턴스를 토큰으로 구분 제공(예: `BRAIN`(=default/writer) + `JUDGE_BRAIN`). 세마포어는 프로필별 concurrency로 각각.

### 4.6 Orchestrator.digest() (`src/agent-layer/orchestrator.ts`) — 변경
- `route()`와 대칭 seam. `digest(userId)` = `ingester.run(userId)` 위임(스텁 한 줄, "모든 흐름 경유" 불변 유지).

### 4.7 승인 게이트 / CLI (`src/edge/cli.gateway.ts`) — 변경
- `engram digest` → `orchestrator.digest(DEFAULT_USER)`. 결과 요약(제안 N건 생성) stdout.
- `engram review` → ProposalStore.listPending → 각 항목 diff+출처+판정 출력 → 한 건씩 `[a]pprove/[r]eject/[s]kip` 프롬프트(REPL 패턴 재사용) → 승인 시 WikiEngine apply.
- 승인 적용기: `op`별 WikiEngine 호출 매핑(실제 API: `createPage`/`updatePage`/`getPage`).
  - `create` → `createPage({ ...payload, sources, status: 'published' })` (승인 = 즉시 공개)
  - `append` → `getPage` 후 `updatePage(slug, { body: 기존본문 + payload, sources: 병합 })`
  - `supersede` → `getPage` 후 `updatePage`로 충돌 구절을 superseded 표시(이력 보존, 덮어쓰기 금지) + payload 반영
- 출처: createPage/updatePage가 받는 `sources` frontmatter로 페이지에 영속. judge 판정: approved 레코드 보존.
- KeyedLock·WikiGit 자동 커밋·워처 재색인은 WikiEngine 내장(기존). 커밋 메시지 커스터마이즈(출처/판정 문구)는
  필요 시 WikiEngine에 옵션 message 인자 추가 — 작은 변경, 비범위(§8).

### 4.8 Scheduler (`src/edge/` 또는 `src/app.module`) — 신규 배선
- `@nestjs/schedule` ScheduleModule + `@Cron` 잡 → `orchestrator.digest()`. 주기 config(`ENGRAM_DIGEST_CRON`, 기본 예: 매일 03:00).
- main.ts(상주)에서만 스케줄러 활성; cli.ts(원샷)에선 비활성(질문 한 번 하고 끝나는 경로에 크론 불필요).
- 신규 dep: `@nestjs/schedule`.

---

## 5. RAG 재색인 묶음 (§13 "위키↔RAG 재색인 묶음")

대부분 **기존 WikiWatcher로 무료**: 승인 적용이 위키 파일을 쓰면 워처가 증분 재색인 → stale 읽기 방지(§5.2·§11).
승인 적용과 같은 트랜잭션 경계 보장이 필요하면(파일 쓰기→재색인 사이 race) 기존 KeyedLock으로 충분. 추가 동기 재색인 호출은 워처가 못 따라잡는 게 측정되면 그때(ponytail 천장 주석).

---

## 6. 테스트 전략

- **ConversationStore**: append→since 라운드트립, 날짜 파일 경계 가로지르기, 빈/없음.
- **ImportanceGate**: 경계값(2/3), 임계치 env 폴백.
- **ProposalStore**: enqueue→listPending→markApproved 상태전이, pending 필터.
- **IngesterAgent**: FakeBrain(writer/judge 주입)으로 파이프라인 전체 — 추출 0건/저중요도 폐기/모순→supersede/근거없음 폐기/JSON 파싱실패 스킵. 결정적.
- **brain multi-profile**: named 프로필 해소, 없으면 throw, judge≠default.
- **승인 적용기**: op별 WikiEngine 호출(create/append/supersede), 거부 시 무변경, 출처·판정 커밋 메시지.
- **통합 스모크(opt-in)**: 실 claude -p로 1회 digest→review→apply 1바퀴(Phase 1 스모크 패턴).

---

## 7. 작업 분해 (TDD 태스크, 대략)

1. ConversationStore (append/since + 워터마크)
2. Orchestrator.route() 턴 로깅 배선
3. ImportanceGate (필터 + 임계치 env)
4. ProposalStore (큐 CRUD + 상태전이)
5. brain multi-profile 해소 + brains.json judge 프로필 + BrainModule judge 제공
6. IngesterAgent — writer 추출 + JSON 파싱 방어
7. IngesterAgent — RAG retrieval + judge + verdict 분기 → ProposalStore enqueue
8. Orchestrator.digest() seam + `engram digest` CLI
9. 승인 게이트 `engram review` + op별 WikiEngine 적용기 + 출처·판정 커밋
10. Scheduler(@nestjs/schedule) @Cron 배선(main.ts 한정)
11. 통합 스모크(opt-in) + 최종 전체-브랜치 리뷰(opus)

모델 배정: 기계적(Store/Gate)=haiku · 통합/외부API(Ingester/brain/CLI)=sonnet · 최종 전체리뷰=opus.

---

## 8. 비범위 / 후속

- 자동반영 티어, 다중투표 judge, 주기 감사(⑧), golden-question — 후속 페이즈.
- judge 프로필 env 덮어쓰기·페르소나별 두뇌 라우팅 — Phase 3(B 협업)에서 multi-profile 본격화.
- ImportanceGate를 별도 채점 콜로 분리(현재 writer 동봉) — 채점 품질이 문제되면.
- ConversationStore 회전/압축(개인 규모 OK; 코퍼스 커지면).
