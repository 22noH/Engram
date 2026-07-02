# Phase 6b-3-2 — 자가 스케줄(스스로 재개 예약) 설계

작성일: 2026-07-02
상태: 설계 확정(6b3-2). 상위 맥락: [[2026-06-28-phase6-tag-design]] · [[2026-06-28-phase6b3-scheduling-design]](6b3-1 사용자 예약 토대).

## 1. 한 줄 정의

막히면 스스로 "나중에 다시" — 코딩이 STUCK/BUDGET으로 끝나거나 협업이 예외로 실패하면, Engram이 **스스로 1회(once) 재개 예약을 걸고** 채널에 알린 뒤, 그 시각에 사람 없이 이어서 한다. 재시작해도 예약은 살아남는다(6b3-1 영속 재사용).

## 2. 배경

- 6b3-1이 깔아둔 토대: `ScheduleStore`(schedules.json 영속) · `ScheduleService`(cron 등록·발사=`handleMention` 재주입→`postToChannel` 게시) · `SchedulerPort` · once 자기삭제. **발사·영속·목록·취소를 전부 재사용한다.**
- `codeRun`은 STUCK/BUDGET 시 `runState='paused'`를 남기고 종료 → 재개는 `running` 복원이 선행돼야 한다.
- 재실행은 새 세션으로 재분해하지만 이미 착지된 코드는 격리 브랜치에 커밋돼 있어 사실상 "이어서"다. 예산 카운터(`budgetSpent`)는 런당이라 재실행 시 새 예산.
- **rate-limit은 별도 감지 불요**: 두뇌 에러→티켓 실패 반복→진전 정체→STUCK으로 수렴하므로 STUCK 재개가 자동으로 커버(DESIGN §13.1 미해결② 해소 경로).

## 3. 범위

**6b3-2만:**
1. 코딩 종료(STUCK/BUDGET) 시 자동 재개 예약 — 무승인(이미 승인된 완성조건·대상 그대로 재실행).
2. 협업 예외 실패 시 자동 재시도 예약 — 같은 질문·같은 팀 재주입(재분류 없음).
3. 자동 재개 상한 **2회** — 그 뒤엔 "사람이 봐야 해요" 게시하고 멈춤.

**비범위:** 대화 중 두뇌 판단으로 임의 예약(사용자 결정으로 제외) · `STOPPED`(사용자 명시 정지) 재개(사용자 의지 존중) · in-memory MentionTracker 영속 · 실토큰 회계.

## 4. 설계

### 4.1 채택 접근

**A: 기존 예약 인프라에 "내부 명령 재주입".** 재개 예약을 `ScheduleStore`에 **once 엔트리**로 저장하되 task에 내부 명령(`resume <projectId> <attempt>` 등)을 넣는다. 발사는 기존 `fire→handleMention` 경로 그대로, `handleMention`에 escape hatch만 추가. 영속·재시작 생존·예약목록/취소가 공짜.
(기각: B 별도 재개 큐=영속·등록·취소 중복 구현, 반YAGNI · C 인메모리 setTimeout=재시작하면 증발, 자가스케줄 취지 위반.)

### 4.2 `resume-policy.ts` (신규, 순수 함수)

`src/agent-layer/resume-policy.ts` — now 주입으로 결정적 테스트.

```ts
type ResumeKind = 'STUCK' | 'BUDGET' | 'COLLAB';

// 상태별 재개 시각 → once용 5필드 cron('분 시 일 월 *')과 사람용 설명.
function computeResume(kind: ResumeKind, now: Date): { cron: string; human: string };
```

- `STUCK` → now + 60분 (`ENGRAM_RESUME_STUCK_MIN`)
- `BUDGET` → 다음날 아침 9시 (`ENGRAM_RESUME_BUDGET_HOUR`, 0~23) — 이미 지난 시각이면 다음날
- `COLLAB`(협업 예외 실패) → now + 30분 (`ENGRAM_RESUME_COLLAB_MIN`)
- env가 비숫자/범위밖(NaN, 분≤0, 시 0~23 밖)이면 기본값 폴백(`Number.isFinite` 가드 — Phase 1 백로그① 패턴).
- human 예: `1시간 뒤(14:32)` / `내일 아침 9시`.

