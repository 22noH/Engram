# Phase 3 — B 협업 (멀티 페르소나 + 두뇌 플랫폼 + 도구 플랫폼) 설계

> 상위 기준선: [docs/DESIGN.md](../../DESIGN.md) §7·8·13 · 작성: 2026-06-27 · 상태: **설계 — 승인 완료, 구현 플랜 대기**
> 전제: Phase 0·1·2 완료(KnowledgeCore + A 읽기 + C 자율쓰기). 이 설계는 그 위에 B(협업)를 얹고, Phase 4(자율 코딩)가 올라탈 토대(이종 두뇌·도구 권한)를 같이 깐다.

---

## 1. 개요 · 범위

여러 페르소나 에이전트(8팀)가 **같은 위키를 공유하며 Orchestrator를 경유해 협업**하는 B 레이어를 만든다. 동시에, Phase 4(자율 코딩 협업)가 그 위에서 개발될 수 있도록 **이종 두뇌 어댑터 3종**과 **도구 권한 울타리**를 토대로 함께 깐다.

**핵심 원칙(불변, DESIGN §3)**: 에이전트끼리 직접 대화 금지 → 모든 흐름은 Orchestrator(유일 배정구) 경유 + 공유 블랙보드(stigmergy). 자유 채팅은 루프·비용 폭발이라 구조적으로 차단.

**범위 안**:
- Orchestrator 실체화(스텁 → 분해·배정·종합 허브)
- PersonaRegistry + 8팀 페르소나 `.md`
- SpecialistAgent(제네릭·stateless 워커)
- TaskStore(FSM 블랙보드)
- TurnBudget(협업 총턴 상한)
- Synthesizer(종합)
- 두뇌: ClaudeCliBrain env 확장(로컬LLM 백엔드 흡수) + GeminiBrain·CodexBrain 네이티브 CLI 어댑터 + provider→adapter 팩토리
- 제네릭 회의 엔진 + `engram meeting` 명령(일/주/월/특수)
- 도구 권한 울타리(네이티브 권한 설정, default-deny, 경로 스코프)
- 페르소나별 웹도구(WebSearch/WebFetch) 선언

