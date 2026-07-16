# Engram — 설계 문서

> **프로젝트명: `Engram`** — 뇌에 저장된 기억의 물리적 흔적(engram). stateful 위키(기억 코어)를 은유.
>
> 최종 갱신: 2026-06-26 · 상태: **Phase 0·1·2 완료 (KnowledgeCore + A 읽기 + C 자율쓰기) — Phase 3 (B 협업) 착수 예정**

이 문서는 Engram의 단일 설계 기준선이다. (✦ = 브레인스토밍에서 새로 정하거나 다듬은 것)

---

## 1. 개요

개인용 **stateful LLM 위키(지식 코어)** 를 중심에 두고, 에이전트 무리가 그것을 **읽고(A)·공유 협업하고(B)·자율 갱신(C)** 하는 24/7 셀프호스팅 멀티에이전트 시스템. 윈도우 네이티브 우선.

- **A — 읽기**: 위키/RAG를 검색해 질의에 답하는 에이전트.
- **B — 협업**: 여러 페르소나 에이전트(별자리 테마)가 같은 위키를 공유하며 협업. (8팀 + Board Meeting)
- **C — 자율 갱신**: 수집 에이전트가 대화/소스를 다이제스트해 위키를 자율 갱신. (검증 파이프라인 + 승인 게이트 경유)

**핵심 통찰**: A·B·C는 별도 시스템이 아니라 같은 지식 코어의 입출력일 뿐이다. → 코어를 **단일 진실원(single source of truth)** 으로 두고, 에이전트는 **stateless 워커**로 분리한다.

참고 레퍼런스: `ramsbaby/jarvis` (셀프호스팅 멀티에이전트 어시스턴트 구조 참고).

---

## 2. 아키텍처 (4 레이어)

```
KnowledgeCore (공유 substrate — 단일 진실원)
 ├ WikiEngine      .md 페이지 CRUD + 카테고리 스키마   ✦버전관리형(출처 + git이력 + draft상태)
 ├ RagStore        벡터 + BM25 하이브리드 검색          ✦LanceDB + 로컬 임베딩(다국어)
 ├ ImportanceGate  Mem0식 1~5점 채점, 3점↑만 저장
 └ InsightLayer    행동/패턴 메트릭 (✦확정 포함, 후순위)

AgentLayer (코어를 소비/생산)
 ├ Orchestrator      질의 라우팅·분해·종합 (허브). 에이전트 직접 호출 금지, 모든 흐름 경유
 ├ ReaderAgent       A: 읽고 답함
 ├ SpecialistAgents  B: 페르소나(.md) 무리, Wiki 공유로 협업 (8팀 + Board Meeting)
 ├ IngesterAgent     C: 스케줄로 자율 수집 → ✦검증 파이프라인 → 게이트 → Wiki 갱신
 ├ BrainProvider     ✦교체 가능한 두뇌 포트. Claude CLI 기본 / API·Codex·Gemini·로컬LLM 어댑터
 └ IEmbedder         ✦교체 가능한 임베더 포트. 로컬 JS 기본 / Ollama·API 어댑터

Edge
 ├ Gateway    ✦포트 + 어댑터, 코어 앞단 중립. (CLI 초기 → Discord → 자체 front-end)
 └ Scheduler  in-process @Cron / BullMQ. OS cron 사용 금지

PAL (Platform Abstraction Layer — 얇게)
 └ ProcessSupervisor  항상 켜짐. ✦OS 서비스관리자(재시작) + 크로스플랫폼 감시자(멈춤감지·알림)
       Windows = Windows Service(node-windows/NSSM) · macOS = launchd · Linux = systemd. Docker는 선택.
```

---

## 3. 핵심 설계 원칙 (불변)

- **코어 = 단일 진실원, 에이전트 = stateless 워커.** B(공유)·C(쓰기)·A(읽기)가 같은 저장소에서 충돌 없이 돈다.
- **B의 협업은 자유 채팅이 아니다.** Wiki + Orchestrator 경유의 구조화된 흐름. (자유 에이전트 채팅 = 루프·비용 폭발로 금지)
- **C의 자율 쓰기는 승인 게이트 필수.** 초안 → 검증 → 승인 → 반영. (윈도우는 OS 샌드박싱이 없어 더 엄격히)
- ✦**이유 있을 때만 프로세스를 쪼갠다.** 외부 도구 실행(`claude -p`)과 외부 감시자만 분리. 기능별로 상주 프로세스를 쪼개지 않는다.
- **셸 스크립트 0개.** 자율·감사·재색인 전부 TS Service. in-process 스케줄러. 경로/spawn은 `path`·`cross-spawn`으로 흡수.
- ✦**포트 + 어댑터.** 두뇌(`IBrainProvider`)·임베더(`IEmbedder`)·게이트웨이를 전부 교체 가능하게.
- **코드/데이터 분리.** 코드(repo)와 데이터(`runtime/`)를 분리. `git pull`이 데이터를 안 건드린다.

---

## 4. 확정된 설계 결정 (Design Ledger)

