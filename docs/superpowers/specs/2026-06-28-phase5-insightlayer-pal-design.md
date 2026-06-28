# Phase 5 — InsightLayer + 운영(PAL) (풀 구현 설계)

> 상위 기준선: [docs/DESIGN.md](../../DESIGN.md) §5.4(InsightLayer) · §10(PAL) · §13 로드맵 Phase 5 · 작성: 2026-06-28 · 상태: **설계 — 사용자 리뷰 대기**
> 전제: Phase 0~4 완료. PAL 기초 상주 위생(lru-cache·pino·p-limit·작업경계 try/catch)은 Phase 0부터 깔려 있고, 여기서 운영 마감(서비스 등록·감시자·메모리 감시)까지 완성한다.

이 한 Phase에 성격이 다른 두 서브시스템이 묶인다(사용자 결정: 한 spec). 의존성은 없고, **공통 토대(`state/` 데이터 분리, in-process `@Cron`/`@Interval`, `config/*.json`, BrainProvider 포트, main.ts 상주 vs cli.ts 원샷)** 위에 각각 올라탄다.

- **A. InsightLayer** — 사용 기록을 읽어 매일 한 번 정리하고, 다음 답변에 참고로 주입하는 코어 기능 레이어.
- **B. 운영(PAL)** — Engram을 24/7 안 죽게: OS 서비스 등록 + 멈춤 감지 감시자 + 외부 알림 + 메모리 위생 감시.

---

## 1. 확정된 결정 (Decision Ledger)

| # | 영역 | 결정 | 근거 |
|---|---|---|---|
| A1 | 인사이트 성격 | **결정적 메트릭 + 두뇌 서술 요약** | 검증·재현성(메트릭) + 통찰(두뇌). 사용자 결정 |
| A2 | 리포트 저장 | **`state/insights/{date}.json` (위키 밖)** + `engram insights` 조회 | 위키 비대화·승인게이트 원칙 보존. 코드/데이터 분리. 사용자 결정 |
| A3 | 응답 주입 | **항상 주입, 단 `참고용(답 근거는 위키)`로 구분** | 설계 §5.4 "상황 맥락 주입" + 답 오염 완화. 사용자 결정 |
| A4 | 메트릭 범위 | 질의 수 · 시간대 히스토그램 · 용어 빈도 TopN · **인용 위키 페이지 빈도** | 사용자 결정(페이지 순위 포함) |
| A5 | 인용 페이지 출처 | **대화 기록에 `sources?: string[]` 추가**(읽기 흐름에서 채움) | 인용 빈도 집계 전제. 작은 확장 |
| B1 | OS 범위 | **셋 다 구현**(Windows·Linux·macOS) | 사용자 결정. 단 Mac/Linux 실동작은 이 머신서 검증 불가(§5) |
| B2 | Windows 서비스 | **`node-windows` 의존성**(SCM 위탁) | 서비스 호스팅은 몇 줄로 안 됨 → 의존성 정당. 사용자 결정 |
| B3 | 감시자 | **별도 초경량 프로세스**(Nest·두뇌 0). heartbeat 파일 폴링 → 멈춤 시 강제종료 + 알림 | 설계 §10.2 "감시자는 거의 안 죽게". 사용자 결정 |
| B4 | 알림 채널 | **`config/alert.json` `{webhookUrl?, command?}` 설정형** | 코어 중립(채널은 사용자). 설계 §10.1 "알림 명령 실행" seam. 사용자 결정 |
| B5 | 메모리 감시 | **포함**(rss 추세 + 임계치 알림 + heap 스냅샷) | 설계 §10.3 "Phase 5서 완성". 사용자 결정 |

---

## 2. A. InsightLayer

### 2.1 한 줄 그림

`state/conversations/{user}/{day}.jsonl`(이미 존재) → **메트릭 집계(결정적)** → **두뇌 1콜 서술 요약** → `state/insights/{user}/{day}.json` → **다음 ReaderAgent 답변에 참고용 주입**. 매일 1회 `@Cron`(상주) 또는 `engram insights run`(수동).

### 2.2 컴포넌트

