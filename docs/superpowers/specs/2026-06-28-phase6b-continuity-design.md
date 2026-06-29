# Phase 6b-1 — `@Engram` 연속성(백그라운드 자율) 설계

작성일: 2026-06-28
상태: 설계 확정(6b-1 상세). 상위 맥락: [[2026-06-28-phase6-tag-design]](Phase 6 Tag 전체).

## 1. 한 줄 정의

멘션한 일을 **백그라운드로** 수행한다 — `@Engram`이 "알아볼게요" 하고 바로 풀려난 뒤 뒤에서 일하다 끝나면 그 스레드에 결과를 올리고, `@Engram 상태`로 진행/최근 작업을 조회할 수 있다. 그 사이 다른 걸 시켜도 된다.

## 2. 배경 — 6a에서 무엇이 바뀌나

6a의 `Orchestrator.handleMention(msg, onAck?) → Promise<string>`은 **답 하나를 return**하는 모델이라, 일이 끝나야만 말한다(동기·일회성). 6b-1은 이를 **`post(text)` 콜백 모델**로 바꿔, ack → (진행) → 결과를 **여러 번 나눠** 게시할 수 있게 하고, collaborate를 **백그라운드로 detach**해 멘션 핸들러가 ack 직후 반환되게 한다.

기존 자산 재사용: `collaborate()`(다중에이전트), `ConversationStore`(채널별 대화 기억), `Semaphore`(두뇌 호출량 제한), 6a 메신저 seam. **TaskStore는 무변경**(상태는 in-memory 트래커가 담당 — 아래 §4.2).

## 3. 범위

**6b-1만:** 백그라운드 수행 + 진행/결과 게시 + `@Engram 상태` + 채널 기억(결과를 ConversationStore에 적재해 후속 맥락으로).

**비범위(명시):**
- 컴퓨터/상주를 꺼도 살아남기, 며칠 자율 → 6b-3(자가 스케줄). in-memory 트래커는 재시작 시 소실.
- 라이브로 도는 작업에 끼어들어 변경 → 후속 멘션은 새 작업으로.
- 멘션에서 코딩(`codeRun`) 도달 → 6b-2.
- 동시 작업 큐/영속 → 두뇌 `Semaphore`가 호출량 제한으로 충분. 폭주 대비 큐는 6b-3.

## 4. 설계

### 4.1 채택 접근 — Orchestrator가 트래커 보유 + fire-and-forget

검토 3안: **A(채택)** 허브(Orchestrator)가 in-memory 트래커 + detached 실행 — 새 컴포넌트 최소, 허브가 유일 배정구(§7.1) 유지, Node 이벤트루프가 동시성. B 별도 `MentionTaskRunner`(허브 우회) · C 정식 job-queue(BullMQ — 영속까지 가나 의존성+과함, 6b-3 영역).

### 4.2 `MentionTracker` (신규, in-memory)

상태 조회용 경량 트래커. **TaskStore와 별개**(collaborate는 내부적으로 여전히 TaskStore 세션을 쓰되, 상태 UI는 이 트래커에서 — TaskStore엔 목록/스레드 질의 API가 없고 추가는 과함).

```ts
export type TrackedState = 'running' | 'done' | 'failed';
export interface TrackedTask {
  id: string;          // 트래커 자체 id(monotonic)
  question: string;
  team: string[];
  state: TrackedState;
  startedAt: string;
  finishedAt?: string;
}
export class MentionTracker {
  // threadKey → 작업들(running 전부 보존 + 완료분 최근 N개만, 메모리 바운드)
  start(threadKey: string, t: { question: string; team: string[] }): TrackedTask;
  finish(threadKey: string, id: string, state: 'done' | 'failed'): void;
  status(threadKey: string): TrackedTask[]; // running + 최근 완료(최신순)
}
```
- 완료분은 스레드당 최근 `RECENT_KEEP`(=5)개만 유지(`// ponytail: in-memory·재시작 소실, 영속은 6b-3`).
- id·시간은 생성자 주입 불요(주입된 `now`/seq) — 결정성 위해 `Date`는 호출부에서 ISO 문자열로 받아 넣는다(테스트 주입 가능하게 `start`에 선택적 `now` 인자). 단순화: `start(threadKey, t, now = new Date().toISOString())`.

### 4.3 `handleMention` 계약 변경 (post 콜백 모델)

```ts
handleMention(
  msg: CoreMessage,
  post: (text: string) => Promise<void>,
  threadKey: string = msg.userId,
): Promise<void>
```
흐름:
```
trimmed = msg.text.trim()
1) escape hatch:
   - '상태' | 'status'        → await post(formatStatus(tracker.status(threadKey)))
   - 'team a,b 질문'          → launchCollaboration(질문, [a,b]|['Manager'], msg.userId, threadKey, post)
   - 'ask 질문'               → await post(await route({text:질문, userId}))
2) classify(trimmed):
   - chat        → await post(await route(msg))
   - collaborate → team = decision.team.length ? decision.team : ['Manager']
                   await post(`팀 구성: ${team.join('·')} — 알아볼게요`)
                   launchCollaboration(msg.text, team, msg.userId, threadKey, post)  // await 안 함
return (collaborate는 launch 후 즉시 반환)
```