| 영역 | 결정 | 출처 |
|---|---|:--:|
| 구조 | KnowledgeCore 중심 + AgentLayer(A/B/C) | 기존 |
| 스택 | NestJS / TypeScript / Node 22+ | 기존 |
| B 협업 | 자유 채팅 ❌ → Wiki + Orchestrator 경유 + 턴 상한 | 기존 |
| C 자율쓰기 | 검증 다층 파이프라인 + 승인 게이트 필수 | 기존+✦ |
| 벡터 저장소 | **LanceDB** (임베디드, 파일 기반) | ✦ |
| 임베딩 | **로컬 JS 다국어**(bge-m3 / multilingual-e5), `IEmbedder` 포트 | ✦ |
| 기본 두뇌 | **Claude CLI(구독)**, `IBrainProvider` 포트 | ✦ |
| 두뇌 교체 | API·Codex·Gemini·**로컬 LLM** 전부 어댑터로. 모델·경로·인증은 config 선택(하드코딩 금지) | 기존+✦ |
| WikiEngine | **버전관리형**: 출처(frontmatter) + git이력 + draft/published 상태 | ✦ |
| 프로세스 | 단일 상주 프로세스 + OS별 `ProcessSupervisor` | 기존+✦ |
| 감독·복구 | OS 서비스관리자 재시작 + 작은 감시자(멈춤 감지) + 외부 알림 | ✦ |
| 동시성 | 세마포어(동시 두뇌 호출 제한) + TurnBudget(협업 총턴 제한) — 실제 자원 제약 | ✦ |
| 스케줄 | in-process `@Cron` / BullMQ (OS cron 금지) | 기존 |
| Gateway | 포트 + 어댑터, 코어 앞단 중립. CLI → Discord → 자체 | 기존+✦ |
| TaskStore | 공유 1차 프리미티브 (`runtime/state/`) — Dev-Queue·Board 산출물·약속추적 공용 | ✦ |
| InsightLayer | 확정 포함(후순위) — 행동 메트릭·일일 리포트·응답 맥락 주입 | ✦ |
| 페르소나 | `.md` 정의(클래스) + 런타임 상태(객체) 분리. 별자리 테마(Vega·Lyra·Orion·Rigel·Sirius…) | 기존 |
| 위키 패턴 | Karpathy LLM Wiki 3계층 (Raw/Wiki/Schema), stateful·복리 | 기존 |
| 코드/데이터 | 분리 (`runtime/`: 토큰·대화·RAG DB·설정) | 기존 |
| 플랫폼 | Windows → macOS → Linux 네이티브. Docker는 선택(추가) | 기존 |

---

## 5. KnowledgeCore

### 5.1 WikiEngine ✦버전관리형

단순 `.md` CRUD가 아니라 **출처·이력·상태를 가진 버전 관리형 저장소**. C 자율쓰기의 검증을 가능케 하는 토대.

- **페이지 = `.md` + frontmatter.** frontmatter에 `sources:`(출처 포인터), `status:`(draft/published), `category:`, `updated:` 등.
- **출처(provenance) 내장.** 모든 주장은 출처(대화·문서·URL)를 단다. 출처 없는 주장은 검증에서 거부.
- **git 이력.** 위키 데이터 폴더(`runtime/wiki/`)를 자체 git으로 버전관리. C가 첫 글을 쓰기 *전부터* 이력·rollback이 존재. 모든 변경 = 출처·판정을 기록한 커밋.
- **draft vs published 상태.** C가 제안을 "초안"으로 스테이징 → 승인 시 published로 전환.
- **카테고리 스키마(JSON).** 도메인별 페이지 구조 정의.
- **3계층(Karpathy):** Raw(원본 보존) → Wiki(증류) → Schema. Raw 보존이 출처 검증을 가능케 함.

### 5.2 RagStore ✦

- **저장소: LanceDB** — 임베디드·파일 기반, 상시 프로세스 0개. `runtime/rag/`에 얹힘. 단일 라이터 지향(우리 설계와 합치). 내장 FTS(Tantivy)로 하이브리드를 한 저장소에서.
- **임베딩: 로컬 JS(다국어)** — fastembed-js / transformers.js(onnxruntime), in-process. 한·영 혼재 대응 위해 **다국어 모델**(bge-m3 / multilingual-e5). 첫 실행 시 모델 1회 다운로드 후 캐시. `IEmbedder` 포트로 Ollama·API 교체 가능.
- **하이브리드 검색:** BM25(FTS) + 벡터, RRF로 융합.
- **증분 색인 + 파일 워처:** 위키 변경 시 증분 재색인. 파일 워처로 실시간 감지. 위키 갱신 ↔ RAG 재색인을 묶어 stale 읽기 방지.

### 5.3 ImportanceGate

Mem0식 1~5점 채점, **3점↑만 저장**. 위키 비대화 방지. (구현은 **Phase 2** — 수집 경로와 함께. Phase 0서 이관.)

### 5.4 InsightLayer ✦(확정 포함, 후순위)

행동/패턴 메트릭, 일일 인사이트 리포트. 사용 로그 분석 → 응답에 상황 맥락 주입. **빼지 않고 반드시 구현**하되, 사용 로그가 쌓이고 A/B/C 루프가 돈 다음에 얹는 최후순위 레이어. Phase 0 범위 아님.

---

## 6. C 자율쓰기 — 검증 파이프라인 ✦

