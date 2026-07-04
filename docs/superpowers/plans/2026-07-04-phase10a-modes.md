# Phase 10a — 모드 분리(Chat/Code) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 채팅 UI에 상위 개념 모드(Chat/Code)를 두어, Code 채널은 폴더(레포)에 바인딩되고 그 채널의 메시지는 classify를 건너뛰고 바로 코딩 흐름으로 간다(오분류 원천 차단).

**Architecture:** 데이터상 채널에 `mode`('chat'|'code')·`repoPath`를 추가하고(ChatStore), 자체 어댑터(SelfMessenger)가 Code 채널 메시지에 mode/repo 컨텍스트를 실어 `handleMention`에 넘긴다. Orchestrator는 `mode==='code'`면 classify를 건너뛰고 바인딩된 경로로 `startProposal`. 폴더 선택은 Electron 네이티브 대화상자(IPC), 브라우저는 텍스트 폴백. 코어 계약(CoreMessage/MentionEvent)에 옵셔널 필드만 추가 — Discord 어댑터는 미설정이라 기존 동작(=chat) 유지.

**Tech Stack:** TypeScript, NestJS, ws(WebSocket), Electron(dialog/ipcMain/contextBridge), Jest.

## Global Constraints

- 새 npm 의존성 0 (전부 기존 자산).
- 코어(Orchestrator/ReaderAgent)는 채널·모드 특유 개념을 몰라야 함 — 확장은 CoreMessage/MentionEvent의 **옵셔널** 필드로만(하위호환).
- 외부 문자열은 chat.html에서 전부 `textContent`/DOM 조립(innerHTML 금지, XSS 유지).
- Electron은 `window.prompt` 미지원 — 인라인 입력으로 대체.
- UI 문구는 영어 기본 + ko 로케일 한국어(설정창·chat.html 관례).
- 채널 파일명 신뢰경계: channelId는 `safeId()` 통과분만 파일에 쓴다(기존 규칙 유지).
- 셸은 PowerShell(이 머신 Bash 훅 깨짐). 테스트: `npx jest <spec경로>`.

---

### Task 1: ChatStore — mode + repoPath 필드

**Files:**
- Modify: `src/edge/messenger/chat-store.ts`
- Test: `src/edge/messenger/chat-store.spec.ts`

**Interfaces:**
- Consumes: 없음(기존 ChatStore).
- Produces:
  - `ChatChannel`에 `mode?: 'chat' | 'code'`, `repoPath?: string` 추가.
  - `createChannel(name: string, mode?: 'chat' | 'code'): ChatChannel | null` — mode 기본 'chat'.
  - `setRepoPath(id: string, repoPath: string): boolean`.
  - `listChannels()`가 `mode`를 정규화('code'만 code, 그 외/누락=chat).

- [ ] **Step 1: 실패 테스트 작성** — `src/edge/messenger/chat-store.spec.ts`에 추가

```ts
it('createChannel이 mode를 저장하고 listChannels가 정규화한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatstore-'));
  const store = new ChatStore(dir);
  const code = store.createChannel('build-app', 'code');
  const chat = store.createChannel('talk'); // 기본 chat
  expect(code?.mode).toBe('code');
  const list = store.listChannels();
  expect(list.find((c) => c.id === code!.id)?.mode).toBe('code');
  expect(list.find((c) => c.id === chat!.id)?.mode).toBe('chat');
});

it('setRepoPath가 채널에 경로를 바인딩한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatstore-'));
  const store = new ChatStore(dir);
  const ch = store.createChannel('c', 'code')!;
  expect(store.setRepoPath(ch.id, 'C:/repo/x')).toBe(true);
  expect(store.listChannels().find((c) => c.id === ch.id)?.repoPath).toBe('C:/repo/x');
  expect(store.setRepoPath('nope', 'C:/y')).toBe(false);
});

it('mode 필드가 오염돼도 chat으로 강등한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatstore-'));
  fs.writeFileSync(path.join(dir, 'channels.json'),
    JSON.stringify([{ id: 'a', name: 'a', respondMode: 'all', mode: 'bogus' }]));
  const store = new ChatStore(dir);
  expect(store.listChannels().find((c) => c.id === 'a')?.mode).toBe('chat');
});
```

