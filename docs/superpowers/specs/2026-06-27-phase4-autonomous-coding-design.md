# Phase 4 — 자율 코딩 협업 (풀 구현 설계)

> 상위 기준선: [docs/DESIGN.md](../../DESIGN.md) §13.1 · 씨앗: [2026-06-27-phase4-autonomous-coding-seed.md](2026-06-27-phase4-autonomous-coding-seed.md) · 작성: 2026-06-27 · 상태: **설계 — 승인 완료, 구현 플랜 대기**
> 전제: Phase 0·1·2·3 완료. 이 설계는 Phase 3(Orchestrator 허브 + 블랙보드 협업 + 이종 두뇌 + 권한 울타리) 위에 얹힌다. 씨앗이 고정한 방향 5개·seam 6개를 구현 수준으로 구체화한다.

---

## 1. 개요 · 범위

**궁극 목표**: 사람이 양 끝(처음 설계 + 마지막 확인)에만 있고, 중간 전부를 에이전트 무리가 **공유 블랙보드를 경유해** 협업해 *코드 산출물*을 자율 생성한다. 협업은 협업대로, 코딩은 코딩대로.

**한 줄 그림**: `engram code <타깃경로> "목표"` → Engram이 완성조건 초안 → 사람 승인 → 분해=설계 → 스페셜리스트 N명이 한 체크아웃에서 동시 코딩 → Engram이 게이트(테스트·빌드·타입체크) 직접 실행 → 통과분만 블랙보드에 착지 → 완성조건 충족까지 반복 → 사람이 격리 브랜치 머지 결정.

**범위 안**:
- 코딩 오케스트레이션 루프(분해=설계 → 배정 → 코딩 → 게이트 → 착지/수정 → 반복)
- 검증 게이트 2층(하드 바닥: 테스트·빌드·타입체크 / 소프트: 리뷰어)
- 코딩 스페셜리스트(도구 울타리로 타깃 브랜치에 코드 작성)
- 저장: 진행상태(TaskStore 확장, 완료 시 삭제) + findings(기존 위키 재사용, 보존) + 코드(타깃 git 격리 브랜치)
- 완성조건: Engram 초안 → 사람 승인 게이트
- run-state 제어(running/paused/stopped) + `engram pause/resume/stop`
- stuck 감지(진전 멈춤) + 예산 상한(선택)

**범위 밖(미래)**:
- self-modification(자기 소스 수정·재배포) — §2-③ 명시 보류, 별도 Phase
- sparse-checkout / worktree 격리 — 옵션 레버로 자리만(§7.3)
- Gemini/Codex 네이티브 코딩 하네스 도구 위임 세부(필요 시 후속)
- InsightLayer(Phase 5)

---

## 2. 확정된 결정 (Decision Ledger)

| # | 영역 | 결정 | 근거 |
|---|---|---|---|
| ③ | 대상 범위 | **외부 프로젝트만**. 자기 소스 수정 제외 | 씨앗 ③A. 자기파괴 회피 |
| ① | 검증 게이트 | **2층**: 하드 바닥(테스트·빌드·타입체크) + 소프트(리뷰어) | 씨앗 ①C. 기계가 판정 |
| ④ | 메시지 | **블랙보드 stigmergy**. 에이전트 직접 대화 0 | 씨앗 ④B. Phase 3 seam #1·#4 |
| ② | resume | **진전·예산만 상한**. 시간/횟수 상한 없음 | 씨앗 ②C′ |
| — | 제어 | **run-state 스위치 하나**(stop·rate-limit·stuck·예산 통합) | 씨앗 |
| A | 진행상태 저장 | **TaskStore 확장**(부모 세션+자식 티켓). 완료 시 삭제 | 사용자 결정. FSM·락·관측성 재사용 |
| B | findings 저장 | **기존 위키+RAG 재사용**(프로젝트 네임스페이스). 보존 | 사용자 결정. 새 엔진 ❌ |
| C | 코드 위치 | **타깃 repo 격리 브랜치**. 팀 main 무손상, 사람이 머지 | 사용자 결정. 오염 0 |
| D | 완성조건 | **Engram 초안 → 사람 승인**(시작 게이트). 게이트 명령도 동일 | 사용자 결정 |
| E | 병렬 모델 | **공유 체크아웃 한 벌 + 분할로 충돌 회피 + 게이트가 안전망**. worktree 격리는 옵션 | 사용자 결정. 디스크 0 |
| F | 동시성 | **프로젝트별 다이얼**(N). 거대 repo는 N=1(추가 디스크 0) | 사용자 결정 |
| G | 재작업 촉발 | **객관 신호(게이트 빨강·리뷰어 거부·완성조건 미충족) → Orchestrator 티켓**. 에이전트 자율반응 ❌ | 사용자 결정. 수렴 보장 |