stateful 위키의 최대 위험은 "틀린 사실이 박혀 진실원을 오염"시키는 것. 단일 게이트가 아니라 **검증 다층 방어(pipeline)** 로 막는다.

```
소스/대화
  → ① 추출    브레인이 후보 사실 추출 + 출처 부착
  → ② 중요도 게이트   1~5점, <3점 폐기                  (비대화 방지)
  → ③ 근거 검증   "출처가 실제로 이 주장을 뒷받침하나?"   (환각 차단)
  → ④ 모순 검사   RAG로 관련 기존 페이지 검색 후 충돌 비교  (일관성)
  → ⑤ 판정    별도 judge 모델이 채점 (작성자 ≠ 검증자)
  → 분기:
       고신뢰 + 무충돌 + 저영향  → 자동 반영 (+알림)    ← 신뢰 쌓인 뒤
       충돌 / 저신뢰 / 고영향    → 사람 승인 게이트       ← 처음엔 전부 여기
  → ⑥ 반영    diff를 git 커밋(출처·판정 기록) + RAG 증분 재색인
  → ⑦ 되돌리기   언제든 rollback
(주기적) ⑧ 감사   전체 위키의 모순·stale·죽은 링크 스캔  (TS Service)
```

**대원칙**: 통째 교체 ❌ → **diff 제안** · **출처 없으면 거부** · **작성자 ≠ 검증자** · **모순은 덮어쓰기 금지(플래그/이력 superseded)**.
처음엔 모든 변경이 사람 승인 경유(엄격). 자동 검증은 (a) 명백한 쓰레기를 사전 필터, (b) 사람 판단을 빠르고 정보에 근거하게(diff+출처+판정 제시). 신뢰가 쌓이면 자동 반영 티어를 연다.

**필수(첫 쓰기 전)**: diff 제안 · 출처 필수 · 모순 검사 · 별도 judge · 사람 승인 · git 이력.
**나중**: 다중투표 judge · 신뢰도별 자동 반영 · 주기 감사 · golden-question 회귀 테스트.

---

## 7. AgentLayer

### 7.1 Orchestrator
질의 라우팅·분해·종합의 허브. **모든 흐름이 경유**(에이전트 직접 호출 금지). 허브-스포크 + **TurnBudget**(협업 총턴 상한)으로 루프·비용 폭발을 막는다.

### 7.2 ReaderAgent (A)
질문 → 검색(RAG) → 답변. Phase 1의 단일 에이전트.

### 7.3 SpecialistAgents (B) — ✦8팀 + Board Meeting
- **페르소나 = `.md` 정의(클래스) + 런타임 상태(객체).** 각자 `brain:` 선언 → 설정된 어댑터로 해소.
- **8팀**(예: Council·Infra·Brand·Career·Academy·Trend·Recon·Record) = SpecialistAgents. 별자리 테마 이름 부여 가능. `/team <이름>` 소환은 **Orchestrator 경유**.
- **Board Meeting** = 스케줄(`@Cron` 매일) 멀티에이전트 세션. Orchestrator가 페르소나(CEO·Infra Chief·Strategy Advisor·Record Keeper)를 소집, 구조화된 라운드로 진행.
  - 산출물 매핑: **공유 컨텍스트 = KnowledgeCore 위키 페이지**("위키가 유일한 공유 상태" 원칙), **회의록 = Record Keeper가 쓰는 위키 페이지**, **의사결정 로그 = TaskStore(`runtime/state/`)**.
- 일부 팀은 대화형 페르소나(소환), 일부는 스케줄 분석가(정기 실행) — 같은 페르소나 틀, 호출 방식만 다름.
- **이 기능이 §3의 제약(세마포어·자유채팅금지·TurnBudget·두뇌 라우팅)의 존재 이유다.** 4명+8팀 동시 추론은 자원·구독 한도에 부딪히므로, 통제된 라운드·턴 상한·페르소나별 두뇌 선택으로만 안전·비용한정하게 굴러간다.

### 7.4 IngesterAgent (C)
스케줄로 자율 수집 → §6 검증 파이프라인 → 게이트 → 위키 갱신 + RAG 재색인.

### 7.5 BrainProvider (`IBrainProvider`) ✦
- **기본 = Claude CLI(구독).** 0설정·구독 한도 내 토큰 $0·풀 에이전트 하네스. `BrainResult`로 출력 정규화.
- **교체 가능**: ClaudeApi / CodexCli / GeminiApi / **LocalBrain(Ollama: Llama·Qwen…)**. 모델·경로(CLI/API)·인증을 **config로 선택**(하드코딩 금지). 페르소나 frontmatter `brain:`로 선언.
- **라우팅 권고**: 깊은 추론·B 종합 = Claude / 대량 저비용 다이제스트 = Gemini Flash·Claude Haiku·로컬 / 자율 코드 = Codex.

### 7.6 IEmbedder ✦
기본 = 로컬 JS(다국어). 교체 = Ollama·API. RagStore 전용.

---

## 8. 동시성·자원 제약 ✦

- **두뇌 호출 = 프로세스 spawn**(Claude CLI). 매 호출이 별도 프로그램 부팅 → 시작 지연 + RAM/CPU 점유.
- **구독 레이트 한도**: 무제한 아님. 24/7 자동화가 세게 때리면 throttle·정책 경계.
- 둘이 겹쳐 **"동시에 생각하는 에이전트 수"에 천장**을 박는다. → **세마포어(동시 호출 max N)** + **TurnBudget(협업 총턴 상한)**. Phase 3(B)의 설계 전제.