파일 상단에 `import * as os from 'os';`가 없으면 추가(기존 테스트 관례 확인).

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/chat-store.spec.ts`
Expected: FAIL (`createChannel` 인자 2개 미지원 / `setRepoPath` 없음).

- [ ] **Step 3: 최소 구현** — `chat-store.ts` 수정

`ChatChannel` 인터페이스:

```ts
export interface ChatChannel {
  id: string;
  name: string;
  respondMode: 'all' | 'mention';
  mode?: 'chat' | 'code';              // Phase 10: 상위 모드. 누락/오염=chat.
  repoPath?: string;                   // Phase 10: Code 채널이 바인딩한 레포 절대경로.
  ownerId?: string;                    // 9b: 계정 도입 시 소유자
  visibility?: 'public' | 'private';   // 9b: 비공개 잠금
}
```

`listChannels()`의 정규화 `.map`을 교체(mode 정규화 추가):

```ts
list = raw
  .filter((c) => c && safeId(c.id) && typeof c.name === 'string')
  .map((c) => ({
    ...c,
    respondMode: c.respondMode === 'mention' ? 'mention' : 'all',
    mode: c.mode === 'code' ? 'code' : 'chat',
  }));
```

기본 채널 생성부도 mode 명시:

```ts
list = [{ id: 'general', name: 'general', respondMode: 'all', mode: 'chat' }];
```

`createChannel` 교체:

```ts
createChannel(name: string, mode: 'chat' | 'code' = 'chat'): ChatChannel | null {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return null;
  const list = this.listChannels();
  const ch: ChatChannel = { id: randomUUID(), name: trimmed, respondMode: 'all', mode: mode === 'code' ? 'code' : 'chat' };
  list.push(ch);
  this.save(list);
  return ch;
}
```

`setRespondMode` 아래에 추가:

```ts
setRepoPath(id: string, repoPath: string): boolean {
  if (typeof repoPath !== 'string' || !repoPath.trim()) return false;
  const list = this.listChannels();
  const ch = list.find((c) => c.id === id);
  if (!ch) return false;
  ch.repoPath = repoPath.trim();
  this.save(list);
  return true;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/messenger/chat-store.spec.ts`
Expected: PASS(신규 3건 포함 전체).

- [ ] **Step 5: 커밋**

```bash
git add src/edge/messenger/chat-store.ts src/edge/messenger/chat-store.spec.ts
git commit -m "feat(phase10a): ChatStore에 채널 mode(chat/code)+repoPath 추가"
```

---

### Task 2: 코어 계약 확장 + SelfMessenger ws 프로토콜(mode·setRepoPath·code 컨텍스트)

**Files:**
- Modify: `src/edge/core-message.ts`
- Modify: `src/edge/messenger/messenger.port.ts`
- Modify: `src/edge/messenger/self.adapter.ts`
- Test: `src/edge/messenger/self.adapter.spec.ts`

**Interfaces:**
- Consumes: `ChatStore.createChannel(name, mode)`, `ChatStore.setRepoPath` (Task 1).
- Produces:
  - `CoreMessage`에 `mode?: 'chat' | 'code'`, `repoPath?: string`.
  - `MentionEvent`에 `mode?: 'chat' | 'code'`, `repoPath?: string`.
  - ws 프레임: `createChannel {name, mode?}` 확장, `setRepoPath {id, repoPath}` 신규.
  - `onSend`이 Code 채널 메시지의 MentionEvent에 `mode`/`repoPath`를 실어 보냄.

- [ ] **Step 1: 실패 테스트 작성** — `src/edge/messenger/self.adapter.spec.ts`에 추가

기존 테스트가 SelfMessenger를 임시 포트(0)로 띄우고 ws로 프레임을 주고받는 헬퍼를 쓸 것이다. 그 관례를 그대로 따라 아래를 추가(헬퍼 이름은 기존 파일에 맞춰 조정):

```ts
it('Code 채널 send는 mention 이벤트에 mode/repoPath를 싣는다', async () => {
  // store에 code 채널 + repoPath 바인딩
  const ch = store.createChannel('build', 'code')!;
  store.setRepoPath(ch.id, 'C:/repo/app');
  let captured: MentionEvent | null = null;
  self.onMention(async (e) => { captured = e; });
  await sendFrame({ t: 'send', channelId: ch.id, text: '@Engram 로그인 붙여줘' });
  expect(captured!.mode).toBe('code');
  expect(captured!.repoPath).toBe('C:/repo/app');
});

it('setRepoPath 프레임이 채널에 경로를 바인딩하고 channels를 브로드캐스트한다', async () => {
  const ch = store.createChannel('build', 'code')!;
  const got = onceBroadcast('channels'); // 다음 channels 프레임 대기(기존 헬퍼)
  await sendFrame({ t: 'setRepoPath', id: ch.id, repoPath: 'C:/repo/app' });
  const frame = await got;
  expect(frame.list.find((c: any) => c.id === ch.id).repoPath).toBe('C:/repo/app');
});

it('createChannel 프레임의 mode가 전달된다', async () => {
  const got = onceBroadcast('channels');
  await sendFrame({ t: 'createChannel', name: 'coder', mode: 'code' });
  const frame = await got;
  expect(frame.list.find((c: any) => c.name === 'coder').mode).toBe('code');
});
```

> 기존 spec의 setup(`self`, `store`, `sendFrame`, `onceBroadcast`)을 재사용하라. 헬퍼가 없으면 기존 스모크 테스트가 ws 연결·프레임 전송을 어떻게 하는지 보고 동일 패턴으로 최소 헬퍼를 파일 내에 만든다. `MentionEvent` import 확인.

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: FAIL (`setRepoPath` 미처리, mode/repoPath undefined).

- [ ] **Step 3: 구현**

`src/edge/core-message.ts` — 옵셔널 필드 추가:

```ts
export interface CoreMessage {
  text: string;
  userId: string;
  mode?: 'chat' | 'code'; // Phase 10: Code 채널이면 classify 건너뛰고 코딩으로.
  repoPath?: string;      // Phase 10: Code 채널이 바인딩한 레포 절대경로.
}
```

`src/edge/messenger/messenger.port.ts` — `MentionEvent`에 추가:

```ts
export interface MentionEvent {
  text: string;
  channelId: string;
  threadId?: string;
  authorId: string;
  target: ReplyTarget;
  mode?: 'chat' | 'code'; // Phase 10: 어댑터가 채널 모드를 실어줌(Discord는 미설정=chat).
  repoPath?: string;      // Phase 10: Code 채널 바인딩 경로.
}
```

`src/edge/messenger/self.adapter.ts` — `handleFrame`의 switch에 `setRepoPath` 케이스 추가(`createChannel` 케이스 옆):

```ts
case 'createChannel':
  if (typeof f.name === 'string') this.store.createChannel(f.name, f.mode === 'code' ? 'code' : 'chat');
  this.broadcast({ t: 'channels', list: this.store.listChannels() });
  return;
case 'setRepoPath':
  if (typeof f.id === 'string' && typeof f.repoPath === 'string') this.store.setRepoPath(f.id, f.repoPath);
  this.broadcast({ t: 'channels', list: this.store.listChannels() });
  return;
```

`onSend`에서 MentionEvent 조립부(현재 `const e: MentionEvent = {...}`)에 mode/repoPath 추가:

```ts
const e: MentionEvent = {
  text: stripEngramMention(text, name),
  channelId,
  authorId: msg.authorId,
  target: { channelId, anchorId: anchor } satisfies SelfTarget as ReplyTarget,
  ...(ch.mode === 'code' ? { mode: 'code' as const, repoPath: ch.repoPath } : {}),
};
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts src/edge/core-message.spec.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/edge/core-message.ts src/edge/messenger/messenger.port.ts src/edge/messenger/self.adapter.ts src/edge/messenger/self.adapter.spec.ts
git commit -m "feat(phase10a): ws setRepoPath·createChannel mode + Code 채널 send에 mode/repo 컨텍스트"
```

---

### Task 3: messenger-bridge가 mode/repoPath를 handleMention에 전달

**Files:**
- Modify: `src/edge/messenger/messenger-bridge.ts`
- Test: `src/edge/messenger/messenger-bridge.spec.ts`

**Interfaces:**
- Consumes: `MentionEvent.mode`/`.repoPath` (Task 2).
- Produces: `handleMention`에 `{ text, userId: channelId, mode, repoPath }` 전달(mode 미설정이면 필드 생략=기존 동작).

- [ ] **Step 1: 실패 테스트 작성** — `messenger-bridge.spec.ts`에 추가

```ts
it('mention 이벤트의 mode/repoPath를 handleMention에 넘긴다', async () => {
  const calls: any[] = [];
  const orch = { handleMention: async (m: any) => { calls.push(m); } };
  const port = new FakeMessenger(); // 기존 테스트 헬퍼
  bindMessenger(port, orch as any, { warn() {} });
  await port.emitMention({ text: 'x', channelId: 'c1', authorId: 'u', target: {}, mode: 'code', repoPath: 'C:/r' });
  expect(calls[0].mode).toBe('code');
  expect(calls[0].repoPath).toBe('C:/r');
});
```

> `FakeMessenger.emitMention`의 정확한 시그니처는 기존 spec을 따른다.

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/messenger-bridge.spec.ts`
Expected: FAIL (mode/repoPath가 handleMention에 안 감).

- [ ] **Step 3: 구현** — `messenger-bridge.ts`의 `onMention` 콜백 내부 handleMention 호출을 교체:

```ts
port.onMention(async (e) => {
  const post = (text: string): Promise<void> => port.reply(e.target, text);
  const threadKey = e.threadId ?? e.channelId;
  try {
    await orchestrator.handleMention(
      { text: e.text, userId: e.channelId, ...(e.mode ? { mode: e.mode, repoPath: e.repoPath } : {}) },
      post,
      threadKey,
    );
  } catch (err) {
    logger.warn(`멘션 처리 실패: ${String(err)}`, 'Messenger');
    try { await post('지금 처리가 안 되네요 🙏'); } catch { /* post도 실패하면 포기 */ }
  }
});
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/messenger/messenger-bridge.spec.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/edge/messenger/messenger-bridge.ts src/edge/messenger/messenger-bridge.spec.ts
git commit -m "feat(phase10a): bridge가 mode/repoPath를 handleMention에 전달"
```

---

### Task 4: Orchestrator — Code 모드 라우팅(classify 건너뛰기)

**Files:**
- Modify: `src/agent-layer/orchestrator.ts`
- Test: `src/agent-layer/orchestrator-coding.spec.ts` (또는 새 `orchestrator-modes.spec.ts`)

**Interfaces:**
- Consumes: `CoreMessage.mode`/`.repoPath` (Task 2), 기존 `startProposal`, `channelGate`.
- Produces: `handleMention`이 `msg.mode === 'code' && msg.repoPath`면 classify 없이 `startProposal(repoPath, trimmed, ...)`. escape hatch(team/ask/code/schedule)는 그 위에서 여전히 동작(벽 아님).

- [ ] **Step 1: 실패 테스트 작성** — 새 파일 `src/agent-layer/orchestrator-modes.spec.ts`

기존 `orchestrator-coding.spec.ts`의 Orchestrator 조립(스텁 reader/conversations/logger/ingester + projects/fence 주입)을 참고해 최소 구성. 핵심은 `startProposal`이 호출되고 `classify`(두뇌)가 호출되지 않는 것.

```ts
it('Code 모드 메시지는 classify를 건너뛰고 바인딩된 경로로 startProposal 한다', async () => {
  const orch = makeOrchestrator(); // projects+fence+brain 주입된 헬퍼
  const spyProposal = jest.spyOn(orch as any, 'startProposal').mockResolvedValue(undefined);
  const spyClassify = jest.spyOn(orch as any, 'classify');
  const posts: string[] = [];
  await orch.handleMention(
    { text: '로그인 붙여줘', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' },
    async (t) => { posts.push(t); },
    'c1',
  );
  expect(spyClassify).not.toHaveBeenCalled();
  expect(spyProposal).toHaveBeenCalledWith('C:/repo/app', '로그인 붙여줘', 'c1', expect.any(Function));
});

it('Code 모드인데 repoPath 미바인딩이면 안내만 한다', async () => {
  const orch = makeOrchestrator();
  const spyProposal = jest.spyOn(orch as any, 'startProposal');
  const posts: string[] = [];
  await orch.handleMention(
    { text: '뭐든', userId: 'c1', mode: 'code' },
    async (t) => { posts.push(t); }, 'c1',
  );
  expect(spyProposal).not.toHaveBeenCalled();
  expect(posts.join('')).toMatch(/폴더|folder/i);
});

it('Code 채널에서도 team escape hatch는 협업으로 간다(벽 아님)', async () => {
  const orch = makeOrchestrator();
  const spyCollab = jest.spyOn(orch as any, 'launchCollaboration').mockReturnValue(undefined);
  await orch.handleMention(
    { text: 'team Recon 시장조사', userId: 'c1', mode: 'code', repoPath: 'C:/r' },
    async () => {}, 'c1',
  );
  expect(spyCollab).toHaveBeenCalled();
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/agent-layer/orchestrator-modes.spec.ts`
Expected: FAIL (mode 라우팅 없음 → classify 탐).

- [ ] **Step 3: 구현** — `orchestrator.ts` `handleMention`에서, escape hatch(`ask ` 블록 끝) **직후, `const decision = await this.classify(trimmed)` 바로 앞**에 삽입:

```ts
// Code 채널(Phase 10): classify 건너뛰고 바인딩된 repoPath로 바로 코딩(오분류 차단).
// 벽은 아님 — 위의 escape hatch(team/ask/code/schedule)가 이미 처리됐다면 여기 안 옴.
if (msg.mode === 'code') {
  if (!msg.repoPath) {
    await post('이 채널엔 아직 작업 폴더가 없어요. 채널에 들어가 폴더를 먼저 선택해 주세요 📁');
    return;
  }
  if (!(await this.channelGate('coding', msg.userId, post))) return;
  await this.startProposal(msg.repoPath, trimmed, threadKey, post);
  return;
}
```

> 위치가 중요: pending(승인/후보선택) 처리와 escape hatch보다 **뒤**, classify보다 **앞**. pending 상태(승인 대기)일 때 `승인`/`취소`/번호가 먼저 소비되고, 그 외 Code 채널 메시지는 이 블록이 잡는다.

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/agent-layer/orchestrator-modes.spec.ts src/agent-layer/orchestrator-handle-mention.spec.ts`
Expected: PASS(기존 handle-mention 회귀 없음).

- [ ] **Step 5: 커밋**

```bash
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator-modes.spec.ts
git commit -m "feat(phase10a): Code 모드는 classify 건너뛰고 바인딩 경로로 startProposal"
```

---

### Task 5: Electron 폴더 선택 대화상자(IPC + chat 프리로드)

**Files:**
- Create: `src/desktop/chat-preload.ts`
- Modify: `src/desktop/main.ts`
- Test: 없음(Electron 런타임 — 수동 검증). 순수 로직 없음.

**Interfaces:**
- Consumes: 없음.
- Produces: chat 창의 렌더러가 `window.engramDesktop.pickFolder(): Promise<string | null>` 호출 가능. 메인은 `dialog.showOpenDialog({properties:['openDirectory']})`로 응답.

- [ ] **Step 1: chat-preload.ts 작성**

```ts
import { contextBridge, ipcRenderer } from 'electron';

// 채팅 창(renderer)이 Code 채널 폴더 바인딩에 쓰는 최소 API.
// 브라우저(폰)엔 이 객체가 없으므로 chat.html이 텍스트 입력으로 폴백한다.
contextBridge.exposeInMainWorld('engramDesktop', {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('engram:pick-folder'),
});
```

- [ ] **Step 2: main.ts — IPC 핸들러 추가**

상단 import에 `dialog` 추가: `import { app, BrowserWindow, dialog, ipcMain, Menu, ... } from 'electron';`

`registerIpc()` 안에 추가:

```ts
ipcMain.handle('engram:pick-folder', async () => {
  const win = chatWin ?? undefined;
  const r = win
    ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    : await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
});
```

- [ ] **Step 3: main.ts — chat 창에 프리로드 연결**

`openChat()`의 `new BrowserWindow({...})`에 `webPreferences` 추가:

```ts
chatWin = new BrowserWindow({
  width: 980, height: 720, title: 'Engram',
  icon: trayIcon(),
  titleBarStyle: 'hidden', titleBarOverlay: overlay(),
  backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0e13' : '#f2f7fb',
  webPreferences: { preload: path.join(__dirname, 'chat-preload.js') },
});
```

- [ ] **Step 4: 빌드 확인**

Run: `npx tsc --noEmit -p tsconfig.json` (또는 프로젝트의 typecheck 스크립트)
Expected: 에러 없음.

- [ ] **Step 5: 커밋**

```bash
git add src/desktop/chat-preload.ts src/desktop/main.ts
git commit -m "feat(phase10a): Electron 폴더 선택 대화상자 IPC + 채팅 창 프리로드"
```

---

### Task 6: chat.html — 모드 탭 + 모드별 채널 필터 + Code empty state(폴더 선택) + 레포 헤더

**Files:**
- Modify: `src/desktop/chat.html`
- Test: 없음(자동 테스트 없는 렌더러 — 수동 검증 절차 포함).

**Interfaces:**
- Consumes: `window.engramDesktop?.pickFolder`(Task 5), ws 프레임 `createChannel {name, mode}`·`setRepoPath {id, repoPath}`(Task 2), 채널의 `mode`/`repoPath`(Task 1).
- Produces: 상단 Chat/Code 탭, 탭별 채널 목록 분리, Code 채널 첫 진입 시 폴더 선택 empty state, 바인딩 후 입력창 개방 + 헤더 `📁 폴더명`.

- [ ] **Step 1: i18n 문구 추가** — `<script>` 상단 `T` 객체에 추가

```js
tabChat: ko ? '채팅' : 'Chat',
tabCode: ko ? '코드' : 'Code',
pickFolder: ko ? '먼저 작업할 폴더를 선택하세요 📁' : 'First choose a folder to work in 📁',
pickFolderBtn: ko ? '폴더 선택' : 'Choose folder',
pickFolderPath: ko ? '폴더 경로 입력…' : 'Folder path…',
newCodeChannelPrompt: ko ? '코드 채널 이름:' : 'Code channel name:',
```

- [ ] **Step 2: 모드 탭 마크업 + 스타일**

`#titlebar` 아래(또는 `#side` 최상단)에 탭 바 추가. `#side`를 감싸는 구조를 바꾸지 않도록 `#channels` 위에 삽입:

`<div id="side">` 안 `<div id="channels">` **앞**에 추가:

```html
<div id="modetabs">
  <div class="mtab sel" data-mode="chat"></div>
  <div class="mtab" data-mode="code"></div>
</div>
```

`<style>`에 추가:

```css
#modetabs { display:flex; border-bottom:1px solid var(--line); }
#modetabs .mtab { flex:1; text-align:center; padding:9px 0; cursor:pointer; color:var(--dim);
                  font-size:12.5px; font-weight:600; border-bottom:2px solid transparent; }
#modetabs .mtab:hover { background:var(--hover); }
#modetabs .mtab.sel { color:var(--accent); border-bottom-color:var(--accent); }
#empty { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
         gap:14px; color:var(--dim); padding:24px; text-align:center; }
#empty button { padding:10px 18px; }
#chhdr { flex:none; padding:6px 16px; font-size:12px; color:var(--dim);
         border-bottom:1px solid var(--line); display:none; }
```

`#main` 안 `#msgs` 위에 헤더 자리 추가:

```html
<div id="main">
  <div id="chhdr"></div>
  <div id="msgs"></div>
  ...
```

- [ ] **Step 3: 상태·탭 로직**

`// ---- 상태 ----` 블록에 추가:

```js
let mode = 'chat'; // 현재 보고 있는 탭
```

탭 클릭 배선(초기화 코드 근처, `connect()` 호출 전):

```js
document.querySelectorAll('#modetabs .mtab').forEach((el) => {
  el.textContent = el.dataset.mode === 'chat' ? T.tabChat : T.tabCode;
  el.onclick = () => {
    mode = el.dataset.mode;
    document.querySelectorAll('#modetabs .mtab').forEach((t) => t.classList.toggle('sel', t.dataset.mode === mode));
    // 현재 선택 채널이 이 모드가 아니면 이 모드의 첫 채널로 이동
    const visible = channels.filter((c) => (c.mode || 'chat') === mode);
    if (!visible.some((c) => c.id === current)) selectChannel(visible[0] && visible[0].id);
    renderChannels();
    renderMsgs();
  };
});
```

- [ ] **Step 4: renderChannels 모드 필터**

`renderChannels()`의 `for (const c of channels)`를 필터로 교체:

```js
function renderChannels() {
  const box = document.getElementById('channels');
  box.replaceChildren();
  for (const c of channels.filter((c) => (c.mode || 'chat') === mode)) {
    // ... 기존 항목 생성 그대로 ...
  }
}
```

- [ ] **Step 5: 새 채널을 현재 모드로 생성**

`#newch` onclick 핸들러의 placeholder와 send 프레임을 모드 반영으로:

```js
inp.placeholder = mode === 'code' ? T.newCodeChannelPrompt : T.newChannelPrompt;
// ...
if (e.key === 'Enter' && inp.value.trim() && ws && ws.readyState === WebSocket.OPEN) {
  ws.send(JSON.stringify({ t: 'createChannel', name: inp.value, mode }));
  done();
}
```

- [ ] **Step 6: renderMsgs — Code 채널 empty state + 헤더**

`renderMsgs()` 시작부에 분기 추가(기존 본문 앞):

```js
function renderMsgs() {
  const box = document.getElementById('msgs');
  const hdr = document.getElementById('chhdr');
  const bar = document.getElementById('inputbar');
  const ch = channels.find((c) => c.id === current);
  // Code 채널인데 폴더 미바인딩 → empty state(입력창 숨김).
  if (ch && (ch.mode || 'chat') === 'code' && !ch.repoPath) {
    hdr.style.display = 'none';
    bar.style.display = 'none';
    box.replaceChildren(makeFolderEmptyState(ch));
    return;
  }
  bar.style.display = 'flex';
  // Code 채널 헤더(폴더명)
  if (ch && (ch.mode || 'chat') === 'code' && ch.repoPath) {
    hdr.style.display = 'block';
    hdr.textContent = '📁 ' + ch.repoPath.split(/[\\/]/).filter(Boolean).pop();
    hdr.title = ch.repoPath;
  } else {
    hdr.style.display = 'none';
  }
  box.replaceChildren();
  // ... 기존 메시지 렌더 본문 그대로 ...
}
```

empty state 빌더 추가(renderMsgs 근처):

```js
function makeFolderEmptyState(ch) {
  const wrap = document.createElement('div');
  wrap.id = 'empty';
  const msg = document.createElement('div');
  msg.textContent = T.pickFolder;
  const btn = document.createElement('button');
  btn.textContent = T.pickFolderBtn;
  btn.onclick = async () => {
    if (window.engramDesktop && window.engramDesktop.pickFolder) {
      const p = await window.engramDesktop.pickFolder(); // 네이티브 대화상자
      if (p) ws.send(JSON.stringify({ t: 'setRepoPath', id: ch.id, repoPath: p }));
    } else {
      // 브라우저 폴백: 텍스트 입력
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = T.pickFolderPath;
      inp.style.marginTop = '8px';
      inp.onkeydown = (e) => {
        if (e.key === 'Enter' && inp.value.trim()) {
          ws.send(JSON.stringify({ t: 'setRepoPath', id: ch.id, repoPath: inp.value.trim() }));
        }
      };
      wrap.appendChild(inp);
      inp.focus();
    }
  };
  wrap.appendChild(msg);
  wrap.appendChild(btn);
  return wrap;
}
```

> `setRepoPath` 후 서버가 `channels` 브로드캐스트를 보내고(Task 2), `ws.onmessage`의 `channels` 분기가 `renderChannels()`를 부른다. 바인딩 반영을 위해 그 분기에서 현재 채널이면 `renderMsgs()`도 부르도록 확인:
>
> ```js
> if (f.t === 'channels') {
>   channels = f.list;
>   if (!current || !channels.some((c) => c.id === current)) selectChannel(channels[0] && channels[0].id);
>   renderChannels();
>   renderMsgs(); // Phase 10: repoPath 바인딩 등 채널 변화가 본문(empty state/헤더)에 반영되게
> }
> ```

- [ ] **Step 7: 초기 탭 선택 동기화**

`ws.onmessage`의 `channels` 최초 수신 시 현재 모드에 채널이 없으면 첫 chat 채널을 고르도록 — `selectChannel`이 mode를 안 보므로, 최초 렌더에서 mode='chat' 기본이면 chat 채널이 잡힌다(기본값 general=chat). 별도 처리 불필요. 단 `renderChannels`가 mode 필터를 쓰므로 최초 mode='chat'와 일치. OK.

- [ ] **Step 8: 수동 검증(Electron)**

> 주의(메모리): 실사용 인스턴스와 desktop:dev는 포트 락 충돌 — dev 검증 시 설치본 상주를 먼저 종료(트레이 종료)하거나 다른 포트(`ENGRAM_CHAT_PORT`)로.

검증 항목:
1. 앱 실행 → 채팅 창 상단에 `Chat | Code` 탭 표시.
2. Code 탭 클릭 → chat 채널 사라지고 code 채널만(처음엔 비어 있음).
3. `+ 새 채널`로 code 채널 생성 → Code 탭에만 보임(Chat 탭엔 안 보임).
4. code 채널 진입 → "먼저 작업할 폴더를 선택하세요 📁" + [폴더 선택] 버튼, 입력창 숨김.
5. [폴더 선택] → OS 폴더 대화상자 → 폴더 고르면 헤더 `📁 폴더명`, 입력창 열림.
6. 메시지 전송 → 코딩 흐름(완성조건·승인 대기) 시작(classify 안 탐).
7. Chat 탭의 채널은 기존과 동일하게 동작.

- [ ] **Step 9: 커밋**

```bash
git add src/desktop/chat.html
git commit -m "feat(phase10a): 채팅 UI 모드 탭(Chat/Code)+모드별 채널 필터+Code 폴더 선택 empty state"
```

---

## Self-Review

- **스펙 커버리지**: §1 모드 탭·모드별 채널 분리(Task 6)·§1 새 채널=현재 탭 모드(Task 6 Step 5)·§1 데이터 `mode` 필드(Task 1) / §2 Team=직교(escape hatch 유지, Task 4 3번째 테스트) / §3 Code=폴더 바인딩·첫 진입 empty state·OS 대화상자·헤더 표시·텍스트 폴백(Task 5·6) / §4 Code 라우팅=classify 건너뛰기·벽 아님(Task 4). ⟶ 전부 태스크 있음. "채널 ⋯ 메뉴에서 폴더 변경"(§3 마지막 줄)은 **후속**으로 남김(핵심 아님, empty state로 최초 바인딩만; 변경은 채널 삭제·재생성으로 우회 가능) — ponytail: 필요 시 채널 메뉴에 "폴더 변경" 항목 추가(setRepoPath 재사용).
- **restart-survival·백엔드 버그**: 이 플랜 아님 → `2026-07-04-phase10b-resilience.md`.
- **타입 일관성**: `mode: 'chat'|'code'`·`repoPath: string`·`setRepoPath(id,repoPath)`·ws `setRepoPath {id, repoPath}`·`createChannel {name, mode}` 전 태스크 동일.
- **플레이스홀더 스캔**: 각 코드 스텝에 실제 코드. 테스트 헬퍼(sendFrame/onceBroadcast/FakeMessenger/makeOrchestrator)는 "기존 spec 관례를 따르라"고 명시 — 구현자는 해당 spec 파일에서 실제 이름을 확인해 맞춘다.

## Execution Handoff

플랜 완료·저장: `docs/superpowers/plans/2026-07-04-phase10a-modes.md`. 실행은 subagent-driven-development 권장(태스크별 신규 서브에이전트 + 2단 리뷰).
