# Phase 6b-3-1 — `@Engram` 사용자 예약(스케줄) 설계

작성일: 2026-06-28
상태: 설계 확정(6b3-1). 상위 맥락: [[2026-06-28-phase6-tag-design]] · [[2026-06-28-phase6b-continuity-design]](6b-1 백그라운드).

## 1. 한 줄 정의

정해진 시간에 알아서 — `@Engram 매일 아침 9시에 서버비 정리해줘` → Engram이 예약을 영속 저장하고, 그 시간마다 저장된 일을 스스로 수행해 채널에 게시한다. 컴퓨터를 껐다 켜도 예약은 살아남는다.

## 2. 배경

기존 `MeetingScheduler`(동적 cron: `SchedulerRegistry.addCronJob` + `cron` 패키지, `meetings.json` 영속, 상주 onModuleInit 등록)가 이미 있다. 그 패턴을 재사용한다. 발사가 "나중에"(사용자 없을 때) 일어나므로 라이브 메시지 핸들(`ReplyTarget`)로는 되쏠 수 없어, **채널 ID로 게시하는 새 포트 메서드**가 필요하다. 발사 시 실행은 6b-1의 `handleMention`을 재사용(저장된 자연어 task를 재주입).

## 3. 범위

**6b3-1만:** 사용자가 예약("매일 9시에 X") → 영속 → 발사 시 실행·채널 게시 + 예약 목록/취소.

**비범위:** 자가 스케줄(두뇌가 스스로 예약)=6b3-2 · run-state 메신저 제어 · in-memory MentionTracker 영속(스케줄만 영속, 진행중 작업은 여전히 재시작 소실).

## 4. 설계

### 4.1 채택 접근

**A: main.ts 결선 `ScheduleService`(plain) + Orchestrator에 setter 주입.** 메신저를 DI 밖에 두는 6a 결정과 일관. 서비스가 cron 등록·발사·영속을 담당하고, Orchestrator는 `schedule` 의도를 서비스 포트에 위임(허브 책임 최소). 상호 참조는 main.ts 런타임 결선(순환 아님).

### 4.2 `MessengerPort.postToChannel` (신규 포트 메서드)

```ts
postToChannel(channelId: string, text: string, threadId?: string): Promise<void>;
```
- Discord: `threadId ?? channelId`를 `client.channels.fetch(id)` → 텍스트 채널이면 `.send(text)`. 채널 없거나 전송불가 → 로그 후 무시(상주 불사).
- FakeMessenger: `channelPosts: Array<{ channelId; threadId?; text }>`에 캡처(테스트).
- 기존 `reply(target, text)`는 무변경(라이브 멘션 답신용 유지).

### 4.3 `ScheduleStore` (영속)

`runtime/config/schedules.json`. 엔트리:
```ts
interface ScheduleEntry {
  id: string;         // 짧은 고유 id
  channelId: string;  // 발사 시 게시 대상
  threadId?: string;
  cron: string;       // 표준 5필드 cron
  task: string;       // 발사 시 재주입할 자연어 지시
  once?: boolean;     // true면 1회 발사 후 자기 삭제
  createdAt: string;
}
```
`class ScheduleStore`(plain, configDir 주입): `load()`·`all(): ScheduleEntry[]`·`add(input): ScheduleEntry`(id 생성·저장)·`remove(id): boolean`(저장)·`byChannel(channelId): ScheduleEntry[]`. 파일 없음/깨짐 → 빈. 쓰기마다 원자적 저장.

### 4.4 `SchedulerPort` (Orchestrator가 보는 인터페이스)

```ts
interface SchedulerPort {
  add(input: { channelId: string; threadId?: string; cron: string; task: string; once?: boolean }): ScheduleEntry | null; // 잘못된 cron → null
  list(channelId: string): ScheduleEntry[];
  remove(id: string): boolean;
}
```

### 4.5 `ScheduleService` (plain, main.ts 결선 — SchedulerPort 구현)

의존: `{ handleMention }`(Orchestrator), `MessengerPort`, `SchedulerRegistry`, `ScheduleStore`, `PinoLogger`.
- `start()`: `store.load()` → 각 엔트리 `register()`.
- `register(e)`: cron 유효성 검증(`new CronTime(e.cron)` throw 시 실패) → `new CronJob(e.cron, () => this.fire(e))` → `registry.addCronJob('sched-'+e.id, job)` → `job.start()`.
- `fire(e)`: 저장된 task를 재주입 —
  ```
  handleMention(
    { text: e.task, userId: e.channelId },
    (t) => port.postToChannel(e.channelId, t, e.threadId),
    e.threadId ?? e.channelId,
  ).catch(로그)
  if (e.once) this.remove(e.id)
  ```
  `// ponytail: 재주입=완전자율(협업/코딩 뭐든). 매일 협업이면 매일 토큰 — 비용은 사용자 cron 책임.`