---

## 9. Edge

### 9.1 Gateway ✦ (포트 + 어댑터)
입출력 통로. 코어는 추상 "메시지"만 다루고, 프론트엔드 특유의 것(채널 ID·버튼·길이 제한 등)은 어댑터 안에 가둔다 → **코어 앞단 중립**. 각 어댑터는 번역기(프론트엔드 ↔ 코어 질문). 두뇌·임베더와 같은 포트+어댑터 패턴.
- 로드맵: **CLI(초기) → Discord(discord.js) → 자체 front-end(웹/앱).** CLI를 먼저 만드는 것이 코어의 앞단 중립 경계를 강제한다.
- 자체 front-end는 별도 프로젝트(인증·모바일·실시간·호스팅 재구현). 채팅 이상의 UX(위키 편집 화면, 리뷰형 승인 게이트, 대시보드)를 원할 때 정당화됨.

### 9.2 Scheduler
in-process `@nestjs/schedule`(@Cron) 또는 BullMQ. OS cron 미사용. 자율·감사·재색인·뉴스브리핑 등 모든 정기 작업이 여기. BullMQ 잡 상태로 성공률·실패·소요시간 추적.

---

## 10. PAL — 프로세스 감독 ✦

### 10.1 ProcessSupervisor (크로스플랫폼)

OS별로 갈리는 유일한 코드. 설치·시작·정지·재시작 정책을 OS별로 한 번씩 구현.

| 기능 | Windows Service | Linux systemd | macOS launchd |
|---|:--:|:--:|:--:|
| 부팅 시 자동 시작 | ✓ | ✓ | ✓ |
| 죽으면 재시작 | ✓ | ✓ | ✓ |
| 재시도 간격(백오프) | ✓ | ✓ | ✓ (기본 10초) |
| N번 실패 후 포기 | ✓ | ✓ | ✗ |
| 실패 시 알림 명령 실행 | ✓ | ✓ | ✗ |
| 멈춤(hang) 감지 | ✗ | ✓ (WatchdogSec) | ✗ |

핵심: **재시작이라는 근본은 셋 다 네이티브.** OS마다 다른 디테일은 ProcessSupervisor가, 부족한 고급 기능(멈춤 감지·포기·알림)은 §10.2 크로스플랫폼 감시자가 통일되게 메운다. 개발 순서: **Windows(1순위) → macOS → Linux.**

### 10.2 감시자 (heartbeat + 알림)
- 재시작은 **OS 서비스관리자**가 담당(제일 안 죽는 OS 기능). 직접 만들지 않는다(감시자 자신도 죽을 수 있음 = 무한 후퇴).
- 작은 감시자가 **생존신호(heartbeat)** 를 받는다: Engram이 1분마다 "건강함" 신호 → 끊기면(죽음 또는 멈춤) 멈춘 프로세스를 강제 종료(→ 서비스관리자 재시작) + 몇 분 내 미복구 시 **폰/외부로 알림**.
- 감시자는 **아주 단순**하게(거의 안 죽게). 최종 알림은 **외부**(PC 통째 죽어도 인지).
- 재시도는 일시적 장애에만 효과 → **빠른 재시도 1~2회 후 즉시 알림**(고정 장애는 재시도로 안 고쳐짐).
- **무한 자동복구는 환상.** 모든 복구는 "사람 알림"에서 끝난다. 데이터가 `runtime/`에 파일로 분리돼 있어, 프로세스가 못 켜져도 **지식은 보존** → 고치고 재시작.

### 10.3 단일 프로세스 운영 위생 ✦
단일 상주 프로세스의 대가(셸 스크립트와 달리 죽으며 자동 청소가 안 됨). Phase 0부터 코어에 내장:
- **메모리**: 모든 캐시는 `lru-cache`(크기 제한 → 구조적으로 누수 방지). 감지는 메모리 추세(청소 후 바닥값이 계속 오르면 누수) + 임계치 알림 + heap 스냅샷으로 원인 특정.
- **동시성**: 공유 상태 단일 라이터 / 페이지 락. 두뇌 호출 `p-limit` 세마포어.
- **에러**: 작업 경계마다 try/catch(한 에이전트 실패가 프로세스를 안 죽이게). 구조화 로깅(pino) 디스크 영속.

---

## 11. 위험 요소 및 완화