`launchCollaboration` (detached, 상주 불사):
```ts
private launchCollaboration(question, team, userId, threadKey, post): void {
  const t = this.tracker.start(threadKey, { question, team });
  void (async () => {
    try {
      const result = await this.collaborate(question, team, userId);
      // 채널 기억: 결과를 대화로그에 적재(후속 맥락·B수집 소스). 실패는 무시(부수효과).
      await this.conversations.append(userId, {
        ts: new Date().toISOString(), question, answer: result, sources: [],
      }).catch(() => {});
      this.tracker.finish(threadKey, t.id, 'done');
      await post(result);
    } catch (err) {
      this.tracker.finish(threadKey, t.id, 'failed');
      this.logger.warn(`백그라운드 협업 실패: ${String(err)}`, 'Orchestrator');
      try { await post('작업 중 문제가 생겼어요 🙏'); } catch { /* post도 실패하면 포기 */ }
    }
  })();
}
```
- chat은 빠른 단일콜이라 동기 유지(즉시 답이 결과). collaborate만 detach(ack→결과 분리, 상태에 running 노출).
- 동시성: collaborate 내부 specialist 호출이 기존 `Semaphore`를 경유 → 다발 백그라운드도 호출량은 묶임(`// ponytail: 천장=세마포어`).

### 4.4 `formatStatus`

```
진행 중 N건:
  - "질문 요약…" (팀: Manager·Infra, 시작 3분 전)
최근 완료:
  - "질문 요약…" (5분 전)
```
없으면 "지금 진행 중이거나 최근 완료한 작업이 없어요." 질문은 40자 잘라 표시.

### 4.5 bridge 갱신

`bindMessenger`의 핸들러:
```ts
port.onMention(async (e) => {
  const post = (text: string) => port.reply(e.target, text);
  const threadKey = e.threadId ?? e.channelId;          // 스레드 우선, 없으면 채널
  try {
    await orchestrator.handleMention({ text: e.text, userId: e.channelId }, post, threadKey);
  } catch (err) {
    logger.warn(`멘션 처리 실패: ${String(err)}`, 'Messenger');
    try { await post('지금 처리가 안 되네요 🙏'); } catch { /* 포기 */ }
  }
});
```
- 지식 네임스페이스는 채널 유지(`userId=e.channelId`, 멀티플레이어). 작업 추적 키만 스레드 우선.
- `MentionHandler` 인터페이스의 `handleMention` 시그니처를 post 모델로 갱신.

### 4.6 흐름 한 장

```
@Engram 마케팅 전략 정리
 → bridge: post=reply(target), threadKey
 → handleMention → classify=collaborate{team:[Brand,Trend]}
   → post("팀 구성: Brand·Trend — 알아볼게요")  [즉시]
   → launchCollaboration (detach) ─ 반환
        (백그라운드) collaborate → 결과
                     → conversations.append → tracker.finish(done) → post(결과)
@Engram 상태  → post(formatStatus: 진행 중/최근)
```

### 4.7 오류 처리(상주 불사)

- bridge 핸들러 try/catch + handleMention 동기 부분 throw 흡수.
- detached 백그라운드는 자체 try/catch(§4.3) — unhandled rejection 0, 실패 시 사과+로그.
- classify 실패 → 6a대로 chat 폴백. 빈 팀 → `['Manager']`.

### 4.8 테스트

- **`mention-tracker.spec.ts`**: start→running 노출 / finish→done·failed 전이 / 완료분 최근 N개 캡 / 스레드 격리 / status 최신순.
- **`orchestrator-handle-mention.spec.ts` 갱신**(post 모델): chat→post(답) / collaborate→post(ack) 후 백그라운드 결과 post(`await` 가능하게 launch가 반환하는 promise를 테스트 훅으로 노출하거나, FakeBrain 동기 collaborate로 microtask flush) / status→집계 post / 빈 팀→Manager / 분류실패→chat / escape hatch team·ask. **백그라운드 완료 관측**: `launchCollaboration`이 내부 promise를 보관(`private inflight`) — 테스트가 `await orchestrator.drainForTest()`로 비우고 post 캡처 확인(결정성).
- **`messenger-bridge.spec.ts` 갱신**: post=reply 배선·threadKey=threadId??channelId·에러 사과.
- collaborate 자체·route는 기존 스펙 유지.

### 4.9 영향 파일

- 신규: `src/agent-layer/mention-tracker.ts`(+spec).
- 수정: `src/agent-layer/orchestrator.ts`(handleMention post 모델+launchCollaboration+status, MentionTracker 필드, drainForTest 훅) · `src/agent-layer/agent-layer.module.ts`(MentionTracker 생성·주입) · `src/edge/messenger/messenger-bridge.ts`(post+threadKey, MentionHandler 시그니처) · 두 갱신 스펙.
- 무변경: `CoreMessage`·CLI·TaskStore·`main.ts`·discord.adapter.

## 5. 비고

- `drainForTest()`는 테스트 결정성 전용(보관한 inflight promise들 await). 운영 경로엔 영향 없음(`// ponytail: 테스트 훅`).
- 후속 6b-2(코딩)·6b-3(자가스케줄·영속 트래커)이 이 위에 얹힌다.
