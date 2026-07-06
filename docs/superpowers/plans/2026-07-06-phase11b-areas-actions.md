# Phase 11b — 3영역 재편 + 클릭 승인/선택 버튼 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 11a 위에서 ① 메시지 프레임에 `actions` 필드를 정식 추가해 승인/후보선택을 **클릭 버튼**으로 하고(승인만 confirm 한 번), ② 모드 탭을 **3영역 네비(채팅[Team, flag로 숨김] / Ask / 코드)**로 재편한다.

**Architecture:** 서버는 기존 텍스트 프로토콜(`"승인"`/`"취소"`/`"1"`)을 그대로 두고, 결정 지점의 `post` 호출에 `actions`를 옵셔널로 첨부한다 — `post(text, actions?)` → `MessengerPort.reply(target, text, actions?)` → `ChatStore.appendMessage`가 메시지에 실어 저장·broadcast. 클릭이 보내는 건 기존 텍스트라 **Orchestrator의 pending 상태머신 로직은 0 변경**. 렌더러 `ActionButtons`가 `actions`를 버튼으로 렌더(confirm 게이트 후 기존 `send` 텍스트를 ws로 전송). 영역은 채널의 `mode`를 `'chat'|'code'|'team'`으로 확장하고(Ask=chat, Code=code, Team=team) 네비를 3탭으로, Team은 `features.teamChat=false`(기본)로 숨긴다. Discord 등 타 어댑터는 `actions`를 무시하고 텍스트 프롬프트로 폴백(하위호환).

**Tech Stack:** TypeScript, NestJS + ws + Jest(두뇌), React 19 + Vitest(렌더러 `renderer/`).

## Global Constraints

- **서버 pending 로직 변화 0**: 클릭 버튼이 보내는 건 기존 텍스트(`"승인"`/`"취소"`/번호)라 `handleMention`의 pending(approve/disambiguate) 상태머신은 그대로. `actions`는 **게시 부가정보**일 뿐.
- **하위호환**: `Message.actions`·`reply`의 actions·`mode:'team'`·`appendMessage` actions 인자는 전부 **옵셔널**. 기존 메시지/채널/Discord 어댑터 무영향. Discord `reply`는 actions를 받되 무시(텍스트만).
- **ws 프레임 계약**: 신규 프레임 없음. 기존 `msg`/`history` 프레임의 `Message`에 옵셔널 `actions`만 추가(`shared/protocol.ts` 단일 진실원).
- **되돌릴 수 없는 것만 confirm**: 승인(코딩 시작)만 `confirm`. 후보선택/번호/취소는 즉시 전송.
- **XSS**: `label`은 React 이스케이프로만 렌더(`send`는 ws로만 나가고 DOM 안 들어감). `renderer/`는 innerHTML 금지.
- **Team 영역 flag**: `renderer/src/config.ts`의 `TEAM_CHAT=false`(기본). false면 네비에 Team 탭 자체가 안 보임. Team 채널은 flag on일 때만 생성 가능(기본 respondMode='mention').
- **모드 매핑**: Ask=`mode:'chat'`(미설정 포함), Code=`mode:'code'`, Team=`mode:'team'`. Orchestrator는 `mode==='code'`만 특수(코딩) — chat/team은 동일한 일반 라우팅(Team의 mention-only는 이미 `respondMode`가 처리, 별도 코드 없음).
- UI 문구 영어 기본 + ko 로케일(`renderer/src/i18n.ts` `T`).
- 셸 PowerShell. 두뇌 테스트 `npx jest <경로>`, 렌더러 `npm --prefix renderer test`.

## File Structure

**변경 (두뇌 `src/`)**
- `shared/protocol.ts` — `Action` 인터페이스 + `Message.actions?`; `Channel.mode`에 `'team'` 추가.
- `src/edge/messenger/chat-store.ts` — `ChatMessage.actions?`; `appendMessage(..., actions?)`; `createChannel`/정규화에 `'team'` 모드.
- `src/edge/messenger/messenger.port.ts` — `MessengerPort.reply(target, text, actions?)`; `MentionHandler`는 bridge에 있으니 그쪽.
- `src/edge/messenger/self.adapter.ts` — `reply`가 actions를 appendMessage에 전달.
- `src/edge/messenger/discord.adapter.ts` — `reply` 시그니처에 actions 추가(무시).
- `src/edge/messenger/messenger-bridge.ts` — `post(text, actions?)`; `MentionHandler.handleMention` post 타입.
- `src/agent-layer/orchestrator.ts` — `post` 타입을 `(text, actions?)`로 스레딩; startProposal(승인 actions)·startCoding 다중매치(후보 actions) 첨부. `Action` 타입 재사용(shared/protocol import).

**변경 (렌더러 `renderer/src/`)**
- `shared/protocol.ts`(공유) — 위와 동일 파일.
- `components/ActionButtons.tsx` — 신규. `actions`를 버튼 줄로.
- `components/Message.tsx` — actions 있으면 `ActionButtons` 렌더. `onSend` prop 추가.
- `components/Thread.tsx` — `onSend` pass-through.
- `App.tsx` — Message/Thread에 `onSend={(text)=>sendText(text)}` 전달; 3영역 네비 상태(`area` 대체 `mode`), Ask/Code/Team.
- `components/Channels.tsx` — 3탭 네비(Ask·Code 항상, Team은 flag). "Chat"→"Ask" 라벨.
- `config.ts` — `TEAM_CHAT=false`.
- `i18n.ts` — `tabAsk`, `tabTeam`(tabChat 제거/대체).