| 위험 | 완화 |
|---|---|
| 쓰기 경합 (C·B 동시 갱신) | 단일 라이터 / 페이지 락 / FSM(PENDING→RUNNING→SUCCESS/FAILED) |
| stale 읽기 (C 갱신 중 A 읽음) | 위키 갱신 ↔ RAG 재색인 묶음, 증분 색인 |
| B 루프/비용 폭발 | Orchestrator 허브-스포크 + TurnBudget + 세마포어 |
| C가 틀린 사실 자율 박음 | §6 검증 파이프라인 + 승인 게이트 |
| 위키 비대화 | ImportanceGate 3점↑만 |
| 프라이버시 | 로컬 유지, `runtime/` 분리, gitleaks pre-commit |
| 윈도우 OS 샌드박싱 부재 | C 자율 권한 최소화 + 승인 게이트 강화 |
| 하네스 불일치 (CLI별 상이) | `BrainResult` 정규화, 능력차는 페르소나 `brain` 선택으로 흡수 |
| 인증 분산 (Claude/OpenAI/Google) | 어댑터별 자격증명 분리(환경변수), `cc-switch`로 통합 관리 |
| ✦메모리 누수 (단일 상주) | lru-cache 기본 + 추세 감시 + 임계치 알림 + 자동 재시작 안전망 |
| ✦프로세스 다운/멈춤 | 서비스관리자 재시작 + 감시자 멈춤감지 + 외부 알림 + 데이터 분리로 무손실 |

---

## 12. 플랫폼 전략 (윈도우 네이티브 우선)

- **`claude -p`는 윈도우 네이티브 동작 확인됨**(WSL 불필요). 설치: PowerShell `irm https://claude.ai/install.ps1 | iex`. 권장 `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`.
- **OS 레벨 샌드박싱은 macOS/Linux 전용** → C 자율 쓰기 안전장치 강화 근거.
- **항상 켜짐**: Windows Service(1순위) → macOS launchd(2) → Linux systemd(3). 개발 중엔 터미널 `start:dev`. Docker는 선택.
- **이식성 체크리스트**: 셸 0개 · OS cron 미사용 · 경로 하드코딩 금지(`path.join`) · `.gitattributes` `* text=auto eol=lf` · `claude -p`는 `cross-spawn`.

---

## 13. 빌드 로드맵 (이 순서 — B·C가 코어에 의존)

> 교훈: **1개부터.** A·B·C 동시 착수는 코어가 흔들려 다 무너진다.

- **Phase 0 — KnowledgeCore (토대)** ✅ **완료**: WikiEngine(✦버전관리형) + RagStore(✦LanceDB + 로컬임베딩 + 하이브리드 + 증분색인 + 파일워처) + ✦상주 위생(lru-cache·pino). 멀티유저·페이지락·CachingEmbedder 포함. (당초 포함했던 **'수집 1경로'·ImportanceGate는 Phase 2로 이관** — 자율쓰기와 함께 묶는 게 자연스러워서.)
- **Phase 1 — A 읽기** ✅ **완료**: ReaderAgent(질문→검색→답) + ✦CLI Gateway(앞단 중립 경계) + Claude CLI 두뇌 + ✦세마포어.
- **Phase 2 — C 자율쓰기** ✅ **완료**: IngesterAgent(스케줄 digest, writer+judge 2콜) + ✦검증 파이프라인(추출→ImportanceGate→근거→모순→judge) + 승인 게이트(`engram review`) + **ImportanceGate(§5.3) + 수집 경로 B(대화 로그 다이제스트)** + 위키↔RAG 재색인(워처) + ✦@Cron 다이제스트. **스테이징=위키 밖 ProposalStore 결재 대기함**(§5.1 draft-플래그 재해석: 승인 전 라이브 위키 무손상). judge=별도 프로필(작성자≠검증자). 자동반영·다중투표·주기감사(⑧)·golden-question은 후속(§6 "나중").
- **Phase 3 — B 협업**: Orchestrator + Specialist + 종합 + ✦8팀 + Board Meeting + TaskStore + 동시성/턴 상한.
- **Phase 4 — ✦자율 코딩 협업** ✅ **완료**: `engram code <폴더> "목표"` → 분해=설계 → 스페셜리스트가 격리 브랜치에 코드 → **Engram이 직접 게이트(테스트·빌드·타입체크)** → 통과분만 착지 → 완성조건+리뷰어 승인까지 반복. run-state(pause/resume/stop)·stuck·예산. 자기수정 백스톱(자기 repo+시스템 폴더 무조건 거부)·자동 권한 모드(폴더 인자=동의, JSON 설정 0)·결정적 게이트 탐지·에이전트 프롬프트 `prompts/*.md` 외부화. 씨앗 §13.1.
- **Phase 5 — InsightLayer + 운영(PAL)** ✅ **완료**: ✦InsightLayer(행동 메트릭 + 일일 인사이트 리포트 + 응답 맥락 주입 — A/B/C 루프가 돈 뒤) + 운영(PAL): OS 순서대로(Win→Mac→Linux) 마감 + 감시자. (PAL 기초 상주는 Phase 0부터 점진적으로 깔고, 여기서 완성.) 구현: InsightLayer(메트릭 순수집계 + 두뇌 일일리포트 + `state/insights` + 응답 참고용 주입 + `engram insights`) · PAL(서비스 등록 3종[node-windows/systemd/launchd] + heartbeat + watchdog 별도 프로세스 + 설정형 알림 + 메모리 감시 + `engram service`). ⚠️ Mac/Linux 서비스 실동작은 해당 OS 수동 검증.
- **Phase 6 — Tag(메신저) + 연속성·멘션코딩·스케줄·앰비언트** ✅ **완료**: MessengerPort + Discord 어댑터(@Engram 멘션·스레드·`상태`·진행 중계) · 대화 연속성(6b) · 멘션으로 코딩 위임(6b-2) · 스케줄링·자기 스케줄링(6b-3) · 앰비언트 권한(6c). 코드: `edge/ambient-service.ts`·`{digest,insight,meeting}.scheduler.ts`·`agent-layer/{meeting-engine,mention-tracker}.ts` 등. 스펙 `specs/2026-06-28-phase6-tag-design.md` ~ `2026-07-02-phase6c-ambient-permissions-design.md`. (뒤 §13 Phase 9 설명이 "Phase 6 seam"·"6a"·"6b-2"로 참조하는 그 seam.)
- **Phase 7 — ✦배포·패키징 (단일 설치형 앱)** ✅ **완료**(스펙 `specs/2026-07-02-phase7-desktop-packaging-design.md`, ~15커밋): 개발용 CLI를 **Claude Desktop처럼 더블클릭 설치형 한 프로그램**으로 포장. 구현: Electron 셸(`desktop/main.ts` — 트레이 상주·자식 감독·백오프) · 데이터 `app.getPath('userData')`(appdata)·모델캐시 `ENGRAM_MODEL_CACHE_DIR` · prompts/personas 번들+appdata 사용자오버라이드(`pal/resource-dir.ts`) · claude/ollama 감지(`desktop/claude-detect.ts`) · electron-builder(Win NSIS/Mac dmg/Linux AppImage)+`.github/workflows/desktop-release.yml`(v* 태그→3-OS 릴리스, 무서명) · electron-updater 자동업데이트. **미완=코드서명(무서명 의도적 선택)·실 설치→실행 스모크(수동 미검증)뿐.** 아래 씨앗은 그 구현으로 소진됨:
  - **GUI 셸 어댑터**(Electron/Tauri)를 Edge에 추가 — CliGateway 옆에 또 하나의 어댑터. 코어(Orchestrator/에이전트/지식) 무변경(포트+어댑터 seam이 이미 받쳐줌).
  - **데이터 위치 전환**: `cwd/runtime` → `%APPDATA%/engram`(OS별 사용자 데이터). PathResolver가 이미 자리(생성자 인자·`ENGRAM_DATA_DIR` env) — 기본값만 OS appdata로.
  - **리소스 번들**: `prompts/`·`personas/`를 앱 리소스로 동봉(findRepoRoot 레포-루트 해소 대신 번들 경로). 사용자 편집본은 appdata 쪽 오버라이드로.
  - **`claude` 의존 처리(설계 선택)**: 코딩/두뇌가 외부 `claude` CLI를 spawn → 단일 바이너리에 번들 어려움. 설치 감지·안내, 또는 추론 백엔드 동봉(로컬 LLM) 여부 결정.
  - **임베딩 모델**: 동봉 vs 첫 실행 다운로드.
  - **인스톨러**: electron-builder/tauri bundler, OS 순서 Win 우선(§13 PAL과 정합 — Phase 5 PAL 마감 뒤).
  - **전제 seam(이미 존재)**: Edge 포트+어댑터(CLI=첫 어댑터)·PAL 경로 중앙화·`main.ts`(상주)/`cli.ts`(원샷) 분리. → 코어는 CLI를 가정하지 않으므로 GUI가 거저 올라탈 자리가 있다.