### 4.3 재예약 트리거 (Orchestrator)

**`launchCoding(projectId, targetPath, threadKey, post, attempt = 0)`** — codeRun 결과 처리 확장:

- `SUCCESS` → 기존 그대로(예약 없음).
- `STOPPED` → 기존 그대로(사용자 정지 존중, 예약 없음).
- `STUCK` | `BUDGET`:
  - `attempt < 2` → `scheduler.add({ channelId: threadKey, cron, task: `resume ${projectId} ${attempt + 1}`, once: true }, { internal: true })` → 게시:
    (channelId=threadKey, threadId 생략 — Discord에서 스레드는 자체 channelId라 threadKey가 곧 게시 대상이고, 같은 스레드에서 `예약취소` 시 msg.userId와도 일치[6b-1 수렴 사실]. launchCollaboration도 동일.)
    `⏸ 막힘(진전 정체) — 1시간 뒤(14:32) 자동 재개 예약했어요 (#id, 재개 1/2). 멈추려면 @Engram 예약취소 id`
  - `attempt >= 2` → `⚠️ 두 번 재개해도 못 끝냈어요 — 사람이 봐야 해요 🙏 (세션 ...)`
  - `scheduler` 미주입(CLI/테스트) 또는 `add` null → 기존 종료 메시지로 강등(기능 저하만, 막다른 길 없음).
- catch(예외) 경로는 기존 그대로(코딩 예외는 재예약 없음 — 재예약은 정상 종료 status 기준만).

**`launchCollaboration(question, team, userId, threadKey, post, attempt = 0)`** — catch 확장:

- `attempt < 2` → `scheduler.add({ ..., task: `retry ${attempt + 1} ${team.join(',')} ${question}`, once: true }, { internal: true })` → 게시:
  `⏸ 작업 중 문제가 생겼어요 — 30분 뒤(15:02) 다시 해볼게요 (#id, 재시도 1/2). 멈추려면 @Engram 예약취소 id`
- `attempt >= 2` → 기존 실패 메시지 + `— 사람이 봐야 해요 🙏`.

attempt는 **task 텍스트에 인코딩** → 영속·재시작 생존 공짜, 예약목록에 그대로 노출(투명성).

### 4.4 재개 실행 — handleMention escape hatch 2개

기존 hatch들(`code `·`schedule ` 등)과 같은 자리에 추가:

- **`resume <projectId> [attempt]`**: `projects.get` → 없으면 "그 프로젝트를 못 찾았어요"; `approved` 아니면 "승인되지 않은 프로젝트예요". 통과 시 `setRunState('running')`(STUCK이 남긴 `paused` 복원) → ack 게시 → `launchCoding(projectId, project.targetPath, threadKey, post, attempt)`(attempt 기본 0, 비숫자면 0).
- **`retry <attempt> <팀CSV> <질문>`**: 파싱(attempt 비숫자면 hatch 미적용→일반 흐름) → ack 게시 → `launchCollaboration(질문, 팀, userId, threadKey, post, attempt)`.

둘 다 내부 발사용이지만 사용자가 직접 쳐도 동작한다(이미 승인된 프로젝트 재실행·팀 재주입뿐이라 권한 신설 없음).

### 4.5 `firingDepth` 가드 조정 (ScheduleService)

현재 `fire 중 add 전면 금지`는 "발사된 task가 classify를 거쳐 재예약되는 자기복제 루프" 차단용(6b3-1 Fix 2). 자가 재예약이 오차단되지 않게:

```ts
// SchedulerPort
add(input, opts?: { internal?: boolean }): ScheduleEntry | null;
```

- `internal: true`(Orchestrator 자가 재예약 전용) → firingDepth 가드 **우회**. cron 유효성 검증은 동일.
- 일반 add(classify 경유 doSchedule)는 기존 가드 유지.
- 안전 근거: 내부 예약은 attempt 상한(2회)으로 루프가 유계. `resume`/`retry` hatch는 classify를 안 거치므로 자기복제 경로 자체가 없음.

