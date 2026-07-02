# Phase 6c — ambient(선제 제안) + 채널별 권한 설계

작성일: 2026-07-02
상태: 설계 확정(6c). 상위 맥락: [[2026-06-28-phase6-tag-design]] §3 "6c — ambient + 권한". 구현 플랜은 2개(6c-1 ambient / 6c-2 권한)로 분리.

## 1. 한 줄 정의

시키지 않아도 먼저 — Engram이 채널을 관찰해 **일일 인사이트 요약·결재 대기 알림을 먼저 게시**하고, opt-in 채널에선 **대화에 관련 위키 정보를 끼어들어 제시**한다. 동시에 **채널별로 능력(코딩/예약/협업/관찰)을 잠글 수 있는** 정책 층을 깐다.

## 2. 배경

- **ambient 쪽 토대**: InsightLayer(일일 인사이트, 단 현행 cron은 `DEFAULT_USER`만) · ConversationStore(채널별 대화, userId=channelId) · ProposalStore(`listPending(userId?)`) · `postToChannel`. "관찰→생성"은 있는데 **먼저 말 거는 출구**가 없다.
- **권한 쪽 토대**: PermissionFence(코딩 경로 보호)는 있지만 **채널 단위 구분이 없다** — 봇이 있는 모든 채널에서 코딩 위임·예약이 가능.
- RagStore.search는 RRF score(높을수록 관련)를 반환하지만 순위 기반이라 절대 임계치로는 약함 → 관찰 판단은 "결과 유무 + 두뇌 확인"으로.

## 3. 범위

**6c-1 (ambient):** ① 일일 인사이트 요약 채널 게시 ② 결재 대기 알림 ③ 실시간 대화 관찰 끼어들기(opt-in).
**6c-2 (권한):** 채널별 coding/schedule/collaborate/observe/ambient 허용 정책 + Orchestrator 게이트.

**비범위:** 채널·사용자별 페르소나/두뇌 분리 · quiet hours · observe 대화의 ConversationStore 적재(digest 오염 방지 위해 안 함) · Discord 외 어댑터 onMessage 구현.

## 4. 확정 결정 (사용자)

1. **구조 = 한 스펙, 두 플랜**(Phase 5의 5a/5b 패턴).
2. **ambient 트리거 = 셋 다**: 인사이트 요약 + 결재 알림 + 실시간 관찰.
3. **기본값 = 조용한 건 켬, 끼어들기는 opt-in**: ambient(요약·알림)=기본 on, observe(끼어들기)=기본 off.
4. **권한 기본 = 허용, 제한은 opt-in**(Phase 4 자동모드 철학과 일관 — 설정 0으로 현행 동작 유지).

## 5. 설계

### 5.1 채택 접근