- **Phase 8 — ✦Engram 하네스 (자체 에이전트 하네스)** — **8a·8d ✅ 완료 / 8b·8c 남음**. 8a(스펙 `specs/2026-07-13-phase8a-engram-harness-design.md`): API 직접 호출 provider 2종(`anthropic-api` Messages API·`openai-api` OpenAI호환 = Ollama가 claude CLI 없이 동작) + 자체 웹검색(DDG 기본/Brave/Tavily)/웹fetch(SSRF 가드) 미니 도구루프(상한 8) — 단발호출 전 경로 커버, `opts.cwd`(코딩)는 8b까지 명시적 거부. **8d**(스펙 `specs/2026-07-16-phase8d-conductor-brain-design.md`) ✅: 지휘자 두뇌 — 엔그램 하네스 두뇌(anthropic-api·openai-api)에 `ask_brain` 위임 도구를 더해, 대화 중 등록된 다른 두뇌에게 하위작업을 넘긴다(사용자 지목 or 막히면 자율 폴백). 깊이 1단(일꾼은 delegate 없이 호출=재위임 불가)·never-throw·위임 대상은 항상 프로필로 새 인스턴스(고유 세마포어=지휘자와 자원 분리)·`BrainProvider.canDelegate`로 CLI 기본이면 지휘자 오프(회귀0). CLI를 지휘자로 쓰는 건(claude CLI가 codex 호출 등) 8c/MCP. 남은 것: **8b**=코딩 도구루프(`codeRun` 파일편집·셸)+`brains.json` 기본 provider 전환, **8c**=MCP 클라이언트. **핵심 통찰** — 지금은 모델뿐 아니라 **하네스(에이전트 도구 루프)까지 외부 CLI(`claude`/`gemini`/`codex`)에서 빌려 쓴다.** "로컬 LLM 사용"조차 [brain.factory.ts](src/brain/brain.factory.ts) 주석대로 *`claude` CLI 껍데기 + env로 모델 엔드포인트만 로컬로* 바꾼 것이라, 하네스는 여전히 `claude`다. **모델 추론은 만들지 않고**(상용 API·로컬 LLM·기존 CLI 중 사용자 선택) 그 위의 **하네스를 Engram 것으로** 갖는 단계. §13.1 궁극 목표("Claude Code를 안 쓰게 되는 것")의 실질 완성. 범위:
  - **자체 하네스 provider 추가 = 기본값**: 모델 엔드포인트(Anthropic API·OpenAI 호환 로컬 등)를 **직접** 호출하고, 코딩의 도구 루프(파일편집·명령실행·관찰 반복)를 **Engram 코드가 직접** 돈다. `createBrain` 패턴 그대로라 Orchestrator·에이전트·세마포어 무변경. **`brains.json` 기본 provider = engram 하네스.**
  - **선택권 — 기존 CLI provider 유지**: `claude-cli`/`gemini-cli`/`codex-cli`는 그대로 둔다. CLI 쓰던 유저는 **무변경**, API·로컬 LLM 유저는 **자체 하네스(기본) ↔ `claude` CLI**를 config로 갈아끼운다. 강제 탈피 아님, *선택권*.
  - **도구 셋 = 파일(읽기/쓰기/편집)·셸·검색 + MCP 클라이언트(기본 내장)**: MCP는 외부 도구·테스트 위임의 **표준 통로**라 *메커니즘은 하네스 기본 능력*으로 박는다(YAGNI 아님). **어떤 MCP 서버를 연결하냐만** config/런타임 선택. 스킬(=프롬프트 주입, `prompts/*.md`·personas 외부화 재사용)·훅(=게이트·PermissionFence로 이미 존재)은 그 위 얇은 규약 — 필요할 때 점진 추가.
  - **난이도 분리(구현 순서)**: 단발성 호출(chat·collaborate·judge·classify)=API 한 번이라 쉬움 → 먼저. 코딩 호출(`codeRun`)=도구 루프를 직접 구현해야 해 진짜 일 → 나중. PermissionFence(자기repo·시스템 거부)·결정적 게이트·격리 브랜치 seam은 불변.
  - **한도·resume 재정의**: 외부 CLI의 rate-limit 대신 자체 하네스/모델 기준으로 §13.1 미해결②(진전·예산 상한, resume 정책) 다시 못박음.
