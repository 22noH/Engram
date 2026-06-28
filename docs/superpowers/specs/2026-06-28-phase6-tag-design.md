# Phase 6 — Tag (`@Engram` 동료) 설계

작성일: 2026-06-28
상태: 설계 확정(6a 상세) — 6b/6c는 방향만

## 1. 한 줄 정의

Engram을 메신저에 붙여, `@Engram <일>`로 멘션하면 동료처럼 알아서 분해·팀구성·수행하고 그 자리(스레드)에 보고한다. 메신저 종류는 포트 뒤로 숨겨 언제든 갈아끼운다. 모델 출처: Anthropic "Claude Tag"(슬랙에서 `@Claude`를 팀원처럼 멘션·위임).

## 2. 배경 — 왜 거의 다 만들어져 있나

DESIGN.md 로드맵 §11이 이미 예고: **CLI(초기) → Discord(discord.js) → 자체 front-end.** Edge는 포트+어댑터 seam(`CliGateway`가 첫 어댑터, 코어는 `CoreMessage`만 봄)이라 새 메신저 어댑터가 거저 올라탄다.

핵심 전환: 지금은 `engram team Manager,Infra "..."`처럼 **사람이 로스터를 직접 나열**해야 한다(`Orchestrator.collaborate(question, personas[])` — "분해는 호출자가 결정", seam #1). Phase 6는 그 **로스터 결정 권한을 사람 → Engram(두뇌)으로 옮긴다.**

분해(`decompose`)·협업(`collaborate`)·코딩(`codeRun`)·맥락(`ConversationStore`)·스케줄(@Cron/meeting)은 Phase 1~5에서 이미 존재. 새로 만드는 건 **메신저 연결구 + 멘션→행동 판단 한 곳**뿐.

## 3. 분해 (Phase 5의 5a/5b처럼)

- **6a — 메신저 seam + 동료 기본** ← 본 문서 상세 대상.
  메신저에서 `@Engram <질문/일>` → 팀 자동구성 → 답 보고. "동료가 됐다"의 핵심.
- **6b — 시간을 건너는 자율**(방향만).
  스레드↔프로젝트 바인딩(`TaskStore`), 여러 라운드 지속·`@Engram 상태`·후속 라우팅, 진행 보고, 코딩 실행(`codeRun`)을 멘션에서 도달, 자가 스케줄(@Cron).
- **6c — ambient + 권한**(방향만).
  선제 알림(인사이트/대화 관찰 → 관련정보 먼저 제시), 채널별 도구/권한 분리.

각 조각은 자체 spec → plan → 구현 사이클을 가진다. 본 문서는 6a를 구현 가능한 수준으로 확정한다.

---

## 4. 6a 상세 설계

### 4.1 채택 접근 — Orchestrator triage (the colleague brain)

검토한 3안:

- **A (채택)** Orchestrator triage: 허브에 `handleMention()` 추가. 두뇌가 멘션을 분류 + 로스터 산출 → 기존 `route`/`collaborate`로 디스패치. classify 두뇌콜 1번 + 전부 재사용. 허브가 유일 배정구(§7.1) 유지.
- B 리더 페르소나 에이전트 루프: 더 agentic하나 DESIGN이 경고한 자율 멀티에이전트 붕괴 위험. 과함.
- C 메신저 위 명령어(`@Engram team ...`): 최소지만 "동료"가 아님. → A의 escape hatch로만 일부 수용(아래 4.4).

### 4.2 새로 만드는 것 — 3개

**① `MessengerPort` (Edge 포트)** — 메신저 종류를 코어에서 숨기는 규격. `runtime/config/messenger.json`의 `provider`로 갈아끼운다(`brain.factory`·`supervisor.factory`와 동일 패턴: `createMessenger(provider, cfg)`).

```ts
export interface MentionEvent {
  text: string;        // @Engram 떼어낸 본문
  channelId: string;   // 방 식별자
  threadId?: string;   // 스레드(있으면)
  authorId: string;    // 보낸 사람
  target: ReplyTarget; // reply가 되돌려줄 불투명 핸들(어댑터 내부 구조)
}
export interface MessengerPort {
  onMention(handler: (e: MentionEvent) => Promise<void>): void;
  reply(target: ReplyTarget, text: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

`ReplyTarget`는 어댑터별 불투명 타입(코어는 내용 모름). 코어는 채널 ID·버튼 등 프론트 특유의 것을 모른다는 `CoreMessage` 주석 원칙을 유지하기 위해, 답신 경로(target)는 코어를 통과하지 않고 어댑터가 직접 보관한다(4.3 흐름 참조).

**② Discord 어댑터** — `discord.js`로 `MessengerPort` 구현.
- `messageCreate` 수신 → 봇 멘션(`@Engram`)인 메시지만 필터 → 멘션 토큰 제거 → `MentionEvent` 발사.
- `reply(target, text)` → 해당 채널/스레드에 게시.
- 토큰: `messenger.json`의 `token` 또는 env `ENGRAM_DISCORD_TOKEN`.
- 새 의존성 = `discord.js` 하나. 메신저 게이트웨이(websocket) SDK라 직접 구현 비현실적 → 정당. 로드맵 명시 선택.

**③ `Orchestrator.handleMention()` — 판단 한 곳**

```
handleMention(msg: CoreMessage, onAck?: (t: string) => Promise<void>): Promise<string>
  1) 두뇌 1콜로 분류 → { kind: 'chat' | 'collaborate', team?: string[] }
     (프롬프트: 페르소나 목록 + 본문 → 반드시 JSON. 기존 parseJsonBlock 재사용)
  2) kind=chat        → return this.route(msg)
     kind=collaborate → await onAck?.("알아볼게요"); return this.collaborate(msg.text, team, msg.userId)