### 4.6 흐름 한 장

```
(코딩이 STUCK으로 종료, attempt 0)
 → launchCoding 결과 분기 → scheduler.add(once, 'resume prj_x 1', internal)
 → post("⏸ 막힘 — 1시간 뒤(14:32) 자동 재개 예약했어요 (#s3a, 재개 1/2)")
 (14:32, 프로세스 재시작 있었어도 schedules.json에서 복원)
 → fire → handleMention('resume prj_x 1') → hatch → runState=running → launchCoding(attempt=1)
 → 또 STUCK → 'resume prj_x 2' 예약 (재개 2/2)
 → 또 STUCK → "⚠️ 두 번 재개해도 못 끝냈어요 — 사람이 봐야 해요 🙏"
@Engram 예약목록 → "1. [#s3a] 32 14 2 7 * — "resume prj_x 1" (1회)"
@Engram 예약취소 s3a → 자동 재개 중단
```

### 4.7 오류 처리(상주 불사)

- 재예약 실패(`add` null·scheduler 미주입) → 기존 종료 메시지로 강등, 로그. 예약 못 걸었다고 상주가 죽지 않음.
- `resume` 대상 프로젝트 소실/미승인 → 안내 게시 후 반환(발사 경로의 try/catch는 6b3-1 그대로).
- 발사 시 `assertWritable`은 `codeRun` 진입부가 재검증(기존 심층 방어) — 예약 사이에 권한 설정이 바뀌어도 fail-closed.

### 4.8 테스트

- **resume-policy**(순수): STUCK/COLLAB 분 가산·BUDGET 다음날 시각(당일 지남/안 지남)·cron 5필드 형식·env 오버라이드·비숫자 env 폴백.
- **Orchestrator 재예약**(스텁 scheduler): STUCK→add(once·internal·task 형식) 호출 + 게시문에 예약 id·재개 횟수 · BUDGET→다음날 문구 · STOPPED/SUCCESS→add 미호출 · attempt=2→add 미호출+사람호출 게시 · scheduler 미주입→기존 메시지 강등.
- **resume hatch**: 승인 프로젝트→runState running 복원+launchCoding(attempt 전달) · 프로젝트 없음/미승인→안내 · 비숫자 attempt→0.
- **retry hatch**: 파싱→launchCollaboration(팀·attempt 전달) · 협업 실패 attempt<2→add 호출 · attempt=2→미호출+사람호출 게시.
- **ScheduleService**: 발사 중 `internal add` 통과 · 발사 중 일반 add 여전히 null(기존 가드 회귀).

### 4.9 영향 파일

- 수정: `src/agent-layer/orchestrator.ts`(launchCoding/launchCollaboration attempt+재예약 분기·hatch 2개) · `src/agent-layer/schedule-store.ts`(SchedulerPort.add opts) · `src/edge/schedule-service.ts`(가드 조건).
- 신규: `src/agent-layer/resume-policy.ts`(+spec).
- 무변경: bridge·main.ts·prompts·ScheduleStore 스키마(엔트리 필드 그대로)·Discord 어댑터·codeRun 본체.

## 5. 비고

- 재개 예약의 once cron은 "분 시 일 월 *" — 그 시각 전에 프로세스가 죽어 있다가 **그 시각 이후** 부팅하면 다음 해 같은 날짜까지 발사가 밀린다. `// ponytail: 부팅 시 지난 once 즉시발사(catch-up)는 후속 — 상주(서비스 등록) 전제라 창이 좁다.`
- 협업 재시도는 예외(throw)만 잡는다 — 협업이 "결과는 반환했지만 내용이 나쁨"은 성공으로 간주(품질 판정은 synthesizer 몫).
- 사용자 결정 4건: 트리거=코딩 재개+협업 재시도(대화 중 두뇌 임의 예약 제외) · 딜레이=상태별 차등 · 상한=2회 후 사람 호출 · 재개=무승인.