- **Phase 9 — ✦자체 프론트엔드 (Discord 대체 채팅 UI)** (미설계 — 착수 시 brainstorming부터): 로드맵 §11의 "자체 front-end(웹/앱)" 최종 도착점. Phase 7 GUI 셸 위에 **Discord식 채널/스레드 채팅을 얹은 자체 UI**로 Discord 어댑터를 대체한다. 범위:
  - **메신저 어댑터 추가**: `MessengerPort`의 새 구현(자체 UI) — Phase 6 seam 그대로라 `@Engram` 멘션·스레드·`상태`·진행 중계가 거저 올라탐. provider만 `discord`→`self`, 코어·Orchestrator 무변경.
  - **채팅 화면**: Phase 7 GUI 셸(Electron/Tauri) 위에 채널·스레드·멘션·진행 중계·인사이트 표시. 코딩 위임(6b-2)의 컨펌/승인도 채팅 UI에서.
  - **멀티유저=채널이 기억 단위(6a) 모델 유지**: UI는 표현만, `ConversationStore` 네임스페이스(채널 ID) 무변경.
  - **Discord 병행**: Discord 어댑터는 제거하지 않고 남겨 필요 시 동시 운용 — 기본 진입점만 자체 UI로.

> ⚠️ **§13.1 = Phase 4 씨앗 설계.** 현재 깊이는 "4대 미해결의 방향 + Phase 3가 지켜야 할 seam 고정"까지다. 풀 구현 스펙은 Phase 3(토대)가 코드로 존재한 뒤에 쓴다. *미설계*를 구현 약속으로 착각 금지.

### 13.1 ✦Phase 4 — 자율 코딩 협업 (씨앗 설계)

**궁극 목표**: 사람이 양 끝(처음 설계 + 마지막 확인)에만 있고, 중간 전부를 에이전트 무리가 서로 물고 돌려 *결과물을 산출*하는 자율 팀. 협업은 협업대로(B), 코딩은 코딩대로 — Claude Code처럼 범용으로. Claude Code ↔ Codex 등 이종 두뇌가 메시지를 주고받으며 진행하고, 한도가 차면 미해결 ②(resume 정책)에 따라 이어간다.

**핵심 통찰 — 코드가 아니라 "위키 패턴"을 옮긴다.** §1의 통찰("에이전트=stateless 워커, 기억=코어의 단일 진실원")을 *지식*이 아니라 *진행 중인 작업*에 그대로 적용한다. = **프로젝트-as-위키**: 계획·결정·진행·검증결과를 게이트 걸린 단일 진실원으로 두고, 에이전트는 그것을 **통해서만** 읽고 쓴다.