```
knowledge-core/insight/
 ├ metrics.ts          순수 함수. ConversationRecord[] → DayMetrics. 두뇌 0, 결정적.
 ├ insight-store.ts    state/insights/{user}/{day}.json 읽기/쓰기 + 최신 조회.
 ├ insight-reporter.ts 메트릭 + Q/A 묶음 → 두뇌 1콜 → 서술 리포트. DayInsight 영속.
 └ insight-context.ts  최신 DayInsight → 주입용 문자열(없으면 빈 문자열).

edge/
 └ insight.scheduler.ts  @Cron(ENGRAM_INSIGHT_CRON, 기본 '0 4 * * *'). DigestScheduler 미러.

edge/cli.gateway.ts      engram insights [run] 분기 추가.
agent-layer/reader-agent.ts  buildPrompt에 InsightContext 주입(구분 섹션).
knowledge-core/conversation-store.ts  ConversationRecord에 sources?: string[] 추가.
```

### 2.3 데이터 형태

```ts
// metrics.ts — 결정적 집계
interface DayMetrics {
  date: string;                       // YYYY-MM-DD
  queryCount: number;
  hourHistogram: number[];            // 길이 24, 시간대별 질의 수
  avgQuestionLen: number;
  avgAnswerLen: number;
  topTerms: { term: string; count: number }[];   // 질문 토큰 빈도 TopN(불용어 제거)
  topPages: { slug: string; count: number }[];    // 인용 위키 slug 빈도 TopN
}

// insight-store.ts
interface DayInsight {
  date: string;
  metrics: DayMetrics;
  report: string;     // 두뇌 서술 요약(관심사·패턴·미해결)
}
```

- **토크나이즈**(topTerms): 소문자화 → 공백·구두점 분리 → 길이<2 토큰 컷 → 불용어셋 제거 → 빈도 정렬 TopN(기본 10). 한/영 혼용이라 형태소 분석 없이 단순 공백/구두점 기반. *ponytail: 단순 빈도 — 의미 군집은 두뇌 요약이 담당, 형태소 분석은 효용 측정되면.*
- **불용어**: 한/영 최소셋 상수(조사·관사·be동사 등). 모듈 상수로.

### 2.4 메트릭 입력 — 인용 페이지(A5)

현재 `ConversationStore.append`는 `{ts, question, answer}`만 저장 → 인용 slug 정보 없음. 확장:

- `ConversationRecord`에 `sources?: string[]`(인용 slug 목록) 추가. **옵셔널**이라 기존 줄과 하위호환(없으면 topPages에서 그 줄은 무기여).
- **확정된 최소 변경 경로**(코드 확인 결과):
  - append 지점은 **`Orchestrator.route()` 단 한 곳**(`orchestrator.ts:61`)이다. `route`는 `reader.handle(msg)`를 호출하고 답변 문자열만 받는다.
  - `ReaderAgent.handle`은 이미 `hits`(slug 보유)를 안다. 반환 타입을 바꿔 모든 호출처(CliGateway.ask·repl 등 문자열 기대)를 흔들지 말고, **옵셔널 콜백 `onSources?: (slugs: string[]) => void`** 를 `handle` 인자에 추가 → `route`만 그 콜백으로 slug를 받아 `append`에 실음. slug 불필요한 호출처는 콜백 생략(무영향).
  - `sources`는 옵셔널이라 기존 줄과 하위호환(없으면 topPages에서 무기여).

### 2.5 응답 주입(A3)

`ReaderAgent.buildPrompt`에 최신 인사이트를 **명시 구분 섹션**으로 추가:

```
# 참고용 사용자 맥락 (답의 근거 아님 — 근거는 아래 위키)
{InsightContext.latest()}   // 비면 이 섹션 자체를 생략

# 검색된 위키
...
# 질문
...
```

- `InsightContext.latest(userId)`: 최신 `DayInsight.report`(+선택적으로 topTerms 요약)를 짧게 반환. 인사이트 파일 없으면 `''` → 섹션 생략.
- ReaderAgent가 InsightContext를 **@Optional() 주입** → InsightLayer 없이도(테스트·초기) 동작.

### 2.6 스케줄 · CLI

- `InsightScheduler` `@Cron(resolveCron(process.env.ENGRAM_INSIGHT_CRON) ?? '0 4 * * *')` — DigestScheduler와 동일 패턴(상주 main.ts에서만 발화, cli.ts 원샷은 즉시 close). 다이제스트 03:00 뒤 04:00.
- `engram insights` → 최신 `DayInsight` 출력(없으면 안내).
- `engram insights run` → 지금 즉시 오늘치 생성(cron 안 기다림). 동시 실행은 드물지만, digest의 DigestLock처럼 가벼운 파일락 1개로 중복 생성 방지(선택 — 일 1회·수동이라 충돌 드묾; 구현 시 판단).