---

### Task 1: `actions`·`mode:'team'` 데이터 계층 (protocol + ChatStore)

**Files:**
- Modify: `shared/protocol.ts`
- Modify: `src/edge/messenger/chat-store.ts`
- Test: `src/edge/messenger/chat-store.spec.ts`

**Interfaces:**
- Consumes: 기존 `ChatStore`.
- Produces:
  - `interface Action { label: string; send: string; confirm?: string }` (shared/protocol, export)
  - `Message.actions?: Action[]` (shared/protocol)
  - `Channel.mode?: 'chat' | 'code' | 'team'`
  - `ChatMessage.actions?: Action[]` (chat-store)
  - `appendMessage(channelId, { authorId, text, threadId?, actions? }): ChatMessage | null`
  - `createChannel(name, mode?: 'chat'|'code'|'team')`; 정규화가 'code'/'team'만 인정, 그 외=chat.

- [ ] **Step 1: 실패 테스트** — `chat-store.spec.ts`에 추가

```ts
it('appendMessage가 actions를 저장하고 history에 실어준다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatstore-'));
  const store = new ChatStore(dir);
  const acts = [{ label: '✅ 승인', send: '승인', confirm: '시작할까요?' }, { label: '취소', send: '취소' }];
  const m = store.appendMessage('general', { authorId: 'engram', text: '완성조건…', actions: acts });
  expect(m?.actions).toEqual(acts);
  expect(store.history('general').at(-1)?.actions).toEqual(acts);
});

it('createChannel이 team 모드를 저장하고 정규화가 team을 인정한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatstore-'));
  const store = new ChatStore(dir);
  const t = store.createChannel('people', 'team');
  expect(t?.mode).toBe('team');
  expect(store.listChannels().find((c) => c.id === t!.id)?.mode).toBe('team');
});
```

> `general` 채널은 `store.listChannels()`가 최초 생성(기존 관례). `import * as os from 'os';` 있는지 확인.

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/chat-store.spec.ts -t "actions|team"`
Expected: FAIL(appendMessage actions 미지원 / createChannel team 강등됨).

- [ ] **Step 3: 구현**

`shared/protocol.ts`:
- `Channel.mode` 타입을 `'chat' | 'code'` → `'chat' | 'code' | 'team'`로.
- `Message`에 `actions?: Action[]` 추가.
- 파일에 추가:
```ts
export interface Action { label: string; send: string; confirm?: string }
```

`src/edge/messenger/chat-store.ts`:
- `ChatChannel.mode?: 'chat' | 'code'`를 `'chat' | 'code' | 'team'`로.
- `ChatMessage`에 `actions?: Action[]` 추가. 파일 상단에 `import type { Action } from '../../../shared/protocol';`(경로는 chat-store.ts 위치 기준 — `src/edge/messenger/`에서 repo root `shared/`는 `../../../shared/protocol`).
- `listChannels()`의 mode 정규화 교체(현재 `c.mode === 'code' ? 'code' : 'chat'`):
```ts
    mode: c.mode === 'code' ? 'code' : c.mode === 'team' ? 'team' : 'chat',