- **저장소를 옮기는 게 아니라 패턴을 옮긴다.** 코드 자체는 git이 이미 버전관리 SSOT. 위키 패턴이 *위에 얹는* 것은 git이 저장 안 하는 것 — **계획, 내려진 결정, "뭐가 검증됐고 뭐가 아직 draft냐", 모순 검사.** 이게 두 에이전트가 *함께 틀리는* 걸 막는 층이다.
- **사람의 "오류 정정" 역할을, 게이트 통과한 공유 진실이 대신한다.** 자율 멀티에이전트가 무너지는 3가지를 위키 패턴이 각각 막는다:
  - 컨텍스트를 머릿속에 들고 다니다 드리프트 → 매 턴 **코어에서 현재 진실을 읽음** (들고 다닐 게 없음)
  - 거짓 "다 됐습니다" 보고 → **검증 게이트(§6 파이프라인) 통과 못 하면 공유 상태에 반영 안 됨**
  - 둘이 틀린 방향에 사이좋게 합의 → **기록된 결정·근거에 대조**(모순검사), 서로가 아니라 *문서화된 ground truth*에 맞춤
- **같은 기계가 지식 위키 + 프로젝트 위키를 둘 다 호스팅.** spec·plan·progress도 결국 draft/published 상태의 `.md` + git이력 → 기존 WikiEngine이 콘텐츠 종류만 바꿔 그대로 쓴다. 새 저장 계층 불필요.
- **현재 이 루프는 외부(사람 + Claude Code/superpowers)가 손으로 돌리는 중.** SDD 원장(`.superpowers/sdd/progress.md`)·spec·plan이 "프로젝트 위키"의 원시 버전. 이 능력의 정의 = **그 외부 루프를 Engram의 WikiEngine이 내부로 흡수하는 것.** 이 프로젝트의 끝은 "Claude Code를 안 쓰게 되는 것"에 가깝다.

**4대 미해결 (씨앗 설계에서 *방향*을 정함):** ① 에이전트가 산출한 *코드*의 검증 게이트 = 무엇이 ground truth인가(테스트 통과·빌드·타입체크·리뷰 합의 등 기계 판정 기준) ② rate-limit 소진 시 resume 정책 — 리셋까지 대기 후 자율 지속 vs §10.2 "막히면 사람 알림" ③ 자기 *소스코드* 수정·재배포까지 갈 것인가(무한루프·자기파괴 위험 → 위키 갱신과 차원이 다른 안전장치 필요) ④ 이종 두뇌 간 메시지 프로토콜(Orchestrator 허브 경유 불변 유지, 자유채팅 금지 §3).

> ▸ **씨앗 설계 완료(방향 확정)** → [`specs/2026-06-27-phase4-autonomous-coding-seed.md`](superpowers/specs/2026-06-27-phase4-autonomous-coding-seed.md). 결정: **③ 외부 프로젝트만 · ① 자동검사 하드게이트+리뷰어 소프트(테스트 없으면 C-2 특성화, 변경은 완성조건 추적) · ④ 블랙보드+작업티켓(두뇌 roster=config) · ② 진전·예산만 상한(시간 상한 없음) · 제어=run-state 스위치 1개로 stop·rate-limit·stuck·예산 통합.** Phase 3가 지켜야 할 seam 6개는 spec §3. 풀 구현 스펙은 Phase 3 실체 후.

---

## 14. 기술 스택

- 런타임: Node.js 22+, TypeScript, NestJS
- 위키: 파일 기반 `.md` + 카테고리 스키마(JSON) + git 이력
- RAG: **LanceDB** + **로컬 JS 임베딩(다국어)** + 하이브리드(BM25 + 벡터, RRF)
- 두뇌: `IBrainProvider` 포트 — **Claude CLI 기본** / API·Codex·Gemini·로컬LLM 어댑터. 모델·경로·인증 config 선택
- 스케줄: `@nestjs/schedule`(@Cron) / BullMQ
- 항상 켜짐: Windows Service(node-windows/NSSM) / macOS launchd / Linux systemd. Docker 선택
- 게이트웨이: CLI(초기) → Discord(discord.js) → 자체 front-end

---

## 15. 디렉토리 구조

```
engram/                      # 코드 (repo, git pull로 교체됨)
 ├ src/
 │  ├ knowledge-core/        # WikiEngine, RagStore, ImportanceGate, InsightLayer
 │  ├ agent-layer/           # Orchestrator, ReaderAgent, SpecialistAgents, IngesterAgent
 │  ├ brain/                 # IBrainProvider + 어댑터(Claude CLI/API, Codex, Gemini, Local), IEmbedder
 │  ├ edge/                  # Gateway(CLI/Discord), Scheduler
 │  └ pal/                   # ProcessSupervisor(Win/Mac/Linux), 감시자, PathResolver
 ├ personas/                 # 페르소나 .md 정의 (클래스)
 ├ docs/
 └ docker/                   # 선택 배포 타깃

%APPDATA%/engram/ (또는 runtime/)   # 데이터 (git 미추적)
 ├ wiki/pages/{userId}/*.md  # + 자체 git 이력
 ├ rag/                      # LanceDB
 ├ state/                    # 세션, TaskStore
 └ config/                   # 토큰, 개인 설정
```

---

## 16. 참고 레퍼런스

- ramsbaby/jarvis — 셀프호스팅 멀티에이전트 어시스턴트 구조 레퍼런스
- NanoClaw — Agent SDK 기반, 페르소나 = 클래스/객체 패턴
- Karpathy LLM Wiki — stateful 위키 3계층 (Raw/Wiki/Schema)
- Mem0 — 중요도 채점 메모리 패턴