```

- `onAck`는 기존 `route(msg, onChunk)`·`codeRun({onProgress})` 콜백 관례와 동일. collaborate처럼 시간이 걸릴 때만 처리 중 메시지를 어댑터가 먼저 게시하게 하는 선택적 훅. 어댑터는 `onAck`를 `port.reply(target, …)`로 배선.
- 분류·로스터를 **한 번의 두뇌 호출**로 같이 받는다.
- 분류 프롬프트는 `prompts/triage.md`로 외부화(Phase 4 프롬프트 외부화 관례). 내장 기본값 동봉(파일 없을 때).
- 페르소나 후보는 `PersonaRegistry.all()`에서 이름·role을 뽑아 프롬프트에 주입.
- *6a 범위: chat·collaborate만. coding(codeRun)은 6b.*

### 4.3 흐름

```
디스코드 "@Engram 서버 비용 줄여줘"
  → DiscordAdapter.messageCreate (멘션 필터·@제거)
  → MentionEvent{ text, channelId, threadId, authorId, target }
  → 상주가 바인딩한 핸들러:
       const reply = await orchestrator.handleMention(
         { text, userId: channelId },
         (ack) => port.reply(target, ack),   // 처리 중 메시지(선택)
       )
       await port.reply(target, reply)        // 최종 결과
  내부:
       handleMention → 두뇌 분류 {collaborate, team:[Manager,Infra]}
                     → collaborate("서버 비용 줄여줘", [Manager,Infra], channelId)
                     → 종합 답