```
- `createChannel(name, mode)`의 기본/강등 로직에 team 인정:
```ts
createChannel(name: string, mode: 'chat' | 'code' | 'team' = 'chat'): ChatChannel | null {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return null;
  const list = this.listChannels();
  const m = mode === 'code' ? 'code' : mode === 'team' ? 'team' : 'chat';
  // Team 채널은 사람 대화 영역 → 기본 멘션-전용(Ask=all과 구분). Phase 14에서 실동작.
  const ch: ChatChannel = { id: randomUUID(), name: trimmed, respondMode: m === 'team' ? 'mention' : 'all', mode: m };
  list.push(ch);
  this.save(list);
  return ch;
}
```
- `appendMessage`에 actions 전달. 현재:
```ts
appendMessage(channelId: string, msg: { authorId: string; text: string; threadId?: string }): ChatMessage | null {
```
→ actions 추가:
```ts
appendMessage(channelId: string, msg: { authorId: string; text: string; threadId?: string; actions?: Action[] }): ChatMessage | null {
```
그리고 메시지 객체 생성부(현재 `{ id, authorId, text, ts, threadId }`)에 `...(msg.actions ? { actions: msg.actions } : {})` 추가(옵셔널이라 미지정 시 필드 없음=하위호환).

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/messenger/chat-store.spec.ts`
Expected: PASS(신규 2건 포함 전체).

- [ ] **Step 5: 커밋**

```bash
git add shared/protocol.ts src/edge/messenger/chat-store.ts src/edge/messenger/chat-store.spec.ts
git commit -m "feat(phase11b): Message.actions·Channel mode team + ChatStore appendMessage actions/team"
```

---

### Task 2: `post`/`reply`에 actions 스레딩 (플러밍, 동작 첨부는 Task 3)

**Files:**
- Modify: `shared/protocol.ts` (ClientFrame createChannel.mode에 'team')
- Modify: `src/edge/messenger/messenger.port.ts`
- Modify: `src/edge/messenger/self.adapter.ts`
- Modify: `src/edge/messenger/discord.adapter.ts`
- Modify: `src/edge/messenger/messenger-bridge.ts`
- Test: `src/edge/messenger/self.adapter.spec.ts`, `src/edge/messenger/messenger-bridge.spec.ts`

**Interfaces:**
- Consumes: `Action`(Task 1), `appendMessage(..., actions?)`(Task 1).
- Produces:
  - `MessengerPort.reply(target, text, actions?: Action[]): Promise<void>`
  - `MentionHandler.handleMention(msg, post, threadKey?)`의 `post: (text: string, actions?: Action[]) => Promise<void>`
  - bridge: `post = (text, actions?) => port.reply(e.target, text, actions)`
  - `SelfMessenger.reply`가 actions를 appendMessage에 실어 broadcast.
  - Discord `reply(target, text, actions?)` — actions 무시(텍스트만 게시).

- [ ] **Step 1: 실패 테스트** — `self.adapter.spec.ts`에 추가

```ts
it('reply(actions)가 메시지에 actions를 실어 broadcast한다', async () => {
  const acts = [{ label: '✅ 승인', send: '승인', confirm: '시작?' }, { label: '취소', send: '취소' }];
  await sm.reply({ channelId: 'general', anchorId: 'a1' } as SelfTarget, '완성조건…', acts);
  const frame = await nextFrame(client);
  expect(frame.t).toBe('msg');
  expect(frame.message.actions).toEqual(acts);
  expect(store.history('general').at(-1)?.actions).toEqual(acts);
});
```

`messenger-bridge.spec.ts`에 추가(기존 FakeMessenger 관례 따름 — reply 캡처):

```ts
it('post(text, actions)가 port.reply에 actions를 넘긴다', async () => {
  const replied: any[] = [];
  const port = new FakeMessenger();
  const origReply = port.reply.bind(port);
  port.reply = (t: any, text: string, actions?: any) => { replied.push({ text, actions }); return origReply(t, text); };
  const orch = { handleMention: async (_m: any, post: any) => { await post('완성조건', [{ label: 'x', send: '승인' }]); } };
  bindMessenger(port as any, orch as any, { warn() {} });
  await port.emitMention({ text: 'q', channelId: 'c1', authorId: 'u', target: {} });
  expect(replied[0].actions).toEqual([{ label: 'x', send: '승인' }]);
});
```

> `FakeMessenger`의 정확한 emit/reply 시그니처는 기존 spec을 따른다. `reply`를 몽키패치 못 하면 FakeMessenger가 이미 last-reply를 저장하는지 확인해 그걸 사용.

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts src/edge/messenger/messenger-bridge.spec.ts -t "actions"`
Expected: FAIL(reply 3번째 인자 미지원).

- [ ] **Step 3: 구현**

`messenger.port.ts`:
- 상단에 `import type { Action } from '../../../shared/protocol';`(messenger.port.ts는 `src/edge/messenger/` → `../../../shared/protocol`).
- `reply` 시그니처:
```ts
  reply(target: ReplyTarget, text: string, actions?: Action[]): Promise<void>;
```

`self.adapter.ts` — `reply` 교체(현재 appendMessage 후 broadcast):
```ts
  async reply(target: ReplyTarget, text: string, actions?: Action[]): Promise<void> {
    const t = target as SelfTarget;
    const msg = this.store.appendMessage(t.channelId, { authorId: 'engram', text, threadId: t.anchorId, ...(actions ? { actions } : {}) });
    if (msg) this.broadcast({ t: 'msg', channelId: t.channelId, message: msg });
  }
```
상단 import에 `import type { Action } from '../../../shared/protocol';` 추가(ServerFrame import 옆).

**createChannel 프레임의 'team' 통과**(리뷰어 지적 갭 — 없으면 렌더러 team 생성이 chat으로 강등되고 ClientFrame 타입도 거부):
- `shared/protocol.ts`의 `ClientFrame` 유니온에서 `createChannel` 변형의 `mode?: 'chat' | 'code'` → `mode?: 'chat' | 'code' | 'team'`.
- `self.adapter.ts`의 `handleFrame` `case 'createChannel'`(현재 `this.store.createChannel(f.name, f.mode === 'code' ? 'code' : 'chat')`)을 team 통과로:
```ts
        case 'createChannel':
          if (typeof f.name === 'string') this.store.createChannel(f.name, f.mode === 'code' ? 'code' : f.mode === 'team' ? 'team' : 'chat');
          this.broadcast({ t: 'channels', list: this.store.listChannels() });
          return;
```
- Step 1 테스트에 추가(self.adapter.spec.ts): `client.send({t:'createChannel', name:'people', mode:'team'})` → 다음 channels 브로드캐스트에서 그 채널 `mode==='team'`. (기존 createChannel 테스트 관례를 따르라.)

`discord.adapter.ts` — `reply` 시그니처에 `actions?: Action[]` 추가하고 **본문은 그대로 텍스트만 전송**(actions 사용 안 함). 예:
```ts
  async reply(target: ReplyTarget, text: string, _actions?: Action[]): Promise<void> {
    // actions는 self 클라 전용 — Discord는 프롬프트 텍스트로 폴백(하위호환).
    ...기존 본문...
  }
```
`import type { Action } from './messenger.port';`가 이미 Action을 안 가져오면 `from '../../../shared/protocol'`로.

`messenger-bridge.ts` — `MentionHandler.handleMention` post 타입 + post 생성:
```ts
export interface MentionHandler {
  handleMention(
    msg: CoreMessage,
    post: (text: string, actions?: Action[]) => Promise<void>,
    threadKey?: string,
  ): Promise<void>;
  observe?(msg: CoreMessage, post: (text: string) => Promise<void>): Promise<void>;
}
```
`bindMessenger`의 post:
```ts
    const post = (text: string, actions?: Action[]): Promise<void> => port.reply(e.target, text, actions);
```
상단에 `import type { Action } from '../../../shared/protocol';`.

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts src/edge/messenger/messenger-bridge.spec.ts` 그리고 `npx tsc --noEmit -p tsconfig.json`
Expected: PASS / 타입 에러 없음(Orchestrator의 post 타입은 Task 3에서 맞추므로, 여기서 tsc가 orchestrator post 불일치를 낼 수 있음 — 그럴 경우 Task 3와 함께 통과. 이 태스크 tsc는 messenger 파일만 우선 확인하고, orchestrator 관련 에러는 Task 3에서 해소된다고 report에 명시).

> 주의: `MentionHandler` post 타입을 넓히면 Orchestrator.handleMention의 `post: (text: string) => Promise<void>`가 구조적으로 여전히 호환(더 좁은 함수가 더 넓은 타입에 할당 가능). 즉 이 태스크만으로 tsc가 깨지지 않아야 정상. 깨지면 Orchestrator가 post를 actions와 함께 호출하는 곳이 없어서일 뿐 — Task 3에서 호출 추가.

- [ ] **Step 5: 커밋**

```bash
git add src/edge/messenger/messenger.port.ts src/edge/messenger/self.adapter.ts src/edge/messenger/discord.adapter.ts src/edge/messenger/messenger-bridge.ts src/edge/messenger/self.adapter.spec.ts src/edge/messenger/messenger-bridge.spec.ts
git commit -m "feat(phase11b): reply/post에 actions 옵셔널 스레딩(self 실음·Discord 무시·bridge 통과)"
```

---

### Task 3: Orchestrator — 결정 지점에 actions 첨부(승인·후보선택)

**Files:**
- Modify: `src/agent-layer/orchestrator.ts`
- Test: `src/agent-layer/orchestrator-actions.spec.ts` (신규)

**Interfaces:**
- Consumes: `Action`(shared/protocol), `post(text, actions?)`(Task 2).
- Produces:
  - Orchestrator 내부 `post` 타입을 `(text: string, actions?: Action[]) => Promise<void>`로(handleMention/startCoding/startProposal 시그니처).
  - `startProposal`이 완성조건 게시에 `[{label:'✅ 승인', send:'승인', confirm:'자율 코딩을 시작할까요?'}, {label:'취소', send:'취소'}]` 첨부.
  - `startCoding` 다중매치가 `[...후보 {label:`${i+1}. ${m}`, send:String(i+1)}, {label:'취소', send:'취소'}]` 첨부.

- [ ] **Step 1: 실패 테스트** — 신규 `src/agent-layer/orchestrator-actions.spec.ts`

기존 `orchestrator-modes.spec.ts`/`orchestrator-coding.spec.ts`의 Orchestrator 조립(스텁 reader/conversations/logger/ingester + projects/fence 주입)을 참고해 최소 구성. 핵심은 post가 actions와 함께 호출되는 것.

```ts
it('startProposal(코드 모드)은 완성조건 게시에 승인/취소 actions를 첨부한다', async () => {
  const orch = makeOrchestrator(); // projects+fence 주입 헬퍼(기존 spec 참고)
  const posts: { text: string; actions?: any }[] = [];
  const post = async (text: string, actions?: any) => { posts.push({ text, actions }); };
  await orch.handleMention({ text: '로그인 붙여줘', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1');
  const approve = posts.find((p) => p.actions);
  expect(approve?.actions).toEqual([
    { label: '✅ 승인', send: '승인', confirm: '자율 코딩을 시작할까요?' },
    { label: '취소', send: '취소' },
  ]);
});

it('startCoding 다중 매치는 후보 번호 actions + 취소를 첨부한다', async () => {
  const orch = makeOrchestrator();
  // resolveRepoPaths가 2개 반환하도록 coderepos 스텁(기존 spec 관례)
  jest.spyOn(orch as any, 'resolveRepoPaths').mockReturnValue(['C:/a', 'C:/b']);
  const posts: { text: string; actions?: any }[] = [];
  await orch.handleMention({ text: 'code foo 로그인', userId: 'c1' }, async (t, a) => { posts.push({ text: t, actions: a }); }, 'c1');
  const pick = posts.find((p) => p.actions);
  expect(pick?.actions).toEqual([
    { label: '1. C:/a', send: '1' },
    { label: '2. C:/b', send: '2' },
    { label: '취소', send: '취소' },
  ]);
});
```

> 헬퍼 이름·주입은 기존 orchestrator spec을 따른다. `code foo …` escape hatch가 startCoding으로 가는 경로는 기존과 동일.

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/agent-layer/orchestrator-actions.spec.ts`
Expected: FAIL(post에 actions 안 감).

- [ ] **Step 3: 구현** — `orchestrator.ts`

상단에 `import type { Action } from '../../shared/protocol';`(orchestrator.ts는 `src/agent-layer/` → repo root `shared/`는 `../../shared/protocol`).

`handleMention`·`startCoding`·`startProposal`·`launchCoding` 등에서 `post` 파라미터 타입을 전부 `(text: string, actions?: Action[]) => Promise<void>`로 통일(현재 `(text: string) => Promise<void>` / `(t: string) => Promise<void>`). 넓히기만 하면 되므로 기존 호출 무영향.

`startCoding` 다중매치(345–347행) 교체:
```ts
    if (matches.length > 1) {
      this.pending.set(threadKey, { kind: 'disambiguate', candidates: matches, goal });
      const actions: Action[] = [
        ...matches.map((m, i) => ({ label: `${i + 1}. ${m}`, send: String(i + 1) })),
        { label: '취소', send: '취소' },
      ];
      await post(`여러 개 찾았어요:\n${matches.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n@Engram <번호>로 골라주세요.`, actions);
      return;
    }
```

`startProposal`(360–364행)의 완성조건 게시 교체(텍스트 그대로 + actions):
```ts
    await post(
      `📁 대상: ${targetPath}\n📋 완성조건:\n${crit}\n` +
      `게이트: test=${cfg.gate.test}|build=${cfg.gate.build}|typecheck=${cfg.gate.typecheck}\n` +
      `맞으면 @Engram 승인 / 취소는 @Engram 취소`,
      [
        { label: '✅ 승인', send: '승인', confirm: '자율 코딩을 시작할까요?' },
        { label: '취소', send: '취소' },
      ],
    );
```

> 텍스트 프롬프트(`맞으면 @Engram 승인 …`)는 **그대로 유지** — Discord·폰 폴백 + 스테일 버튼 안전망. 버튼은 그 위 부가.

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/agent-layer/orchestrator-actions.spec.ts src/agent-layer/orchestrator-modes.spec.ts src/agent-layer/orchestrator-handle-mention.spec.ts` 그리고 `npx tsc --noEmit -p tsconfig.json`
Expected: PASS(기존 회귀 없음) / 타입 클린.

- [ ] **Step 5: 커밋**

```bash
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator-actions.spec.ts
git commit -m "feat(phase11b): Orchestrator가 승인·후보선택 결정 지점에 actions 첨부(pending 로직 무변경)"
```

---

### Task 4: 렌더러 — `ActionButtons` + Message/Thread/App 배선

**Files:**
- Create: `renderer/src/components/ActionButtons.tsx`
- Modify: `renderer/src/components/Message.tsx`
- Modify: `renderer/src/components/Thread.tsx`
- Modify: `renderer/src/App.tsx`
- Test: `renderer/src/components/ActionButtons.test.tsx`

**Interfaces:**
- Consumes: `Action`/`Message`(shared/protocol), 기존 `sendText`(App).
- Produces:
  - `ActionButtons({ actions, onSend })` — 버튼 줄. 클릭 시 `confirm`이 있으면 `window.confirm(confirm)` 통과해야 `onSend(action.send)`; 없으면 즉시. **전송 후 전체 버튼 비활성화**(중복 방지).
  - `Message`가 `m.actions` 있으면 `<ActionButtons actions={m.actions} onSend={onSend}>` 렌더. Message에 `onSend: (text: string) => void` prop 추가.
  - `Thread`가 `onSend`를 Message로 pass-through.
  - `App`이 `onSend={(text) => sendText(text)}`(현재 채널로 전송)를 Thread/Message에 전달.

- [ ] **Step 1: 실패 테스트** — `renderer/src/components/ActionButtons.test.tsx`

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { ActionButtons } from './ActionButtons';

it('confirm 없는 버튼은 즉시 onSend(send)한다', () => {
  const sent: string[] = [];
  render(<ActionButtons actions={[{ label: '취소', send: '취소' }]} onSend={(t) => sent.push(t)} />);
  fireEvent.click(screen.getByText('취소'));
  expect(sent).toEqual(['취소']);
});

it('confirm 있는 버튼은 확인해야 onSend, 거부하면 안 보낸다', () => {
  const sent: string[] = [];
  const spy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<ActionButtons actions={[{ label: '✅ 승인', send: '승인', confirm: '시작?' }]} onSend={(t) => sent.push(t)} />);
  fireEvent.click(screen.getByText('✅ 승인'));
  expect(sent).toEqual([]);            // 거부 → 미전송
  spy.mockReturnValue(true);
  fireEvent.click(screen.getByText('✅ 승인'));
  expect(sent).toEqual(['승인']);      // 확인 → 전송
  spy.mockRestore();
});

it('한 번 전송하면 버튼이 비활성화된다', () => {
  const sent: string[] = [];
  render(<ActionButtons actions={[{ label: '취소', send: '취소' }]} onSend={(t) => sent.push(t)} />);
  const btn = screen.getByText('취소') as HTMLButtonElement;
  fireEvent.click(btn);
  fireEvent.click(btn);
  expect(sent).toEqual(['취소']);      // 중복 클릭 무시
  expect(btn.disabled).toBe(true);
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm --prefix renderer test -- ActionButtons`
Expected: FAIL(컴포넌트 없음).

- [ ] **Step 3: `ActionButtons.tsx`**

```tsx
import { useState } from 'react';
import type { Action } from '../../../shared/protocol';

// 메시지에 실린 actions를 버튼 줄로. 되돌릴 수 없는 것(confirm 있음)만 네이티브 confirm 한 번.
// 한 번 보내면 전체 비활성화(중복 전송 방지). label은 React 이스케이프로만(XSS), send는 ws로만 나감.
export function ActionButtons({ actions, onSend }: { actions: Action[]; onSend: (text: string) => void }) {
  const [done, setDone] = useState(false);
  const click = (a: Action) => {
    if (done) return;
    if (a.confirm && !window.confirm(a.confirm)) return; // 거부 시 미전송(비활성화도 안 함)
    setDone(true);
    onSend(a.send);
  };
  return (
    <div className="actions">
      {actions.map((a) => (
        <button key={a.label} disabled={done} onClick={() => click(a)}>{a.label}</button>
      ))}
    </div>
  );
}
```

`renderer/src/theme.css`에 `.actions` 스타일 추가(입력바 버튼과 톤 맞춤, 마진만):
```css
.actions { display:flex; gap:8px; margin:8px 0 2px; flex-wrap:wrap; }
.actions button { padding:6px 14px; font-size:13px; }
.actions button:disabled { opacity:.5; cursor:default; }
```

- [ ] **Step 4: Message/Thread/App 배선**

`Message.tsx` — prop에 `onSend` 추가, 본문 뒤 ActionButtons:
```tsx
import { ActionButtons } from './ActionButtons';
// ...
export function Message({ m, onPick, onSend }: { m: Msg; onPick: (text: string) => void; onSend: (text: string) => void }) {
  // ...기존 ref 마운트 로직 그대로...
  return (
    <div className={'msg' + (isEngram ? '' : ' me')}>
      <div className="who">{...}</div>
      <div className="body" ref={bodyRef} />
      {m.actions && m.actions.length > 0 && <ActionButtons actions={m.actions} onSend={onSend} />}
    </div>
  );
}
```

`Thread.tsx` — props에 `onSend` 추가, 모든 `<Message>`에 전달:
```tsx
// props 타입에 onSend: (text: string) => void 추가
// <Message m={anchor} onPick={props.onPick} onSend={props.onSend} /> 등 전부에 onSend 전달
```

`App.tsx` — Thread 렌더에 `onSend={(text) => sendText(text)}` 추가(현재 채널 전송; `sendText`는 이미 있음). 예:
```tsx
<Thread key={m.id} anchor={m} replies={byAnchor.get(m.id) ?? []}
  draft={drafts.get(m.id) ?? ''} collapsed={collapsed.has(m.id)}
  onDraft={...} onReply={...} onPick={fill} onToggle={...}
  onSend={(text) => sendText(text)} />
```

> `sendText(text)`가 현재 채널로 `{t:'send', channelId, text}`를 보냄 → 서버 pending이 `"승인"`/`"1"`/`"취소"`를 기존대로 처리(Task 3의 텍스트와 동일). 즉 클릭=타이핑과 동일 경로. 스테일 버튼(오래된 메시지) 클릭 시 pending 없으면 일반 대화로 흘러 무해(기존 성질).

- [ ] **Step 5: 통과 + 빌드**

Run: `npm --prefix renderer test` 그리고 `npm --prefix renderer run build`
Expected: PASS(전체) / 빌드 성공.

- [ ] **Step 6: 커밋**

```bash
git add renderer/src/components/ActionButtons.tsx renderer/src/components/ActionButtons.test.tsx renderer/src/components/Message.tsx renderer/src/components/Thread.tsx renderer/src/App.tsx renderer/src/theme.css
git commit -m "feat(phase11b): ActionButtons(승인 confirm·중복방지) + Message/Thread/App 배선"
```

---

### Task 5: 3영역 데이터·설정 (config flag + i18n)

**Files:**
- Modify: `renderer/src/config.ts`
- Modify: `renderer/src/i18n.ts`
- Test: (설정·문구는 순수 상수 — Task 6의 Channels 테스트가 소비. 별도 테스트 불필요; `npm --prefix renderer run build` 타입확인.)

**Interfaces:**
- Consumes: 없음.
- Produces: `config.TEAM_CHAT: boolean`(기본 false), `T.tabAsk`/`T.tabTeam`.

- [ ] **Step 1: `config.ts`에 flag 추가**

```ts
// 사람 팀채팅(Team) 영역 — Phase 11b는 구조만, 서버 없으니 기본 숨김(Phase 14에서 켠다).
export const TEAM_CHAT = false;
```

- [ ] **Step 2: `i18n.ts` 문구** — `tabChat`을 `tabAsk`로 대체 + `tabTeam` 추가

```ts
  tabAsk: ko ? '챗봇' : 'Ask',
  tabTeam: ko ? '채팅' : 'Team',
  tabCode: ko ? '코드' : 'Code',
```
(기존 `tabChat` 줄 제거. Task 6에서 참조를 tabAsk로 바꾼다.)

- [ ] **Step 3: 빌드 타입확인**

Run: `npm --prefix renderer run build`
Expected: 실패해도 됨 — Channels.tsx가 아직 `T.tabChat`을 참조하면 여기서 타입 에러. Task 6에서 함께 통과. (또는 이 태스크에서 Channels의 tabChat→tabAsk 참조만 먼저 바꿔 빌드 통과시켜도 됨. 구현자 판단, report에 명시.)

- [ ] **Step 4: 커밋**

```bash
git add renderer/src/config.ts renderer/src/i18n.ts
git commit -m "feat(phase11b): TEAM_CHAT flag(기본 off) + i18n tabAsk/tabTeam"
```

---

### Task 6: Channels 3탭 네비(Ask·Code + flag Team) + App 영역 로직

**Files:**
- Create: `renderer/src/areas.ts` (순수 탭 목록 — 두 flag 상태 다 테스트 가능하게 분리)
- Modify: `renderer/src/components/Channels.tsx`
- Modify: `renderer/src/App.tsx`
- Test: `renderer/src/areas.test.ts` (신규), `renderer/src/components/Channels.test.tsx` (신규)

**Interfaces:**
- Consumes: `TEAM_CHAT`(config), `T.tabAsk`/`tabTeam`/`tabCode`, `Channel.mode:'chat'|'code'|'team'`.
- Produces:
  - `areaTabs(teamChat: boolean): ('chat' | 'code' | 'team')[]` — 순수. `false`→`['chat','code']`, `true`→`['chat','team','code']`. (Team은 Ask와 Code 사이.)
  - 네비 탭 = Ask(mode 'chat')·Code(mode 'code') 항상 + Team(mode 'team') `TEAM_CHAT`일 때만.
  - App의 `mode` 상태 타입 `'chat'|'code'|'team'`. 새 채널은 현재 탭 모드로 생성(team이면 `createChannel{mode:'team'}`).
  - 채널 목록은 현재 탭 모드로 필터(기존 per-mode 필터 유지).

- [ ] **Step 1: 실패 테스트** — `areaTabs`(순수, 두 flag 상태) + Channels 렌더(off)

`renderer/src/areas.test.ts`:
```ts
import { areaTabs } from './areas';

it('flag off면 Ask·Code만, on이면 Team이 Ask와 Code 사이에', () => {
  expect(areaTabs(false)).toEqual(['chat', 'code']);
  expect(areaTabs(true)).toEqual(['chat', 'team', 'code']);
});
```

`renderer/src/components/Channels.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { Channels } from './Channels';

const base = {
  channels: [{ id: 'a', name: 'ask1', respondMode: 'all', mode: 'chat' }],
  current: 'a', onSelect: () => {}, onSetMode: () => {}, onCreate: () => {}, onDelete: () => {}, onSetRespondMode: () => {},
} as any;

it('Ask·Code 탭 렌더, Team은 flag off면 안 보인다', () => {
  render(<Channels {...base} mode="chat" />);
  expect(screen.getByText(/Ask|챗봇/)).toBeInTheDocument();
  expect(screen.getByText(/Code|코드/)).toBeInTheDocument();
  expect(screen.queryByText(/Team|^채팅$/)).toBeNull(); // TEAM_CHAT=false
});
```

> flag on/off **분기 자체는 `areaTabs`로 순수 단위테스트**(둘 다 검증). Channels 렌더 테스트는 실제 상수(off) 경로만 — 상수를 목킹하지 않아도 분기 로직은 areaTabs가 커버하므로 게이팅이 리뷰-only로 새지 않는다.

- [ ] **Step 2: 실패 확인**

Run: `npm --prefix renderer test -- areas Channels`
Expected: FAIL(`areaTabs` 없음 / Channels 2탭·Ask 라벨 없음).

- [ ] **Step 3: 구현** — `areas.ts` + `Channels.tsx`

`renderer/src/areas.ts`:
```ts
// 3영역 네비 탭 순서/게이팅(순수 — flag on/off 둘 다 단위테스트 가능). Team은 flag on일 때만.
export function areaTabs(teamChat: boolean): ('chat' | 'code' | 'team')[] {
  return teamChat ? ['chat', 'team', 'code'] : ['chat', 'code'];
}
```

`Channels.tsx` 상단 import에 `import { TEAM_CHAT } from '../config';`·`import { areaTabs } from '../areas';`. 탭을 areaTabs로 만들고 mode→라벨 매핑:
```tsx
  const label: Record<'chat' | 'code' | 'team', string> = { chat: T.tabAsk, team: T.tabTeam, code: T.tabCode };
  const tabs = areaTabs(TEAM_CHAT);
```
`#modetabs` 렌더를 이 배열로 교체(기존 `['chat','code']` 하드코딩 대신):
```tsx
      <div id="modetabs">
        {tabs.map((t) => (
          <div key={t} className={'mtab' + (t === mode ? ' sel' : '')} onClick={() => props.onSetMode(t)}>
            {label[t]}
          </div>
        ))}
      </div>
```
`props`의 `mode`/`onSetMode`/`onCreate` 타입을 `'chat'|'code'` → `'chat'|'code'|'team'`로 확장. `visible` 필터는 그대로(`(c.mode || 'chat') === mode`).

`App.tsx`:
- `const [mode, setMode] = useState<'chat' | 'code'>('chat');` → `useState<'chat' | 'code' | 'team'>('chat')`.
- `onSetMode`/`onCreate` 콜백 타입도 `'chat'|'code'|'team'` 수용(Channels에 넘기는 것들). `send({ t: 'createChannel', name, mode: m })`는 그대로(protocol Channel.mode가 team 허용 — Task 1).
- Code empty-state/헤더 분기(`(ch.mode||'chat')==='code'`)는 그대로. team은 Ask처럼 일반 채팅 UI(특수 처리 없음).

- [ ] **Step 4: 통과 + 빌드**

Run: `npm --prefix renderer test` 그리고 `npm --prefix renderer run build`
Expected: PASS(전체) / 빌드 성공(Task 5의 tabAsk 참조 해소).

- [ ] **Step 5: 커밋**

```bash
git add renderer/src/components/Channels.tsx renderer/src/components/Channels.test.tsx renderer/src/App.tsx
git commit -m "feat(phase11b): 3영역 네비(Ask·Code + flag Team), Chat→Ask 재편"
```

---

## Self-Review

**1. 스펙 커버리지** (Phase 11 spec §3~§6):
- §3 영역 3개(Team flag숨김/Ask/Code) → Task 5·6. Ask↔respondMode all·mode chat, Code↔mode code+repoPath(기존 유지), Team↔mode team(신규, flag) → Task 1(데이터)·6(네비). 영역별 채널 필터·새 채널 현재 영역 → Task 6. feature flag `TEAM_CHAT` → Task 5.
- §4 `Message.actions` + `Action{label,send,confirm?}` → Task 1. ChatStore append/broadcast actions(옵셔널·하위호환) → Task 1·2. 블록파싱 꼼수 불채택(정식 필드) → Task 1.
- §5 서버 결정지점 actions 첨부(승인·후보선택, 텍스트 프로토콜 유지) → Task 3. post(text, actions?) 옵셔널 인자 → Task 2. ActionButtons(confirm 게이트·즉시전송·전송 후 비활성화) → Task 4. 서버 로직 변화 0(클릭=기존 텍스트) → Task 3 주석·Task 4 배선. Discord 폴백(무시) → Task 2. label textContent/이스케이프·send만 ws → Task 4.
- §6 데이터 흐름(승인 버튼: handleMention→startProposal→post(actions)→reply→appendMessage→broadcast→ActionButtons→confirm→send'승인'→pending) → Task 1~4 합.
- ⟶ 전 항목 태스크 있음.

**2. 플레이스홀더 스캔**: 각 코드 스텝에 실제 코드. 두뇌 테스트 헬퍼(makeOrchestrator/FakeMessenger/sendFrame)는 "기존 spec 관례 따르라" 명시(구현자가 실제 이름 확인). TODO/TBD 없음.

**3. 타입 일관성**: `Action{label,send,confirm?}`·`Message.actions?`·`Channel.mode:'chat'|'code'|'team'`·`reply(target,text,actions?)`·`post(text,actions?)`·`appendMessage(...actions?)`·`ActionButtons{actions,onSend}`·`Message/Thread onSend`·`TEAM_CHAT` 전 태스크 동일. Orchestrator post 넓히기는 구조적 하위호환(Task 2 주석).

**설계 결정(스펙이 안 박은 것)**: Team 영역 데이터 = `mode:'team'` 추가(Ask=chat과 구분, Code 흐름과 직교). 근거: 기존 mode 필드 최소 확장, Orchestrator는 'code'만 특수라 team은 코드 0(mention-only는 respondMode가 이미 처리). flag off 기본이라 11b에선 team 채널 생성 불가=봉인. Phase 14가 flag만 켜면 열림. (대안: respondMode로 area 파생 → mode/respondMode 개념 충돌로 기각.)

**11b 비범위(후속)**: 다중 연결·@Tag(12), 인증·원격(13), Team 실동작(14). ActionButtons는 self 클라 전용(Discord는 텍스트 폴백).

## Execution Handoff

플랜 저장: `docs/superpowers/plans/2026-07-06-phase11b-areas-actions.md`.

**두 실행 옵션:**
1. **Subagent-Driven(권장)** — 태스크별 신규 서브에이전트 + per-task 리뷰 + 최종 전체리뷰(11a와 동일 방식). 서버(Task 1~3)→렌더러(Task 4~6) 순.
2. **Inline Execution** — 이 세션에서 executing-plans로 배치 실행.

어느 쪽으로?