**범위 밖(미래 페이즈)**:
- run-state 제어 명령(pause/resume/stop) — Orchestrator 배정구에 *자리만* 남김(Phase 4 seam #3)
- 자율 코드 검증 하드게이트(테스트·빌드 통과 강제) — Phase 4 ①
- self-modification(자기 소스 수정) — Phase 4 ③에서 명시 보류
- InsightLayer — Phase 5
- 위키 주기 감사(§6 ⑧)·골든질문 회귀 — DESIGN "나중"

---

## 2. 확정된 결정 (Decision Ledger)

| 영역 | 결정 | 근거 |
|---|---|---|
| 협업 프로토콜 | 블랙보드(TaskStore) + Orchestrator 배정구. 에이전트 직접호출 0 | DESIGN §3, Phase4 seam #1·#4 |
| 첫 슬라이스 | 풀 Phase 3 단일 spec(서브페이즈 분할 안 함). 구현은 토대→협업 순서 | 사용자 결정 |
| 페르소나 | 8팀 전부 실내용 `.md`. 별자리 이름 폐기 → 팀명=페르소나명 | 사용자 결정 |
| 8팀 | Manager·Infra·Brand·Career·Academy·Trend·Recon·Record | 사용자 결정 |
| run-state | 이번엔 seam(자리)만. 제어 명령은 Phase 4 | 사용자 결정 |
| TaskStore | FSM 포함 정식 프리미티브(공유 1차) | 사용자 결정, DESIGN §4 |
| 로컬 LLM | 별도 어댑터 ❌ → **Claude Code 하네스 + 백엔드 env**(ANTHROPIC_BASE_URL=Ollama 등). 하네스·도구·울타리 공유, Claude 토큰 0 | 사용자 결정(검증완료) |
| Gemini·Codex | **각자 네이티브 CLI 어댑터**(자기 하네스). Phase 3=텍스트 협업용, 도구배선은 Phase 4 | 사용자 결정 |
| 회의 | 제네릭 엔진 + 사용자 명령 설정(일/주/월/특수) | 사용자 결정 |
| Bash/Write | 허용 — default-deny 권한 울타리(사용자 사전승인 범위 내 자율) | 사용자 결정 + DESIGN §3 게이트 |
| 권한 구현 | 새 엔진 ❌ → 각 하네스의 **네이티브 샌드박스**를 config에서 운전. Claude 하네스(진짜 Claude+로컬LLM 백엔드)=--allowedTools/--add-dir | ponytail(네이티브 재사용) |
| 웹도구 | 페르소나별 `tools:` 선언, 읽기전용 기본 안전 | 사용자 결정 |

---

## 3. 아키텍처 — 컴포넌트

```
Edge
 ├ CliGateway(기존) + engram meeting 명령(신규)
 └ Scheduler(@nestjs/schedule) → 회의 시각에 Orchestrator 소집

AgentLayer
 ├ Orchestrator(실체화)   유일 배정구. route 분기:
 │                         단일질의→ReaderAgent(A) / 다중·/team·회의→협업(B)
 │                         분해→배정(티켓)→수집(블랙보드)→종합
 ├ PersonaRegistry        personas/*.md 로드·파싱(클래스). 런타임 상태는 객체
 ├ SpecialistAgent        제네릭 워커. (persona, brain, 권한울타리) 주입. stateless
 ├ Synthesizer            블랙보드 기여 종합 → 최종 답(별도 호출)
 ├ TurnBudget             협업 세션당 총 두뇌호출 상한
 ├ MeetingEngine          제네릭 스케줄 세션(스케줄+로스터+안건=config)
 └ ReaderAgent(기존)/IngesterAgent(기존)

Brain
 ├ BrainProvider 포트(기존) + ClaudeCliBrain(기존, +env 프로필)
 │     └ 백엔드 교체: 진짜 Claude(구독) / 로컬LLM(env ANTHROPIC_BASE_URL=Ollama 등) — 하네스 공유
 ├ GeminiBrain / CodexBrain(신규)   각자 네이티브 CLI 하네스(텍스트 협업, 도구는 Phase 4)
 └ BrainFactory           brains.json provider → 어댑터 해소

KnowledgeCore
 ├ WikiEngine/RagStore/...(기존)
 └ TaskStore(신규)        runtime/state/ FSM 블랙보드, KeyedLock(기존) 단일라이터
```

---

## 4. 협업 흐름 (B)

질의/회의 1건 = 협업 세션 1개 = TaskStore 레코드 1개.

```
① 분해   Orchestrator가 두뇌 1콜로 "누구를 부를지" 결정
          (간단 질의면 분해 생략 → ReaderAgent 단일경로 = Phase 1 그대로)
② 배정   각 대상 페르소나에 작업 티켓 발급
          티켓 = { persona, question, blackboardRef }  ← 에이전트 직접호출 ❌
③ 수집   SpecialistAgent×N 동시 실행
          · Semaphore: 동시 호출 수 제한(기존, 순간 부하)
          · TurnBudget: 세션 총 호출 상한(신규, 누적 비용)
          · 각자 결과를 블랙보드(TaskStore.blackboard[persona])에 기록 — 서로 대화 0
④ 종합   Synthesizer가 블랙보드 읽고 → 단일 답. 세션 status=SUCCESS
```

- **TurnBudget 소진** → 추가 배정 중단, 가진 블랙보드로 종합(돈 새는 천장).
- **에이전트 실패** → 해당 티켓만 status 영향, try/catch로 프로세스 보호(§10.3). 세션은 남은 기여로 종합 또는 FAILED.

---

## 5. 데이터 모델

### 5.1 TaskStore 레코드 (runtime/state/*.json)

```jsonc
{
  "id": "task_2026-06-27_a1b2",
  "kind": "collaboration" | "board-decision",
  "status": "PENDING" | "RUNNING" | "SUCCESS" | "FAILED",
  "question": "…",
  "assignees": ["Brand", "Trend"],
  "blackboard": { "Brand": "…", "Trend": "…" },  // 페르소나별 기여
  "result": "…" | null,                           // 종합 산출
  "createdAt": "ISO", "updatedAt": "ISO"
}
```

- **FSM**: `PENDING → RUNNING → SUCCESS | FAILED`. 전이만 허용(역행·건너뛰기 거부).
- **append-only + 단일 라이터**: 동시 쓰기는 기존 `KeyedLock`(키 = 레코드 id)으로 직렬화. 새 락 안 만듦.
- **영속**: 파일로 디스크에 → 프로세스 죽어도 칠판 보존(seam #2). 진실은 에이전트 메모리가 아니라 여기.
- **관측성**: status·blackboard 변화가 객관 관측점 → Phase 4 stuck 감지의 토대(seam #4).

### 5.2 페르소나 정의 (personas/*.md)

```markdown
---
name: Trend
role: 시장·트렌드·뉴스 분석
brain: claude          # brains.json 프로필 키 (없으면 default 폴백)
tools: [WebSearch, WebFetch]   # 권한 울타리와 교집합되어 실허용 결정
invocation: [summon, schedule] # 소환 / 스케줄
board: strategy-advisor        # 보드 역할(선택)
---
<페르소나 시스템 프롬프트 본문>
```

- **클래스(.md 정의) vs 객체(런타임 상태) 분리**(DESIGN §7.3).
- 8팀: Manager(의장)·Infra(Infra Chief)·Brand·Career·Academy·Trend(Strategy Advisor)·Recon·Record(Record Keeper). 웹도구는 Trend·Recon만 기본 선언.
- **제약(§8과 정합)**: 도구는 *하네스* 능력이라 `tools:` 선언 페르소나는 **Claude Code 하네스 위에서 도는 두뇌**여야 한다 = 진짜 Claude(구독) 또는 **로컬LLM 백엔드**(env로 Ollama 등). 둘 다 같은 하네스라 도구·울타리 동일. Gemini/Codex(자기 네이티브 CLI)는 Phase 3에선 텍스트 전용 → `tools:` 있어도 경고+무시. `brain:` 값은 brains.json 프로필 키(`claude` / `ollama` / `gemini` / `codex` …).

### 5.3 회의 설정 (runtime/config/meetings.json)

```jsonc
[
  { "name": "일일브리핑", "schedule": "0 3 * * *",
    "roster": ["Manager","Infra","Trend","Record"], "agenda": "…" }
]
```

### 5.4 권한 울타리 (runtime/config/permissions.json)

```jsonc
{
  "default": "deny",
  "allow": {
    "tools": { "Trend": ["WebSearch","WebFetch"], "Manager": ["WebSearch"] },
    "writePaths": ["C:/Users/User/projects/foo"],   // 쓰기 허용 폴더
    "denyPaths":  ["<engram repo>", "<system>"]      // 절대 금지(자기파괴 차단)
  }
}
```

---

## 6. 두뇌 — 하네스 1개 + 백엔드 교체 + 네이티브 CLI 어댑터 (Phase 4 토대)

핵심 통찰(검증완료): Claude Code 하네스는 **백엔드 교체 가능**. `claude -p`를 spawn할 때 자식 프로세스에 `ANTHROPIC_BASE_URL`·모델 tier env를 주면 **하네스는 그대로, 추론만 다른 모델**(로컬 Ollama 등)에서 → **Claude 구독 토큰 0**. env는 자식 프로세스별로 격리되므로 페르소나마다 백엔드가 달라도 동시 실행 무간섭.

### 6.1 ClaudeCliBrain 확장 — 진짜 Claude + 로컬LLM (한 어댑터)

- **기존 ClaudeCliBrain 재사용.** spawn 옵션에 `env: { ...process.env, ...profile.env }` 추가(현재 [claude-cli.brain.ts:49]는 env 미전달). 출력은 항상 Claude Code stream-json → **파서 하나로 통일**.
- brains.json 프로필 `env`로 백엔드 결정:
  - `claude` 프로필 = env 없음 → 진짜 Claude(구독)
  - `ollama` 프로필 = `env:{ ANTHROPIC_BASE_URL:"http://localhost:11434/v1", ANTHROPIC_DEFAULT_*_MODEL:"qwen2.5-coder", ANTHROPIC_API_KEY:"no-auth" }`
- **둘 다 같은 하네스** → 도구·권한 울타리(§8) 동일하게 적용. 로컬LLM도 도구 사용 가능(단 작은 모델은 도구호출 신뢰성↓ → 도구·코딩은 센 백엔드로 라우팅).
- 자원 풀 분리: 진짜 Claude=구독 한도 / 로컬=GPU. 싼 일을 로컬로 내려 한도 절약.

### 6.2 GeminiBrain · CodexBrain — 각자 네이티브 CLI 어댑터 (신규 2종)

| 어댑터 | 호출 | 인증 | Phase 3 범위 |
|---|---|---|---|
| GeminiBrain | gemini CLI | Google 키 | 텍스트 협업·종합. 자기 도구/권한 배선은 Phase 4 |
| CodexBrain | codex CLI | OpenAI 키 | 〃. Codex 고유 코딩 하네스는 Phase 4(이종 *에이전트* 협업) |

- 각자 spawn + 출력 파싱 → `BrainResult` 정규화. 자기 profile.concurrency Semaphore 보유.
- **BrainFactory**: brains.json `provider`(`claude-cli`|`gemini-cli`|`codex-cli`) → 어댑터 선택. 현재 `brain.config.ts`의 `provider !== 'claude-cli'` throw 가드를 팩토리 분기로 확장. (로컬LLM은 `claude-cli` provider + env 프로필이라 새 provider 불필요.)
- 모델·CLI 경로·인증 전부 config/env(하드코딩 금지 §3). cross-spawn.

---

## 7. 회의 엔진 (제네릭)

- **MeetingEngine**: (schedule, roster, agenda) 파라미터로 도는 협업 세션. §4 흐름 재사용 — 회의 = 안건이 고정된 협업.
- 진행: 의장 페르소나가 안건 제시 → 참석자 블랙보드 기록 → 의장 종합 → **Record(서기)가 회의록을 위키 페이지로, 결정을 TaskStore(kind=board-decision)로** 기록(DESIGN §7.3 산출물 매핑).
- TurnBudget 동일 적용(라운드 무한증식 차단).
- **명령**: `engram meeting add|list|remove|run` → CliGateway → Orchestrator(seam #1). Scheduler가 등록된 cron에 Orchestrator 소집.
- 일/주/월/특수 = meetings.json 인스턴스(코드 하나, 설정 N개).

---

## 8. 도구 권한 울타리

**새 권한엔진 안 만듦.** 각 하네스의 네이티브 권한을 설정으로 운전. Phase 3에서 도구 쓰는 하네스 = Claude Code 하네스(= 진짜 Claude **또는** 로컬LLM 백엔드, §6.1). 둘은 같은 하네스라 울타리 동일:

- 페르소나 `tools:` 선언 ∩ permissions.json `allow.tools[persona]` = **실제 허용 도구** → SpecialistAgent가 `--allowedTools`로 변환해 spawn args에 추가.
- 쓰기 도구(Bash/Write/Edit)는 `allow.writePaths` 폴더로 스코프(`--add-dir`/cwd). `denyPaths`(Engram repo·시스템)는 절대 금지 → 자기파괴·자기수정 차단(Phase 4 ③ 보류와 일치).
- **default-deny**: 허용목록에 없으면 거부. 사용자가 사전승인한 울타리 안에서만 자율(= DESIGN §3 "승인 게이트"를 *범위 사전승인*으로 충족).
- 읽기전용 웹도구(WebSearch/WebFetch)는 시스템 미변경이라 기본 저위험.
- **로컬LLM 백엔드 주의**: 같은 울타리가 걸리지만 작은 모델은 도구호출이 불안정 → 위험한 쓰기 작업은 신뢰성 높은 백엔드(진짜 Claude)로 라우팅 권고.
- **Gemini/Codex(네이티브 CLI)**: 자기 샌드박스 모델이 따로라 Phase 3에선 **텍스트 생성만**(도구 위임은 Phase 4에서 각자 네이티브 샌드박스로 배선).

---

## 9. Phase 4 seam 보존 (씨앗 §3 대조)

| seam | 본 설계에서 |
|---|---|
| #1 Orchestrator 유일 배정구 | 협업·회의 전부 Orchestrator 경유, 직접호출 경로 0 |
| #2 에이전트 stateless, 진실 SSOT | 상태는 TaskStore/위키, 에이전트 메모리에 미보유 |
| #3 run-state 스위치 자리 | 배정구 단일 지점 유지 → 후속 pause/resume 삽입점 확보 |
| #4 진전 = 블랙보드 관측 | TaskStore FSM·blackboard가 객관 관측점 |
| #5 작성자≠검증자 | Synthesizer 별도 호출(Phase 2 writer≠judge 결 유지) |
| #6 자기기만 차단 | denyPaths가 테스트·완성조건 파일 자가수정 차단(코드게이트 본체는 Phase 4) |

---

## 10. 테스트 전략 (기존 패턴)

- **FakeBrain**(기존)으로 결정론적 단위테스트: 분해·배정·종합·TurnBudget 소진·회의 라운드.
- **TaskStore**: FSM 전이(유효/무효), 동시쓰기 직렬화(KeyedLock) 회귀.
- **PersonaRegistry**: frontmatter 파싱, 누락·잘못된 brain 폴백.
- **권한 울타리**: tools 교집합·writePath 스코프·denyPath 거부 단위테스트(spawn args 검증).
- **두뇌**: 로직은 FakeBrain. ClaudeCliBrain env 주입(올바른 env가 spawn에 전달되는지) 단위테스트. 실 Gemini/Codex CLI + 실 Ollama 백엔드는 **opt-in 스모크**(미설치 시 skip — 기존 임베더 패턴).
- 실 `claude -p` 스모크 1회: 웹도구 켜진 채 1라운드 협업 + 회의 1회. (가능하면 Ollama 백엔드 스모크 1회 추가 — env 교체 동작 확인)

---

## 11. 안 짓는 것 (YAGNI 명시)

- run-state 제어 명령(pause/resume/stop) — 자리만.
- 자율 코드 검증 하드게이트(테스트·빌드 통과 강제) — Phase 4.
- self-modification — Phase 4 ③ 보류.
- Gemini/Codex(네이티브 CLI)의 도구 위임 — 텍스트 생성만. (로컬LLM은 Claude 하네스 밑이라 도구 가능)
- 별도 LocalBrain 어댑터 — 로컬LLM은 ClaudeCliBrain env 백엔드로 흡수(어댑터 안 만듦).
- InsightLayer(Phase 5)·위키 주기감사·골든질문(DESIGN "나중").

---

## 12. 구현 순서 (플랜 시퀀싱 가이드)

토대 먼저, 협업·회의는 그 위에:

1. **토대**: TaskStore(FSM+락) → ClaudeCliBrain env 확장(로컬LLM 백엔드) + BrainFactory + GeminiBrain/CodexBrain → PersonaRegistry → 권한 울타리.
2. **협업 코어**: SpecialistAgent → TurnBudget → Orchestrator 실체화(분해·배정·수집) → Synthesizer.
3. **회의**: MeetingEngine → `engram meeting` 명령 + Scheduler 배선.
4. **통합·회귀**: 전체 DI 배선, 실 claude 스모크, 회귀 스위트.

---

## 13. 미해결(플랜 단계에서 확정)

- 작업 티켓 정확한 스키마(blackboardRef 형식).
- GeminiBrain·CodexBrain 출력 이벤트 파싱 세부(각 CLI 포맷). (로컬LLM은 Claude stream-json 재사용 — 파서 불필요)
- 로컬LLM 백엔드 모델 tier env 매핑 기본값(ANTHROPIC_DEFAULT_*_MODEL) + 권장 모델.
- 회의 종합 라운드 수 기본값·TurnBudget 기본값.
- 권한 울타리를 Claude 네이티브 settings 파일로 쓸지 spawn 플래그로 직접 줄지(둘 다 가능).
- 8팀 페르소나 본문 실내용(사용자 입력 필요할 수 있음).