```

답신 경로(`target`)는 어댑터→핸들러→`port.reply`로만 흐르고 코어(`handleMention`)는 텍스트만 주고받는다 → 코어 중립성 유지.

### 4.4 멀티플레이어 = 채널이 기억 단위

`userId`를 **채널 ID로** 매핑한다. 같은 방의 누구나 같은 Engram·같은 맥락을 공유(Claude Tag의 "채널당 하나의 Claude"). `ConversationStore`가 이미 `userId` 네임스페이스라 **새 저장소 0**. 코어는 채널 ID를 모른 채 네임스페이스 문자열로만 받는다.

escape hatch(접근 C 일부): 본문이 `team <names> <q>` / `ask <q>` 같은 명시 명령으로 시작하면 분류를 건너뛰고 직접 실행 — 두뇌 판단이 빗나갈 때의 수동 우회. (구현은 `handleMention` 진입부 간단 prefix 검사 1개.)

### 4.5 상주 결선(wiring)

`main.ts`(상주)가 메신저 어댑터를 `start()`하고 `onMention`을 `orchestrator.handleMention` → `port.reply`로 바인딩한다. CLI(`cli.ts`)는 기존대로 원샷 — 메신저는 상시 리슨이 필요하므로 상주에만 산다. `messenger.json`/토큰 없으면 어댑터를 띄우지 않고 상주는 정상 가동.

### 4.6 오류 처리 (상주를 절대 안 죽임)

- 멘션 핸들러 전체 try/catch → 실패 시 "지금 처리가 안 되네요 🙏" 답 + pino 경고. (기존 "부수효과 실패가 답변 경로를 안 죽임" 패턴.)
- 분류 두뇌콜 실패/파싱 불가 → **chat으로 폴백**(`route`). 막다른 길 없음.
- 팀이 비거나 미존재 페르소나 → 기본 로스터 `[Manager]`.
- 토큰/설정 없음 → 어댑터 off + 로그, 상주는 가동.
- 긴 작업: 분류가 collaborate면 먼저 짧은 ack("알아볼게요")를 `reply`로 보내고 결과를 이어 게시. 진짜 장기 자율(며칠)은 6b.

### 4.7 설정

`runtime/config/messenger.json`:
```json
{ "provider": "discord", "token": "<봇 토큰>", "engramName": "Engram" }
```
- `provider` 없거나 파일 없음 → 메신저 비활성(상주만 가동).
- `token`은 env `ENGRAM_DISCORD_TOKEN` 우선(파일에 비밀 안 박게).

### 4.8 테스트

- **`FakeMessenger`** 어댑터(기존 `FakeBrain`/`FakeEmbedder` 패턴): 멘션 주입 → 답 캡처. 단위테스트용.
- `handleMention` 단위테스트(FakeBrain 고정 JSON):
  - 분류→chat → `route` 경로·답 반환.
  - 분류→collaborate → `collaborate`가 산출 팀으로 호출됨.
  - 분류 실패(빈/깨진 응답) → chat 폴백.
  - 빈 팀 → `[Manager]` 폴백.
  - escape hatch `team a,b q` → 분류 스킵·직접 호출.
- `MessengerPort` 계약: `FakeMessenger`로 onMention→handler→reply 왕복 1개.
- Discord 어댑터 글루는 얇게(필터·@제거·게시만) 두고 스모크만. `// ponytail: 네트워크 글루, 스모크만`.

### 4.9 갈아끼움 보장

Telegram/Slack 추가 = 어댑터 파일 1개 + `createMessenger` 팩토리 case 1개. 코어·Orchestrator·CLI·`handleMention` 무변경. provider만 config에서 바꾼다.

## 5. 비범위 (6a에서 명시적으로 제외)

- 코딩 실행(`codeRun`)을 멘션에서 도달 → 6b.
- 며칠 걸친 자율·자가 스케줄·진행 중 프로젝트 기억/`@Engram 상태` → 6b.
- 선제(ambient) 알림·채널별 권한 분리 → 6c.
- Discord 외 어댑터 실제 구현(규격만 준비, 구현은 필요 시) → 후속.

## 6. 영향받는 파일(예정)

- 신규: `src/edge/messenger/messenger.port.ts`, `messenger.factory.ts`, `discord.adapter.ts`, `fake-messenger.ts`(+spec).
- 수정: `src/agent-layer/orchestrator.ts`(`handleMention` 추가), `src/main.ts`(어댑터 결선), `src/app.module.ts`(provider 등록), `prompts/triage.md`(신규 프롬프트), `package.json`(`discord.js`).
- 코어(`CoreMessage`)·CLI(`cli.gateway.ts`) 무변경.