- `add(input)`: cron 유효성 → 실패 시 `null`. `store.add` → `register` → 반환.
- `remove(id)`: `registry.deleteCronJob('sched-'+id)`(없으면 무시) + `store.remove`.
- `list(channelId)`: `store.byChannel`.

### 4.6 Orchestrator 확장

- `private scheduler?: SchedulerPort; setScheduler(s): void`.
- classify에 `schedule` 종류 추가 → `{ kind:'schedule'; cron?: string; task?: string; once?: boolean }`. 두뇌가 "매일 9시"→`0 9 * * *` 변환, task=할 일. (chat/collaborate/code는 그대로.)
- handleMention 분기(상태·pending 다음, 일반 escape hatch 사이):
  - `예약목록` | `schedules` → `post(formatSchedules(scheduler.list(channelId)))`(없으면 "예약이 없어요").
  - `예약취소 <id>` | `schedule cancel <id>` → `scheduler.remove(id)` → post 결과.
  - escape hatch `schedule <cron> <task>` → `scheduler.add`.
  - classify `schedule` → scheduler 없으면 "예약 기능이 준비되지 않았어요"; `add`가 `null`(잘못된 cron) → "언제인지 잘 모르겠어요, 다시 말해줄래요?"; 성공 → "네, 예약했어요 📅 (예약 #id, cron)".
  - channelId=`msg.userId`, threadId=`threadKey !== msg.userId ? threadKey : undefined`.
- `scheduler` 미주입(CLI/테스트) → 예약 분기는 안내 후 반환(막다른 길 없음).

### 4.7 main.ts 결선

포트 생성·`bindMessenger` 다음:
```
const store = new ScheduleStore(paths.getConfigDir());
const scheduler = new ScheduleService(app.get(Orchestrator), port, app.get(SchedulerRegistry), store, logger);
app.get(Orchestrator).setScheduler(scheduler);
await scheduler.start();
```
`SchedulerRegistry`는 `ScheduleModule.forRoot()`(EdgeModule)로 이미 사용 가능. 포트 없으면(메신저 비활성) 스케줄도 결선 안 함(예약 발사가 게시할 곳 없음).

### 4.8 흐름 한 장

```
@Engram 매일 아침 9시에 서버비 정리해줘
 → classify schedule{cron:'0 9 * * *', task:'서버비 정리해줘'}
 → scheduler.add(channelId, cron, task) → 저장 + cron 등록
 → post("네, 예약했어요 📅 (예약 #a1, 0 9 * * *)")
 (매일 9시)
 → fire → handleMention('서버비 정리해줘', postToChannel(channel)) → collaborate → 채널 게시
@Engram 예약목록 → "1. [#a1] 0 9 * * * — 서버비 정리해줘"
@Engram 예약취소 a1 → "취소했어요"
```

### 4.9 오류 처리(상주 불사)

- 잘못된 cron → `add` null → 안내(등록 안 함).
- `fire`의 handleMention은 자체 백그라운드 try/catch(6b-1) + `.catch` 로그. postToChannel 실패 → 로그.
- schedules.json 깨짐 → 빈(예약 없음). 부팅 register 중 개별 실패 → 그 엔트리만 스킵·로그(나머지 정상).

### 4.10 테스트

- **FakeMessenger.postToChannel** + `channelPosts` 캡처.
- **ScheduleStore**(tmp dir): add(id 부여)·byChannel 필터·remove·persist→load 왕복·깨짐→빈.
- **ScheduleService**(fake orchestrator/port/registry, tmp store): add 잘못된 cron→null·유효→registry.addCronJob 호출·`fire`가 handleMention을 postToChannel 바인딩과 호출·once→발사 후 remove·remove→deleteCronJob+store.
- **Orchestrator schedule 분기**(스텁 scheduler): classify schedule→add 호출·add null→안내·예약목록→list 집계·예약취소→remove·scheduler 미주입→안내.
- **Discord postToChannel**은 네트워크 글루 — 스모크만.

### 4.11 영향 파일

- 수정: `src/edge/messenger/messenger.port.ts`(postToChannel) · `fake-messenger.ts`(구현+캡처) · `discord.adapter.ts`(구현, 스모크) · `src/agent-layer/orchestrator.ts`(classify schedule·handleMention 분기·setScheduler·SchedulerPort/ScheduleEntry import) · `src/main.ts`(결선) · `prompts/triage.md`(schedule).
- 신규: `src/agent-layer/schedule-store.ts`(+spec, ScheduleStore·ScheduleEntry·SchedulerPort 타입) · `src/edge/schedule-service.ts`(+spec, ScheduleService).
- 무변경: bridge·CoreMessage·codeRun·collaborate·MentionTracker.

## 5. 비고

- 발사 task가 다시 예약어("매일"…)를 품으면 이론상 재예약 루프 가능 — 실무상 task는 구체 지시라 무시(`// ponytail: 필요 시 fire 경로에 schedule 억제 플래그`).
- cron은 표준 5필드. 두뇌가 자연어→cron. 초 단위·타임존은 비범위(로컬 타임존).