---

## 3. 아키텍처 — 컴포넌트

```
Edge
 ├ CliGateway(기존) + engram code / pause / resume / stop (신규)
 └ (회의/digest 기존 유지)

AgentLayer
 ├ Orchestrator(기존, 확장)   유일 배정구(seam #1).
 │     └ codeRun(projectRef): 코딩 루프 구동(분해=설계→배정→게이트→착지/수정→반복)
 │        run-state 스위치를 배정구에 둠(seam #3)
 ├ CodingSpecialist           제네릭 코딩 워커. (persona, brain, fence) 주입, stateless.
 │                            Phase 3 SpecialistAgent 패턴 + 도구 울타리 spawnFlags 실배선
 ├ VerificationGate           Engram이 직접 실행(에이전트 말 안 믿음). 종료코드 판정
 │                            하드 바닥: 테스트·빌드·타입체크 명령 실행
 ├ ReviewerAgent              소프트 위층(작성자≠검증자). 추가 거부만, 통과강제 불가
 ├ StuckDetector              K라운드 연속 블랙보드 무변화 → 사람 알림
 ├ Synthesizer/TurnBudget/Semaphore(기존 재사용)
 └ ReaderAgent/IngesterAgent/PersonaRegistry/PermissionFence(기존)

KnowledgeCore
 ├ TaskStore(기존, 확장)       coding 세션(부모) + 티켓(자식). 진전 관측점(seam #4)
 ├ ProjectStore(신규)          프로젝트 config: 타깃 경로·브랜치·게이트명령·writePaths·N·예산·완성조건
 │                            runtime/config 에 보관(타깃 repo 미오염)
 ├ CodingGit(신규)             타깃 repo git 운전: 브랜치 생성·커밋·통합 머지·정리
 │                            Phase 0 WikiGit 패턴 재사용(경로만 타깃)
 └ WikiEngine/RagStore(기존)   findings = 프로젝트 네임스페이스(`projects/{id}`)로 격리·검색·보존
```

핵심: **새 권한엔진·새 위키엔진 안 만듦.** Phase 3 PermissionFence·Phase 0 WikiEngine/RagStore/WikiGit·Phase 3 TaskStore를 확장·재사용한다.

---

## 4. 코딩 루프 (심장)

코딩 작업 1건 = 코딩 세션 1개 = TaskStore 부모 레코드 1개(+ 자식 티켓 N개).