### 2.7 테스트

- `metrics.ts`: 순수 함수 — 샘플 ConversationRecord[]로 카운트·히스토그램·TopN·topPages 단위테스트(결정적).
- `insight-reporter.ts`: FakeBrain으로 리포트 생성·영속 검증.
- `insight-context.ts`: 인사이트 있음/없음 분기(빈 문자열).
- ReaderAgent: 주입 섹션 포함/생략 분기(@Optional 미주입 시 무동작).
- CLI 스모크: `insights` / `insights run`.

---

## 3. B. 운영(PAL)

### 3.1 한 줄 그림

**Engram(상주, 1분마다 심장박동 파일 갱신) ← 감시자(초경량 별도 프로세스, 멈춤 감지 시 강제종료 + 외부 알림) ← OS 서비스(부팅 자동시작·죽으면 재시작 담당).** + 상주 내부에 메모리 추세 감시.

### 3.2 컴포넌트

```
pal/supervisor/
 ├ supervisor.port.ts     install/uninstall/start/stop/status 인터페이스.
 ├ windows-supervisor.ts  node-windows로 Windows 서비스.
 ├ linux-supervisor.ts    systemd 유닛(.service) 생성 + systemctl.
 ├ macos-supervisor.ts    launchd plist 생성 + launchctl.
 └ supervisor.factory.ts  process.platform으로 선택.

pal/heartbeat.ts          HeartbeatEmitter — @Interval(60s), state/heartbeat 갱신(상주에서만).
pal/alerter.ts            config/alert.json {webhookUrl?, command?} 로드 → POST 또는 spawn.
pal/memory-monitor.ts     @Interval, rss 추세 + 임계치 → Alerter + v8 heap 스냅샷.

watchdog.ts (신규 진입점)  Nest 0·두뇌 0. heartbeat 폴링 → 멈춤 시 kill + Alerter.

edge/cli.gateway.ts       engram service install|uninstall|start|stop|status 분기.
```

### 3.3 서비스 등록(B1·B2)

`SupervisorPort`:

```ts
interface SupervisorPort {
  install(): Promise<void>;    // 부팅 자동시작 등록 + (가능 OS는) 재시작 정책
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<'running' | 'stopped' | 'not-installed'>;
}
```

- **Windows**: `node-windows`. 서비스가 `node dist/src/main.js`(상주)를 구동. SCM이 부팅 자동시작 + 죽으면 재시작 + 백오프 제공.
- **Linux**: systemd `.service` 유닛 문자열 생성 → `~/.config/systemd/user/`(user 단위) 또는 안내 후 시스템 단위. `Restart=always`·`RestartSec`·`WatchdogSec`(멈춤 감지 네이티브). `systemctl --user enable/start`.
- **macOS**: launchd plist 생성 → `~/Library/LaunchAgents/`. `KeepAlive`·`RunAtLoad`. `launchctl load/unload`.
- 팩토리: `process.platform` → `win32`/`linux`/`darwin`. 그 외 → 명확한 미지원 에러.
- CLI: `engram service <verb>`.

> **§10.1 표 정합**: 부팅 자동시작·죽으면 재시작·백오프는 셋 다 OS 네이티브. 멈춤 감지는 systemd만 네이티브(WatchdogSec), Windows/macOS는 §3.4 감시자가 메운다. "N번 실패 후 포기"·"실패 시 알림"의 부족분도 감시자가 통일.

### 3.4 심장박동 + 감시자(B3)

- **HeartbeatEmitter**(상주): `@Interval(60_000)` → `state/heartbeat`에 현재 epoch ms 기록(원자적 write). 상주(main.ts)에서만 등록 — 원샷 cli.ts는 무관.
- **watchdog.ts**(별도 프로세스, 의도적으로 바보같이 단순):
  1. 주기(예: 30s)로 `state/heartbeat` 읽기.
  2. `now - 기록시각 > STALE_MS`(예: 180s) → "멈춤" 판정.
  3. 멈춘 Engram PID 강제종료(→ OS 서비스가 재시작) — PID는 상주가 `state/engram.pid`에 기록.
  4. `STALE_MS` 후에도 heartbeat 미복구 → **Alerter로 외부 알림**.
  - Nest·DI·두뇌·임베더 전부 미사용. `fs` + `http`만. 빠른 재시도 1~2회 후 즉시 알림(설계 §10.2: 고정 장애는 재시도로 안 고쳐짐).
  - watchdog 자체도 서비스로 등록 가능(별도 경량 서비스) — 구현 플랜에서 "engram 서비스가 watchdog도 같이 띄우는지" 단순안 확정.