**A: 정책 파일 하나 + 허브 게이트 + plain ambient 서비스.** `channels.json`을 ambient·권한이 공유. 권한 집행은 Orchestrator(유일 배정구, seam #1), ambient 런타임은 main.ts 결선 plain(6a 메신저·6b-3 ScheduleService와 일관, CLI 원샷 무오염). (기각: B DI 모듈 편입=CLI가 메신저를 끌어옴 · C 어댑터 내 정책=포트 중립성 훼손.)

### 5.2 공용 토대 — `agent-layer/channel-policy.ts` (신규)

`runtime/config/channels.json`:
```json
{ "<channelId>": { "coding": false, "schedule": true, "collaborate": true, "observe": true, "ambient": true } }
```
```ts
type Capability = 'coding' | 'schedule' | 'collaborate' | 'observe' | 'ambient';
interface ChannelPolicy { channels: Record<string, Partial<Record<Capability, boolean>>>; }
function loadChannelPolicy(configDir: string): ChannelPolicy; // 없음/깨짐 → { channels: {} }
function allows(policy: ChannelPolicy, channelId: string, cap: Capability): boolean;
```
기본값(미설정 채널·미설정 키): **coding/schedule/collaborate/ambient=true, observe=false.** 값이 boolean 아니면 무시(기본값).

### 5.3 6c-2 권한 — Orchestrator 게이트

- Orchestrator에 lazy `policy()` 캐시(기존 `codeRepos()` 패턴, `paths.getConfigDir()` — **DI·생성자 18인자 무변경**). 테스트는 메서드 override.
- handleMention 게이트(각 분기 진입 직후, channelId=`msg.userId`):
  - coding: classify `code` 분기 · `code ` hatch · **`resume ` hatch**(자가 재개 발사도 잠긴 채널이면 안내만) · pending approve(승인 답장) — 차단 문구 `이 채널에선 코딩을 쓸 수 없어요(채널 설정).`
  - schedule: classify `schedule` 분기 · `schedule ` hatch — `이 채널에선 예약을 쓸 수 없어요(채널 설정).` (예약목록·예약취소는 읽기/정리라 항상 허용.)
  - collaborate: classify `collaborate` 분기 · `team ` hatch · **`retry ` hatch** — `이 채널에선 협업을 쓸 수 없어요(채널 설정).` (차단 시 chat으로 강등하지 않고 안내만 — 의도 왜곡 방지.)
- chat(route)·`ask `·상태는 항상 허용. CLI Gateway는 채널 개념 없음 → 게이트 미적용(기존 그대로).

### 5.4 6c-1 ambient — 조용한 출구: `edge/ambient-service.ts` (신규, plain, main.ts 결선)

의존: `{ insight }`(Orchestrator), `MessengerPort`, `SchedulerRegistry`, `InsightStore`, `ProposalStore`, `ChannelPolicy`(로드 함수), `PathResolver`, `PinoLogger`.
- `start()`: cron 등록(기본 `0 8 * * *`, `ENGRAM_AMBIENT_CRON`, resolveCron 재사용) → `tick()`.
- `tick()`: 채널 목록 = `state/conversations/` 하위 디렉토리명(= userId=channelId). `DEFAULT_USER` 제외(CLI 사용자, 게시할 채널 아님). 채널마다(개별 try/catch):
  1. `allows(channelId, 'ambient')` 아니면 스킵.
  2. **어제 대화 파일 있으면** `orchestrator.insight(channelId)` 실행(채널별 인사이트 생성 — 현행 InsightScheduler는 DEFAULT_USER만이라 여기가 채널 인사이트의 생성 지점) → 반환 DayInsight의 서술(narrative)을 `☀️ 어제 이 채널: …`로 `postToChannel`. 대화 없으면 인사이트 생략.
  3. `proposals.listPending(channelId).length > 0`이면 `📋 위키 결재 대기 N건 — 터미널에서 engram review로 승인해줘` 게시.
- 메신저 포트 없으면 main.ts가 결선 자체를 안 함(ScheduleService와 동일).

### 5.5 6c-1 ambient — 끼어들기(opt-in): 관찰 파이프라인

- **포트**: `MessengerPort.onMessage?(handler: (e: MentionEvent) => Promise<void>): void` — 옵셔널(기존 어댑터 무파손). 비멘션·비봇 일반 메시지를 emit(멘션은 기존 onMention 그대로, 중복 emit 없음). FakeMessenger는 `emitMessage` 헬퍼 추가.
- **Discord 어댑터**: messageCreate에서 멘션이 아니고 봇도 아니면 onMessage로 emit. 어댑터는 정책을 모른다(전 채널 emit, 필터는 bridge).
- **bridge**: `bindMessenger`가 onMessage도 바인딩 — `allows(channelId, 'observe')`인 채널만 `orchestrator.observe(msg, post)` 호출(post=postToChannel 바인딩). 정책 로드는 결선 시 1회 + 게이트에서 재사용(bridge에 로드 함수 주입).
- **Orchestrator.observe(msg, post)** — 비용 사다리 순서로 스킵(모두 무음):
  1. 짧은 메시지(trim 후 10자 미만) 스킵.
  2. 채널 쿨다운(기본 30분, `ENGRAM_AMBIENT_COOLDOWN_MIN`, in-memory Map, 재시작 리셋 수용) 안 지났으면 스킵.
  3. `rag.search(msg.text, 3, channelId)` — 위키 검색(로컬, 공짜). 결과 0이면 스킵. (RRF 절대 임계치는 신뢰 불가 → 유무만 보고 판단은 두뇌에.) **RagStore는 Orchestrator에 없음 → `@Optional` 19번째 주입 추가**(6b-2에서 PathResolver를 18번째로 추가한 전례, agent-layer.module 팩토리 inject 정합 포함). 미주입(구식 테스트)이면 observe는 조용히 스킵.
  4. 두뇌 1콜(`prompts/ambient.md`, 보수적: "대화에 실질 도움이 될 때만, 확실치 않으면 no") → `{interject: boolean, text: string}` JSON(parseJsonBlock). interject=false·파싱실패 → 스킵.
  5. 통과 → 쿨다운 기록 → `💡 <text>` 게시.
- 관찰 메시지는 **ConversationStore에 적재하지 않는다**(멘션/협업 적재는 기존 그대로 — digest 오염 방지).

### 5.6 흐름 한 장

```
(매일 8시) ambient tick → 채널 순회 → ☀️ 인사이트 요약 + 📋 결재 대기 N건
(observe 채널에서 누가 "LanceDB 마이그레이션 어떻게 했더라?")
 → onMessage → bridge(observe 허용?) → observe: 길이 OK → 쿨다운 OK → RAG 적중
 → 두뇌 "끼어들 가치 있음" → 💡 위키 'rag-store 마이그레이션'에 정리돼 있어요: …
(coding 잠근 채널에서 "@Engram api 레포에 버그 고쳐줘")
 → classify code → 게이트 → "이 채널에선 코딩을 쓸 수 없어요(채널 설정)."
```

### 5.7 오류 처리(상주 불사)

- channels.json 없음/깨짐 → 전부 기본값(조용한 ambient on·observe off·명령 전부 허용).
- ambient tick 채널별 try/catch — 한 채널 실패가 다음 채널을 막지 않음. 로그.
- observe 각 단계 실패(검색 throw·두뇌 에러·파싱 실패·post 실패) → 무음 스킵 + debug 로그.
- 게이트 차단은 항상 안내 게시(막다른 길 없음).

### 5.8 테스트

- **channel-policy**: 기본값(coding true·observe false)·부분설정 병합·파일 없음/깨짐→기본값·비boolean 무시.
- **Orchestrator 게이트**(스텁 policy override): cap별 차단 안내/허용 통과 · resume→coding·retry→collaborate 게이트 · 예약목록/취소·chat·ask는 잠겨도 동작 · 기본값(정책 없음)=전부 기존 동작 회귀.
- **AmbientService**(fake orchestrator/port/stores/tmp dir): 어제 대화 있는 채널만 insight 호출+☀️ 게시 · pending>0만 📋 게시 · ambient=false 스킵 · DEFAULT_USER 제외 · 채널 하나 throw여도 나머지 진행.
- **Orchestrator.observe**: 사다리 각 단계 스킵(짧음/쿨다운/무결과/interject=false) · 통과 시 💡 게시+쿨다운 기록 · 두뇌 throw 무음.
- **bridge**: observe 미허용 채널 무호출 · onMessage 미구현 포트에서 무파손.
- **Discord onMessage**: 필터 순수함수 단위테스트 + 스모크(네트워크 글루).

### 5.9 영향 파일

- 신규: `src/agent-layer/channel-policy.ts`(+spec) · `src/edge/ambient-service.ts`(+spec) · `prompts/ambient.md`.
- 수정: `src/agent-layer/orchestrator.ts`(게이트 + observe + policy lazy + RagStore 19번째 @Optional) · `src/agent-layer/agent-layer.module.ts`(팩토리 inject 19/19 정합) · `src/edge/messenger/messenger.port.ts`(onMessage 옵셔널) · `fake-messenger.ts` · `discord.adapter.ts` · `messenger-bridge.ts`(observe 바인딩) · `src/main.ts`(AmbientService 결선).
- 무변경: 코어(KnowledgeCore) · CLI Gateway · 기존 스케줄러(Digest/Insight/Meeting/Schedule) · PermissionFence.

## 6. 비고

- observe의 두뇌 콜은 RAG 적중 시에만 — 비용 상한은 쿨다운이 겸한다(채널당 30분에 최대 1콜+게시).
- 채널별 인사이트가 쌓이면(5.4의 2) 기존 InsightContext(응답 주입)도 채널 질의에서 자동으로 살아난다 — 별도 작업 불요.
- `// ponytail: observe 쿨다운은 in-memory(재시작 리셋) — 영속 필요해지면 state 파일로.`
- channels.json 변경은 **재시작 시 반영**(Orchestrator lazy 캐시·bridge 결선 1회 로드 — coderepos.json과 동일 성질).
- 구현 순서 권장: 6c-2(권한, 작고 독립) → 6c-1(ambient, 포트·어댑터·서비스). 정책 파일은 6c-2가 먼저 만들고 6c-1이 재사용.