```
0  시작     engram code <타깃경로> "목표"
            Orchestrator가 두뇌 1콜로 완성조건 초안 + 게이트 명령 추정
            → 사람 승인(시작 게이트). 승인분이 ProjectStore에 고정(seam #6 정답지).
            타깃이 Engram repo면 거부(denyPaths, 자기수정 차단 ③).
            CodingGit이 타깃 repo에 격리 브랜치 생성.

1  분해=설계 Orchestrator가 목표를 "안 겹치는 영역"으로 분할 → 티켓 발급
            티켓 = { id, area, instruction, blackboardRef, status }  ← 직접 호출 ❌
            (간단하면 분해 생략 → 단일 티켓)

2  코딩     CodingSpecialist × N 동시 실행(공유 체크아웃, 동시성 N=다이얼)
            · Semaphore(기존): 동시 호출 수 제한
            · TurnBudget(기존): 세션 총 호출 상한
            · 각자 분할된 영역에 코드 작성 → "다 했음" 보고. 서로 대화 0.

3  게이트   Engram(VerificationGate)이 직접 실행 — 에이전트 자기보고 불신.
            하드 바닥: 테스트 + 빌드 + 타입체크 명령 → 종료코드.
            · 초록 → CodingGit이 통합 브랜치로 머지 + 게이트 재실행 → 착지(커밋).
                     티켓 status=SUCCESS, 블랙보드 기록(=진전).
            · 빨강/충돌 → Orchestrator가 수정 티켓 발급("이 충돌/실패 풀어라" + 실패출력)
                     → 재개발(2로 되돌림). 충돌은 정상, 진전하는 한 무제한.

4  리뷰     ReviewerAgent(작성자≠검증자, seam #5)가 착지분을 완성조건·설계 관점 검토
            → 미충족이면 *티켓 추가만*(거부 OK, 통과강제 불가, 빨간 게이트 못 덮음).

5  반복/종료 완성조건(승인된 테스트) 전부 초록 + 리뷰어 OK → 세션 SUCCESS.
            findings는 위키 네임스페이스에 보존. 진행상태(TaskStore 레코드)는 삭제.
            사람이 격리 브랜치 보고 머지 결정(마지막 확인).

비정상 종료:
  · stuck   K(기본 2~3)라운드 연속 블랙보드 무변화 → 사람 알림(§6).
  · 예산    토큰/비용 천장 초과(사용자가 정했으면) → 배정 멈춤 + 사람 알림.
  · stop    사람이 engram stop → 배정 멈춤(§6).
```

**충돌·재작업의 수렴(결정 G)**: "B 착지 후 A의 코드가 깨짐"은 *게이트 빨강*이라는 객관 신호로 잡혀, Orchestrator가 수정 티켓을 낸다. 에이전트가 칠판을 실시간 구경하며 자율 반응하는 게 아니라(→ 무한 루프), *신호 충족까지만* 재작업이 발생 → 게이트 초록 + 완성조건 충족 시 멈춤.

---

## 5. 데이터 모델

### 5.1 TaskStore 확장 — 코딩 세션 + 티켓

기존 `TaskRecord`(Phase 3)를 코딩용으로 확장. FSM(`PENDING→RUNNING→SUCCESS|FAILED`)·KeyedLock·관측성 그대로 재사용.

```jsonc
// 부모: 코딩 세션
{
  "id": "task_…_coding",
  "kind": "coding",                       // 신규 kind
  "status": "PENDING|RUNNING|SUCCESS|FAILED",
  "question": "<목표>",
  "projectRef": "<ProjectStore id>",
  "tickets": [                            // 자식 티켓(블랙보드의 코딩판)
    { "id": "tk1", "area": "src/auth", "instruction": "…",
      "status": "PENDING|RUNNING|SUCCESS|FAILED",
      "attempts": 0, "gate": { "pass": false, "output": "…" } }
  ],
  "progress": { "landed": 0, "criteriaMet": 0, "criteriaTotal": 0 },  // seam #4 관측점
  "result": "<요약>" | null,
  "createdAt": "ISO", "updatedAt": "ISO"
}
```

- **진전(progress)** = 게이트 통과 착지 수 + 완성조건 충족 수. StuckDetector가 이 값의 *라운드 간 변화*를 본다.
- 티켓 동시 쓰기 = 기존 KeyedLock(키=부모 레코드 id)으로 직렬화. **새 락 안 만듦.**
- 완료 시 레코드 파일 삭제(진행상태=일회용). findings는 위키에 남음.
- *티켓 정확한 필드(blackboardRef 형식 등)는 플랜에서 확정.*

### 5.2 ProjectStore — 프로젝트 config (runtime/config, 타깃 미오염)

```jsonc
{
  "id": "proj_todo-app",
  "targetPath": "C:/Users/User/projects/todo-app",
  "branch": "engram/feat-login-fix",       // 격리 브랜치
  "gate": {                                // D: Engram 추정 → 사람 승인
    "test":  "npm test",
    "build": "npm run build",
    "typecheck": "npx tsc --noEmit"
  },
  "acceptanceCriteria": [                   // D: 승인된 완성조건(seam #6 정답지)
    "로그인 성공 시 토큰 발급",
    "잘못된 비밀번호는 401"
  ],
  "writePaths": ["C:/Users/User/projects/todo-app"],
  "concurrency": 3,                         // F: 다이얼. 거대 repo는 1
  "budget": { "tokens": null }              // 선택. null=진전 상한만
}
```