### 3.5 알림(B4)

- **Alerter**: `config/alert.json` 로드.
  - `webhookUrl` 있으면 → 그 URL로 POST(JSON `{event, message, ts}`). Discord/ntfy/generic 호환.
  - `command` 있으면 → spawn(메시지를 인자/stdin). 폰 알림 등 사용자 자유.
  - 둘 다 없으면 → 로그만(경고). 둘 다 있으면 둘 다.
- watchdog과 상주(메모리 감시) 양쪽이 같은 Alerter 로직 공유(watchdog은 Nest 없이 같은 순수 함수 재사용).

### 3.6 메모리 위생 감시(B5)

- **MemoryMonitor**(상주): `@Interval`(예: 5분) → `process.memoryUsage().rss` 샘플을 짧은 링버퍼에 기록.
  - 임계치(env `ENGRAM_RSS_LIMIT_MB`) 초과 → Alerter 경고 + `v8.writeHeapSnapshot()`로 `logs/heap-{ts}.heapsnapshot` 1회(원인 특정용, 쿨다운으로 폭주 방지).
  - 추세(청소 후 바닥값 상승)는 단순 휴리스틱(최근 N 샘플 단조 증가) → 로그 경고. *ponytail: 단순 추세 — 정교한 누수 분석은 스냅샷을 사람이 본다.*

### 3.7 테스트 · 검증 한계(B1 주의)

- **단위테스트(이 머신서 가능)**: systemd 유닛 문자열·launchd plist 문자열 생성(순수), 팩토리 platform 분기, Alerter(webhook fetch 목·command spawn 목), watchdog 멈춤 판정 로직(heartbeat 시각 비교, fs 목), MemoryMonitor 임계치 분기, HeartbeatEmitter write.
- **실동작 검증**: Windows 서비스 install/start/status는 이 머신서 수동 검증 가능. **Linux/macOS의 실제 systemctl·launchctl 동작은 해당 OS에서 사용자가 수동 확인**(생성물·명령은 테스트하되 OS 통합은 외부 검증). spec에 명시.

---

## 4. 공통 배선

- **모듈**: InsightLayer는 `KnowledgeCoreModule`(스토어·리포터·컨텍스트·메트릭), 스케줄러는 `EdgeModule`(DigestScheduler 형제). PAL supervisor/heartbeat/alerter/memory-monitor는 `PalModule`(신규) 또는 기존 위치에 추가 — 구현 플랜서 모듈 경계 확정.
- **상주 vs 원샷**: HeartbeatEmitter·MemoryMonitor·InsightScheduler는 **상주(main.ts)에서만** 발화. cli.ts 원샷은 즉시 close라 무발화(기존 스케줄러와 동일 성질).
- **PathResolver**: `getStateDir()`(heartbeat·pid·insights)·`getConfigDir()`(alert.json)·`getLogsDir()`(heap 스냅샷) 이미 존재. 인사이트용 경로 헬퍼(`getInsightsDir()`) 추가.

---

## 5. 범위 밖(미래)

- 단일 설치형 앱 패키징·GUI 셸 — **Phase 7**(이 Phase의 서비스 등록이 그 토대).
- 형태소 분석 기반 주제 군집(현재 단순 토큰 빈도 + 두뇌 요약).
- 인사이트의 위키 반영(현재 state 전용 — 위키 비대화 회피).
- 다중 사용자 인사이트 교차 분석(현재 userId별 독립).
- watchdog 자체의 이중화(설계 §10.2: 무한 후퇴 회피 — 최종은 외부 알림으로 끝).

---

## 6. 구현 순서(플랜 입력)

1. InsightLayer 메트릭(순수) → 스토어 → 리포터(두뇌) → 컨텍스트 주입 → 스케줄러 → CLI. (`sources` 확장 포함)
2. PAL Alerter(공유) → HeartbeatEmitter + pid → watchdog → MemoryMonitor.
3. PAL SupervisorPort + 3 어댑터 + 팩토리 → `engram service` CLI.
4. 통합 스모크 + Windows 서비스 수동 검증 + Mac/Linux 생성물 검증.