- **denyPaths**(전역 permissions.json): Engram repo·시스템 절대 금지 → 자기수정·자기파괴 차단(③, seam #6 자가수정 차단).
- 게이트 명령은 생태계 마커(package.json scripts 등)로 *추정*하되 최종은 사람 승인. *추정 규칙·미탐지 폴백은 플랜에서.*

### 5.3 findings 저장 — 위키 네임스페이스 재사용

- Phase 0 멀티유저 격리(`wiki/pages/{userId}/` + RagStore userId 컬럼)를 **프로젝트 네임스페이스**로 재사용: `wiki/pages/projects/{projectId}/`.
- 진행 중 알아낸 사실(아키텍처·결정·함정)을 위키 페이지로 → RAG 검색됨, 사람이 읽기 좋음, **보존**(자산).
- 새 위키 엔진 안 만듦. 삭제가 필요하면 기존 `unpublishPage`/`removePage`. (단 findings는 기본 보존; 진행상태만 삭제.)

---

## 6. 제어 — run-state 스위치 하나

- Orchestrator 배정구(유일 지점, seam #1·#3)에 `runState: running | paused | stopped` 스위치.
- **네 트리거가 같은 동작("배정 멈춤")으로 통합**:
  - **stop** — `engram stop`. 기본=일시정지(resume 가능). 강한 변형=취소(통째 폐기).
  - **rate-limit** — 두뇌 throttle. *진전하는 한 무제한 대기*(고장 아님). 비전("던지고 며칠 뒤 확인") 보존.
  - **stuck** — StuckDetector: K라운드 연속 progress 무변화 → paused + 사람 알림.
  - **예산** — budget.tokens 초과 → paused + 사람 알림.
- **Graceful stop**: 도는 티켓은 게이트까지 끝내고 다음 배정 보류(반쪽 상태 0 — 게이트 통과분만 착지하므로 칠판은 항상 일관).
- **Hard stop**: 도는 spawn 즉시 종료. 미검증분은 칠판 미반영 → 폐기, resume 때 그 티켓만 재배정.
- **resume** = 칠판(TaskStore) 다시 읽고 이어서. 진실이 SSOT에 있으니(seam #2) 거저 됨.
- 명령은 Phase 1 CliGateway 위에 얹음(`engram pause/resume/stop`).
- *스위치의 정확한 구현 위치(Semaphore와 결합 방식)는 플랜에서.*

---

## 7. 병렬 실행 모델 (결정 E·F)

### 7.1 기본 = 공유 체크아웃 한 벌

- 스페셜리스트 N명이 **한 체크아웃**(타깃 격리 브랜치)에서 동시 작업. 복사 0 → 거대 repo도 추가 디스크 0.
- **분할 설계**(§4-1)가 에이전트를 서로 다른 파일에 배치 → 충돌 회피가 1차 방어.
- 그래도 같은 파일 충돌 시 → **게이트가 깨짐을 잡고 → 수정 티켓**(§4-3)이 2차 안전망.

### 7.2 동시성 다이얼 (F)

- `ProjectStore.concurrency`(N)가 디스크/속도 트레이드오프를 운전.
- **N=1**: 순차. 한 체크아웃에서 한 명씩 → 충돌 자체가 불가, 추가 디스크 0(거대 repo 안전 기본).
- **N>1**: 공유 체크아웃에서 동시 → 분할+게이트로 충돌 처리.

### 7.3 격리 옵션 (자리만)

- "충돌 위험 큰 작업"엔 worktree 격리를 *옵션*으로 켤 수 있게 CodingGit에 자리만 둔다.
- sparse-checkout(부분 체크아웃)은 **안 짓는다** — 부분만 보면 연결성을 몰라 오류·게이트 깨짐. 명시 폐기.
- // ponytail: worktree 격리는 옵션 레버. 공유 체크아웃+분할+게이트로 충분하면 안 켬.

---

## 8. 검증 게이트 (2층)

### 8.1 하드 바닥 (양보 불가) — Engram이 직접 실행

- VerificationGate가 `ProjectStore.gate`의 테스트·빌드·타입체크 명령을 spawn → **종료코드**로 판정.
- 에이전트의 "통과했어요" 자기보고를 *믿지 않는다*(환각·거짓 차단). 기계가 진실.
- 리뷰어가 빨간불을 *초록으로 못 덮는다*.

### 8.2 소프트 위층 — ReviewerAgent (작성자≠검증자, seam #5)

- 착지한 변경을 완성조건·설계 의도 관점에서 검토. Phase 2 writer≠judge / Phase 3 Synthesizer 별도호출 패턴 유지.
- **추가 거부만 가능**(새 수정 티켓 발급). *통과 강제 불가.*

### 8.3 테스트 없는 프로젝트 → 특성화 테스트 (C-2)

- 코드 변경 전, 에이전트가 **특성화 테스트**를 먼저 깐다 = 현재 동작을 *맞든 틀리든* 박제 → 회귀(의도치 않은 깨짐) 감지 그물.
- greenfield(박제할 동작 없음) → 승인된 완성조건이 정답지, 에이전트가 테스트로 번역.
- **알려진 한계(수용)**: 특성화는 기존 버그까지 박제. Phase 4 약속은 "기존보다 나쁘게 안 만든다"이지 "잠복 버그 수정"이 아님.
- *C-2 자동생성에 사람 흘끗검토(약한 게이트)를 붙일지는 플랜에서.*

### 8.4 자기기만 차단 (seam #6)

- 완성조건·특성화 테스트를 *바꾸려면* 그 변경이 **사람의 완성조건으로 추적**돼야 한다. 에이전트 말만으론 갱신 불가.
- 구현: 완성조건은 ProjectStore의 승인된 값(불변), 변경은 사람 재승인 경유. 테스트 파일이 denyPaths 밖이라 에이전트가 물리적으로 쓸 순 있으나, *완성조건 테스트의 변경*은 게이트 정답지 변경으로 간주 → 사람 승인 필요(플랜에서 메커니즘 확정).

---

## 9. 도구 울타리 (Phase 3 PermissionFence 확장)

- **CodingSpecialist는 Bash/Write/Edit 사용** = Claude Code 하네스 위에서 도는 두뇌(진짜 Claude 또는 로컬LLM 백엔드, Phase 3 §6).
- 쓰기 도구는 `writePaths`(타깃 브랜치)로 스코프(`--add-dir`/cwd). Phase 3 spawnFlags 산출을 **실배선**(Phase 3 SpecialistAgent는 텍스트 전용이라 미배선이었음).
- **denyPaths = Engram repo + 시스템** 절대 금지 → 자기파괴·자기수정 구조적 차단(③, seam #6).
- **게이트 실행은 에이전트 도구가 아니라 VerificationGate가 직접**(객관성 — §8.1).
- Gemini/Codex(네이티브 CLI)는 Phase 3대로 텍스트 협업까지. 자기 코딩 하네스 도구 위임은 범위 밖.

---

## 10. Phase 3 seam 보존 (씨앗 §3 대조)

| seam | 본 설계에서 |
|---|---|
| #1 Orchestrator 유일 배정구 | 코딩 루프 전부 Orchestrator.codeRun 경유, 직접호출 0 |
| #2 에이전트 stateless, 진실 SSOT | 상태는 TaskStore/위키/타깃 git, 에이전트 메모리 미보유. resume 거저 |
| #3 run-state 스위치 자리 | 배정구에 runState 스위치 실장(§6) |
| #4 진전 = 블랙보드 관측 | TaskStore.progress(landed·criteriaMet)가 객관 관측 → stuck 감지 |
| #5 작성자≠검증자 | ReviewerAgent 별도호출(Phase 2 writer≠judge 결 유지) |
| #6 자기기만 차단 | 완성조건 불변+denyPaths가 테스트·완성조건 자가수정 차단(§8.4) |

---

## 11. 테스트 전략 (기존 패턴)

- **FakeBrain**(기존)으로 결정론적 단위테스트: 분해·배정·게이트 분기(초록/빨강/충돌)·수정 티켓 재발급·stuck 감지·run-state 전이.
- **VerificationGate**: 종료코드 0=통과/비0=실패 판정, 명령 미설정 폴백, 에이전트 자기보고 무시 회귀.
- **TaskStore 확장**: 코딩 세션 FSM·티켓 동시쓰기 직렬화(KeyedLock)·progress 관측·완료 시 삭제.
- **CodingGit**: 브랜치 생성·커밋·통합 머지·충돌 표면화·정리(임시 디렉터리 fixture).
- **PermissionFence**: 코딩 도구 spawnFlags 실배선(writePaths 스코프·denyPaths 거부·Engram repo 거부).
- **StuckDetector**: K라운드 무변화 감지·진전 시 리셋.
- 실 스모크 1회(opt-in): 작은 외부 샘플 repo에 1티켓 코딩 → 게이트 통과 → 착지 → 사람 머지 시뮬. (미설치 시 skip — 기존 임베더/CLI 패턴.)

---

## 12. 안 짓는 것 (YAGNI 명시)

- self-modification(자기 소스 수정) — ③ 보류, 별도 Phase.
- sparse-checkout / 부분 체크아웃 — §7.3 명시 폐기(연결성 상실→오류).
- worktree 격리 — 옵션 자리만, 기본은 공유 체크아웃.
- 에이전트 직접 대화 — 블랙보드 stigmergy(④).
- 에이전트 실시간 자율 반응 루프 — 객관 신호+티켓으로만 재작업(G).
- Gemini/Codex 코딩 하네스 도구 위임 — 범위 밖.
- 새 권한엔진·새 위키엔진·새 락 — 전부 기존 재사용.
- 시간/재개횟수 상한 — 진전·예산만(②).

---

## 13. 구현 순서 (플랜 시퀀싱 가이드)

토대 먼저, 루프는 그 위에:

1. **토대**: ProjectStore(config) → TaskStore 코딩 확장(세션+티켓+progress) → CodingGit(브랜치·커밋·머지·정리) → VerificationGate(명령 실행·종료코드).
2. **워커·게이트층**: CodingSpecialist(PermissionFence spawnFlags 실배선) → ReviewerAgent → 특성화 테스트 경로(§8.3).
3. **루프 코어**: Orchestrator.codeRun(분해=설계 → 배정 → 게이트 → 착지/수정 티켓 → 반복) → 완성조건 승인 게이트(§4-0).
4. **제어**: run-state 스위치(§6) → StuckDetector → 예산 → `engram code/pause/resume/stop` 배선.
5. **findings**: 위키 프로젝트 네임스페이스 배선(§5.3).
6. **통합·회귀**: 전체 DI 배선, 실 샘플 repo 스모크, 회귀 스위트.

---

## 14. 미해결(플랜 단계에서 확정)

- 티켓 정확한 스키마(blackboardRef 형식, area 표현).
- 게이트 명령 추정 규칙(생태계 마커) + 미탐지 폴백 UX.
- run-state 스위치 구현 위치(Semaphore와 결합 방식).
- 완성조건 테스트 변경의 "사람 추적" 메커니즘 정확한 형태(§8.4).
- C-2 특성화 자동생성에 사람 흘끗검토를 붙일지.
- 분해=설계가 영역 분할을 산출하는 프롬프트·티켓 발급 형식.
- StuckDetector K 기본값·예산 회계 단위(토큰 출처).
- CodingGit 통합 머지 순서·충돌 표면화 방식.

---

## 15. 한 줄 요약

> **외부 프로젝트를(③), 공유 칠판 경유로 협업(④)해 한 체크아웃에서 동시 코딩(E)하고, Engram이 직접 돌리는 하드 게이트로 검증(①)하며, 통과분만 착지시켜 완성조건 충족까지 반복하고, 진전이 멈출 때만 사람을 부르며(②), 한 스위치로 멈춘다(제어). 진행상태는 끝나면 버리고 findings는 남긴다.**
