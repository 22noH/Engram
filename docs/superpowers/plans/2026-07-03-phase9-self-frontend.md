# Phase 9 자체 프론트엔드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nest 상주에 WebSocket 채팅 서버(`self` 메신저 어댑터)를 내장하고 Electron 채팅 창(채널+자동 스레드, 기록 영속)을 올려 Discord 없이 Engram과 대화한다.

**Architecture:** 코어·Orchestrator 무변경 — 전부 Edge 층. `SelfMessenger`(MessengerPort 구현, http+ws 내장)가 클라이언트 메시지를 `onMention`으로 흘리고 `reply`/`postToChannel`을 영속+브로드캐스트한다. `ChatStore`가 JSONL 기록·채널 목록을 관리하고, `MessengerHub`가 예약/ambient의 `postToChannel`을 self/Discord로 라우팅한다. UI는 서버가 서빙하는 단일 `chat.html`(Electron 창과 폰 브라우저가 같은 페이지).

**Tech Stack:** TypeScript/NestJS(기존), `ws`(신규 prod dep 1개), 바닐라 JS HTML(설정창 패턴), jest(colocated `*.spec.ts`).

**스펙:** `docs/superpowers/specs/2026-07-03-phase9-self-frontend-design.md` (읽고 시작할 것)

## Global Constraints

- 신규 의존성은 `ws`(prod)·`@types/ws`(dev)만. 그 외 추가 금지.
- `src/knowledge-core/`·`src/agent-layer/`·`src/brain/` 수정 금지(코어 무변경). 단 T5의 `edge/schedule-service.ts`·`edge/ambient-service.ts` 생성자 타입 좁히기는 허용(Edge 층).
- 기본 바인딩 `127.0.0.1`, 기본 포트 `47800`. env `ENGRAM_CHAT_PORT`/`ENGRAM_CHAT_BIND` 우선, 비숫자/0 이하 env는 무시(`Number.isFinite` + `> 0` 가드 — NaN 함정 주의).
- fault-tolerant 관례: 손상 JSON 줄 skip, 미지 ws 프레임 무시, 클라이언트/채널 단위 예외 격리(상주 불사).
- `channelId`는 신뢰 경계(클라이언트 유래) — 파일 경로에 쓰기 전에 반드시 채널 목록 존재 검증(`has()`), 경로 구분자 포함 id 거부.
- PinoLogger에 `info()` 없음 — `log`/`warn`/`error`만.
- UI 문구: 영어 기본, `navigator.language`가 ko면 한국어. 외부 유래 문자열은 반드시 `textContent`로만 DOM에 넣는다(innerHTML 금지).
- 셸은 PowerShell. 테스트 실행: `npx jest <경로>` (전체: `npm test`).
- Engram 발신 authorId는 `'engram'` 고정, 클라이언트 기본 authorId는 `'owner'`.

---

## 파일 구조

| 파일 | 역할 | 태스크 |
|---|---|---|
| `src/edge/messenger/chat-store.ts` (신규) | 메시지 JSONL·채널 목록 영속 | T1 |
| `src/edge/messenger/chat.config.ts` (신규) | `chat.json`+env 로드 | T2 |
| `src/edge/messenger/self.adapter.ts` (신규) | MessengerPort 구현 + http/ws 서버 | T3·T4 |
| `src/edge/messenger/messenger-hub.ts` (신규) | postToChannel 라우터 | T5 |
| `src/edge/messenger/messenger.port.ts` (수정) | `ChannelPoster` 타입 추가 | T5 |
| `src/edge/schedule-service.ts`·`src/edge/ambient-service.ts` (수정) | port 타입 좁히기 | T5 |
| `src/main.ts` (수정) | self 어댑터·Hub 결선 | T6 |
| `src/desktop/chat.html` (신규) | 채팅 UI(서버가 서빙) | T7 |
| `src/desktop/main.ts`·`package.json` (수정) | 트레이 "채팅 열기"·빌드 파일 목록 | T8 |
| `README.md` (수정) | 사용법·보안 주의 | T9 |

---

### Task 1: ChatStore — 채팅 기록·채널 영속

**Files:**
- Create: `src/edge/messenger/chat-store.ts`
- Test: `src/edge/messenger/chat-store.spec.ts`

**Interfaces:**
- Consumes: 없음(fs·crypto stdlib만)
- Produces (T3·T4·T5·T6이 사용):
  ```ts
  interface ChatMessage { id: string; authorId: string; text: string; threadId?: string; ts: string }
  interface ChatChannel { id: string; name: string; respondMode: 'all'|'mention'; ownerId?: string; visibility?: 'public'|'private' }
  class ChatStore {
    constructor(chatDir: string)                 // {dataDir}/state/chat
    listChannels(): ChatChannel[]                // 비면 general 자동 생성
    createChannel(name: string): ChatChannel | null
    deleteChannel(id: string): boolean           // 목록에서만 제거, jsonl 보존
    setRespondMode(id: string, mode: 'all'|'mention'): boolean
    has(channelId: string): boolean
    appendMessage(channelId: string, input: { authorId: string; text: string; threadId?: string }): ChatMessage | null  // 미존재 채널이면 null
    history(channelId: string, opts?: { limit?: number; before?: string }): ChatMessage[]
  }
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/edge/messenger/chat-store.spec.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatStore } from './chat-store';

describe('ChatStore', () => {
  let dir: string;
  let store: ChatStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-chat-'));
    store = new ChatStore(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('첫 조회 시 general 채널을 자동 생성한다', () => {
    const chs = store.listChannels();
    expect(chs).toHaveLength(1);
    expect(chs[0]).toMatchObject({ id: 'general', name: 'general', respondMode: 'all' });
  });

  it('채널 생성/삭제/respondMode 변경이 영속된다', () => {
    const ch = store.createChannel('dev')!;
    expect(ch.respondMode).toBe('all');
    expect(store.setRespondMode(ch.id, 'mention')).toBe(true);
    const again = new ChatStore(dir); // 재기동 시뮬레이션
    expect(again.listChannels().find((c) => c.id === ch.id)?.respondMode).toBe('mention');
    expect(again.deleteChannel(ch.id)).toBe(true);
    expect(again.has(ch.id)).toBe(false);
  });

  it('빈 이름 채널은 만들지 않는다', () => {
    expect(store.createChannel('  ')).toBeNull();
  });

  it('메시지 append→history 왕복, id/ts 자동 부여', () => {
    store.listChannels(); // general 생성
    const m = store.appendMessage('general', { authorId: 'owner', text: '안녕' })!;
    expect(m.id).toBeTruthy();
    expect(m.ts).toBeTruthy();
    const h = store.history('general');
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ authorId: 'owner', text: '안녕' });
  });

  it('threadId가 보존된다', () => {
    store.listChannels();
    const anchor = store.appendMessage('general', { authorId: 'owner', text: 'q' })!;
    store.appendMessage('general', { authorId: 'engram', text: 'a', threadId: anchor.id });
    expect(store.history('general')[1].threadId).toBe(anchor.id);
  });

  it('미존재 채널 append는 null, history는 빈 배열', () => {
    expect(store.appendMessage('nope', { authorId: 'owner', text: 'x' })).toBeNull();
    expect(store.history('nope')).toEqual([]);
  });

  it('경로 구분자가 든 채널 id는 거부한다(신뢰 경계)', () => {
    expect(store.appendMessage('../evil', { authorId: 'owner', text: 'x' })).toBeNull();
    expect(store.history('..\\evil')).toEqual([]);
  });

  it('손상 줄은 건너뛴다', () => {
    store.listChannels();
    store.appendMessage('general', { authorId: 'owner', text: 'ok' });
    fs.appendFileSync(path.join(dir, 'general.jsonl'), '{broken\n');
    store.appendMessage('general', { authorId: 'owner', text: 'ok2' });
    expect(store.history('general').map((m) => m.text)).toEqual(['ok', 'ok2']);
  });

  it('history limit·before 페이지네이션', () => {
    store.listChannels();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(store.appendMessage('general', { authorId: 'owner', text: `m${i}` })!.id);
    expect(store.history('general', { limit: 2 }).map((m) => m.text)).toEqual(['m3', 'm4']);
    expect(store.history('general', { limit: 2, before: ids[3] }).map((m) => m.text)).toEqual(['m1', 'm2']);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/chat-store.spec.ts`
Expected: FAIL — `Cannot find module './chat-store'`

- [ ] **Step 3: 최소 구현**

```ts
// src/edge/messenger/chat-store.ts
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

// 채팅 기록 영속(스펙 §4.2). 메시지=state/chat/{channelId}.jsonl append 전용,
// 채널 목록=state/chat/channels.json. 손상 줄 skip(ConversationStore 관례).
// 채널 삭제는 목록에서만 — jsonl은 보존(데이터 삭제 opt-in 관례).

export interface ChatMessage {
  id: string;
  authorId: string;
  text: string;
  threadId?: string;
  ts: string; // ISO
}

export interface ChatChannel {
  id: string;
  name: string;
  respondMode: 'all' | 'mention';
  ownerId?: string;                    // 9b: 계정 도입 시 소유자
  visibility?: 'public' | 'private';   // 9b: 비공개 잠금
}

// channelId는 클라이언트 유래(신뢰 경계) — 파일명에 쓰기 전 검증.
function safeId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && !/[\\/]|\.\./.test(id);
}

export class ChatStore {
  constructor(private readonly chatDir: string) {}

  private channelsPath(): string {
    return path.join(this.chatDir, 'channels.json');
  }
  private messagesPath(channelId: string): string {
    return path.join(this.chatDir, `${channelId}.jsonl`);
  }
  private save(list: ChatChannel[]): void {
    fs.mkdirSync(this.chatDir, { recursive: true });
    fs.writeFileSync(this.channelsPath(), JSON.stringify(list, null, 2));
  }

  listChannels(): ChatChannel[] {
    let list: ChatChannel[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.channelsPath(), 'utf8')) as ChatChannel[];
      if (Array.isArray(raw)) {
        list = raw.filter((c) => c && safeId(c.id) && typeof c.name === 'string');
      }
    } catch { /* 없거나 깨짐 → 기본 생성 */ }
    if (list.length === 0) {
      list = [{ id: 'general', name: 'general', respondMode: 'all' }];
      this.save(list);
    }
    return list;
  }

  createChannel(name: string): ChatChannel | null {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return null;
    const list = this.listChannels();
    const ch: ChatChannel = { id: randomUUID(), name: trimmed, respondMode: 'all' };
    list.push(ch);
    this.save(list);
    return ch;
  }

  deleteChannel(id: string): boolean {
    const list = this.listChannels();
    const next = list.filter((c) => c.id !== id);
    if (next.length === list.length) return false;
    this.save(next);
    return true;
  }

  setRespondMode(id: string, mode: 'all' | 'mention'): boolean {
    if (mode !== 'all' && mode !== 'mention') return false;
    const list = this.listChannels();
    const ch = list.find((c) => c.id === id);
    if (!ch) return false;
    ch.respondMode = mode;
    this.save(list);
    return true;
  }

  has(channelId: string): boolean {
    return safeId(channelId) && this.listChannels().some((c) => c.id === channelId);
  }

  appendMessage(
    channelId: string,
    input: { authorId: string; text: string; threadId?: string },
  ): ChatMessage | null {
    if (!this.has(channelId)) return null;
    const msg: ChatMessage = {
      id: randomUUID(),
      authorId: input.authorId,
      text: input.text,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ts: new Date().toISOString(),
    };
    fs.mkdirSync(this.chatDir, { recursive: true });
    fs.appendFileSync(this.messagesPath(channelId), JSON.stringify(msg) + '\n');
    return msg;
  }

  // ponytail: 전체 읽기 O(n) — 개인 규모. 파일이 커지면 tail 인덱스로.
  history(channelId: string, opts?: { limit?: number; before?: string }): ChatMessage[] {
    if (!this.has(channelId)) return [];
    let lines: string[];
    try {
      lines = fs.readFileSync(this.messagesPath(channelId), 'utf8').split('\n').filter(Boolean);
    } catch {
      return []; // 파일 없음 = 메시지 없음
    }
    const msgs: ChatMessage[] = [];
    for (const l of lines) {
      try {
        const m = JSON.parse(l) as ChatMessage;
        if (m && typeof m.id === 'string' && typeof m.text === 'string') msgs.push(m);
      } catch { /* 손상 줄 skip */ }
    }
    let end = msgs.length;
    if (opts?.before) {
      const i = msgs.findIndex((m) => m.id === opts.before);
      if (i >= 0) end = i;
    }
    const limit = opts?.limit ?? 100;
    return msgs.slice(Math.max(0, end - limit), end);
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/messenger/chat-store.spec.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: 커밋**

```powershell
git add src/edge/messenger/chat-store.ts src/edge/messenger/chat-store.spec.ts
git commit -m "feat(phase9): ChatStore - 채팅 메시지 JSONL·채널 목록 영속"
```

---

### Task 2: loadChatConfig — chat.json + env 로드

**Files:**
- Create: `src/edge/messenger/chat.config.ts`
- Test: `src/edge/messenger/chat.config.spec.ts`

**Interfaces:**
- Produces (T3·T6·T8이 사용):
  ```ts
  interface ChatConfig { enabled: boolean; port: number; bind: string }
  function loadChatConfig(configDir: string, env?: NodeJS.ProcessEnv): ChatConfig
  // 기본: enabled=true, port=47800, bind='127.0.0.1'. env ENGRAM_CHAT_PORT/ENGRAM_CHAT_BIND 우선.
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/edge/messenger/chat.config.spec.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadChatConfig } from './chat.config';

describe('loadChatConfig', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-chatcfg-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('파일 없으면 기본값(가동)', () => {
    expect(loadChatConfig(dir, {})).toEqual({ enabled: true, port: 47800, bind: '127.0.0.1' });
  });

  it('chat.json 값을 읽는다', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ enabled: false, port: 5000, bind: '0.0.0.0' }));
    expect(loadChatConfig(dir, {})).toEqual({ enabled: false, port: 5000, bind: '0.0.0.0' });
  });

  it('env가 파일보다 우선한다', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ port: 5000 }));
    const cfg = loadChatConfig(dir, { ENGRAM_CHAT_PORT: '6000', ENGRAM_CHAT_BIND: '0.0.0.0' });
    expect(cfg.port).toBe(6000);
    expect(cfg.bind).toBe('0.0.0.0');
  });

  it('비숫자·0 이하 env/파일 port는 기본값으로 폴백(NaN 가드)', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ port: 'abc' }));
    expect(loadChatConfig(dir, { ENGRAM_CHAT_PORT: 'xyz' }).port).toBe(47800);
    expect(loadChatConfig(dir, { ENGRAM_CHAT_PORT: '-1' }).port).toBe(47800);
  });

  it('깨진 JSON은 기본값', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), '{broken');
    expect(loadChatConfig(dir, {}).enabled).toBe(true);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/chat.config.spec.ts`
Expected: FAIL — `Cannot find module './chat.config'`

- [ ] **Step 3: 최소 구현**

```ts
// src/edge/messenger/chat.config.ts
import * as fs from 'fs';
import * as path from 'path';

// 자체 채팅 서버 설정(스펙 §3). 기본 = 가동·127.0.0.1:47800. enabled:false만 끔.
// 비밀 아님(토큰 없음) — env는 포트/바인딩 오버라이드 용도.

export interface ChatConfig {
  enabled: boolean;
  port: number;
  bind: string;
}

function validPort(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null; // NaN·0·음수 → 무시(기존 env 가드 관례)
}

export function loadChatConfig(configDir: string, env: NodeJS.ProcessEnv = process.env): ChatConfig {
  let raw: Partial<ChatConfig> = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(configDir, 'chat.json'), 'utf8')) as Partial<ChatConfig>;
  } catch {
    raw = {};
  }
  const port = (env.ENGRAM_CHAT_PORT ? validPort(env.ENGRAM_CHAT_PORT) : null)
    ?? validPort(raw.port)
    ?? 47800;
  const bind = (typeof env.ENGRAM_CHAT_BIND === 'string' && env.ENGRAM_CHAT_BIND)
    || (typeof raw.bind === 'string' && raw.bind)
    || '127.0.0.1';
  return { enabled: raw.enabled !== false, port, bind };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/messenger/chat.config.spec.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```powershell
git add src/edge/messenger/chat.config.ts src/edge/messenger/chat.config.spec.ts
git commit -m "feat(phase9): loadChatConfig - chat.json + env 로드(NaN 가드)"
```

---

### Task 3: SelfMessenger 코어 — ws 서버·send→멘션·reply 영속/브로드캐스트

**Files:**
- Create: `src/edge/messenger/self.adapter.ts`
- Test: `src/edge/messenger/self.adapter.spec.ts`
- Modify: `package.json` (deps — 이 태스크에서 `npm install ws` / `npm install -D @types/ws`)

**Interfaces:**
- Consumes: T1 `ChatStore`, T2 `ChatConfig`, 기존 `MessengerPort`/`MentionEvent`(`messenger.port.ts`)
- Produces (T4가 확장, T6이 결선):
  ```ts
  interface SelfTarget { channelId: string; anchorId: string }   // ReplyTarget 실체
  function hasEngramMention(text: string, name?: string): boolean
  function stripEngramMention(text: string, name?: string): string
  class SelfMessenger implements MessengerPort {
    constructor(cfg: ChatConfig, store: ChatStore,
      opts: { htmlPath?: string; engramName?: string; logger: { warn(msg: string, ctx?: string): void } })
    addressPort(): number   // 테스트용(port 0 → 실제 포트)
    // onMention/onMessage/reply/postToChannel/start/stop = MessengerPort
  }
  ```
- ws 프로토콜(이 태스크 범위): 수신 `{t:'send', channelId, threadId?, text, authorId?}` → 저장+`{t:'msg', channelId, message}` 브로드캐스트+`onMention` 발화. 나머지 프레임은 T4.
- **anchor 규칙(스펙 §4.1)**: anchor = 수신 메시지의 `threadId` ?? 그 메시지의 `id`. `reply()`는 `threadId=anchorId`로 저장. `MentionEvent.threadId`는 **수신 메시지의 threadId 그대로**(본류면 undefined → bridge threadKey=channelId, Discord 의미론 유지).

- [ ] **Step 1: 의존성 설치**

```powershell
npm install ws
npm install -D @types/ws
```

- [ ] **Step 2: 실패하는 테스트 작성**

```ts
// src/edge/messenger/self.adapter.spec.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import WebSocket from 'ws';
import { SelfMessenger, SelfTarget, hasEngramMention, stripEngramMention } from './self.adapter';
import { ChatStore } from './chat-store';
import { MentionEvent } from './messenger.port';

const noLog = { warn: () => {} };

function once<T = unknown>(ws: WebSocket, ev: string): Promise<T> {
  return new Promise((resolve) => ws.once(ev, (d: unknown) => resolve(d as T)));
}
async function nextFrame(ws: WebSocket): Promise<any> {
  const d = await once<Buffer>(ws, 'message');
  return JSON.parse(String(d));
}

describe('SelfMessenger 코어', () => {
  let dir: string;
  let store: ChatStore;
  let sm: SelfMessenger;
  let client: WebSocket;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-self-'));
    store = new ChatStore(dir);
    store.listChannels(); // general 생성
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1' }, store, { logger: noLog });
    await sm.start();
    client = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(client, 'open');
  });
  afterEach(async () => {
    client.terminate();
    await sm.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('멘션 유틸: 감지·제거(대소문자 무시)', () => {
    expect(hasEngramMention('@engram 안녕')).toBe(true);
    expect(hasEngramMention('그냥 잡담')).toBe(false);
    expect(stripEngramMention('@Engram  안녕')).toBe('안녕');
  });

  it('send → 영속 + msg 브로드캐스트 + onMention 발화(본류: threadId 없음, anchor=자기 id)', async () => {
    const events: MentionEvent[] = [];
    sm.onMention(async (e) => { events.push(e); });
    client.send(JSON.stringify({ t: 'send', channelId: 'general', text: '@Engram 안녕' }));
    const frame = await nextFrame(client);
    expect(frame.t).toBe('msg');
    expect(frame.message).toMatchObject({ authorId: 'owner', text: '@Engram 안녕' });
    expect(store.history('general')).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('안녕');            // 멘션 토큰 제거
    expect(events[0].threadId).toBeUndefined();      // 본류 → threadKey=channelId 정합
    expect((events[0].target as SelfTarget).anchorId).toBe(frame.message.id);
  });

  it('스레드 안 send → MentionEvent.threadId=anchor, target.anchorId=같은 anchor(새 스레드 안 팜)', async () => {
    const events: MentionEvent[] = [];
    sm.onMention(async (e) => { events.push(e); });
    client.send(JSON.stringify({ t: 'send', channelId: 'general', text: 'q', threadId: 'anchor-1' }));
    await nextFrame(client);
    expect(events[0].threadId).toBe('anchor-1');
    expect((events[0].target as SelfTarget).anchorId).toBe('anchor-1');
  });

  it('reply → engram 명의로 anchor 스레드에 영속+브로드캐스트', async () => {
    await sm.reply({ channelId: 'general', anchorId: 'a1' } as SelfTarget, '답입니다');
    const frame = await nextFrame(client);
    expect(frame.message).toMatchObject({ authorId: 'engram', text: '답입니다', threadId: 'a1' });
    expect(store.history('general')[0].threadId).toBe('a1');
  });

  it('postToChannel → 본류(threadId 없음) 게시, 클라이언트 0명이어도 영속', async () => {
    client.terminate();
    await sm.postToChannel('general', '예약 발사');
    expect(store.history('general')[0]).toMatchObject({ authorId: 'engram', text: '예약 발사' });
  });

  it('미존재 채널 send → error 프레임, 저장 안 함', async () => {
    client.send(JSON.stringify({ t: 'send', channelId: 'nope', text: 'x' }));
    const frame = await nextFrame(client);
    expect(frame.t).toBe('error');
  });

  it('손상 프레임·빈 text는 무시(서버 불사)', async () => {
    client.send('{broken');
    client.send(JSON.stringify({ t: 'send', channelId: 'general', text: '  ' }));
    client.send(JSON.stringify({ t: 'send', channelId: 'general', text: 'ok' }));
    const frame = await nextFrame(client);
    expect(frame.message.text).toBe('ok');
  });

  it('GET / 는 htmlPath 파일을 서빙, 없으면 404', async () => {
    const res = await fetch(`http://127.0.0.1:${sm.addressPort()}/`);
    expect(res.status).toBe(404); // htmlPath 미지정
    const htmlFile = path.join(dir, 'chat.html');
    fs.writeFileSync(htmlFile, '<p>hi</p>');
    const sm2 = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1' }, store, { htmlPath: htmlFile, logger: noLog });
    await sm2.start();
    const res2 = await fetch(`http://127.0.0.1:${sm2.addressPort()}/`);
    expect(res2.status).toBe(200);
    expect(await res2.text()).toContain('hi');
    await sm2.stop();
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: FAIL — `Cannot find module './self.adapter'`

- [ ] **Step 4: 최소 구현**

```ts
// src/edge/messenger/self.adapter.ts
import * as fs from 'fs';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { MessengerPort, MentionEvent, ReplyTarget } from './messenger.port';
import { ChatStore } from './chat-store';
import { ChatConfig } from './chat.config';

// 자체 메신저 어댑터(Phase 9, 스펙 §4.1). http(chat.html 서빙)+ws 서버 내장.
// 생성자는 비연결 — 리슨은 start()에서(Discord 어댑터 관례).
// 기본 바인딩 127.0.0.1 — 인증 없음. 개방(0.0.0.0)은 9b(토큰 인증)까지 금지(README 명시).

export interface SelfTarget {
  channelId: string;
  anchorId: string; // Engram 답이 매달릴 스레드 anchor(표시용 — 작업추적 키 아님)
}

export function hasEngramMention(text: string, name = 'Engram'): boolean {
  return text.toLowerCase().includes('@' + name.toLowerCase());
}
export function stripEngramMention(text: string, name = 'Engram'): string {
  return text.replace(new RegExp('@' + name, 'gi'), '').trim();
}

export class SelfMessenger implements MessengerPort {
  private server?: http.Server;
  private wss?: WebSocketServer;
  private handler?: (e: MentionEvent) => Promise<void>;
  private msgHandler?: (e: MentionEvent) => Promise<void>;

  constructor(
    private readonly cfg: ChatConfig,
    private readonly store: ChatStore,
    private readonly opts: {
      htmlPath?: string;
      engramName?: string;
      logger: { warn(msg: string, ctx?: string): void };
    },
  ) {}

  onMention(handler: (e: MentionEvent) => Promise<void>): void {
    this.handler = handler;
  }
  onMessage(handler: (e: MentionEvent) => Promise<void>): void {
    this.msgHandler = handler;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        try {
          const html = fs.readFileSync(this.opts.htmlPath ?? '', 'utf8');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        } catch { /* 아래 404 */ }
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => {
      ws.on('message', (raw) => { void this.handleFrame(ws, String(raw)); });
      ws.on('error', () => { /* 접속 단위 격리 */ });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.cfg.port, this.cfg.bind, () => resolve());
    });
  }

  // 테스트용: port 0(임시 포트)로 리슨했을 때 실제 포트.
  addressPort(): number {
    const a = this.server?.address();
    return typeof a === 'object' && a ? a.port : this.cfg.port;
  }

  private sendTo(ws: WebSocket, frame: unknown): void {
    try { ws.send(JSON.stringify(frame)); } catch { /* 격리 */ }
  }
  private broadcast(frame: unknown): void {
    const data = JSON.stringify(frame);
    for (const c of this.wss?.clients ?? []) {
      if (c.readyState === WebSocket.OPEN) {
        try { c.send(data); } catch { /* 격리 */ }
      }
    }
  }

  private async handleFrame(ws: WebSocket, raw: string): Promise<void> {
    let f: Record<string, unknown>;
    try { f = JSON.parse(raw) as Record<string, unknown>; } catch { return; } // 손상 무시
    try {
      switch (f?.t) {
        case 'send': return await this.onSend(ws, f);
        default: return; // 미지 타입 무시(스펙 §6) — 나머지 프레임은 T4
      }
    } catch (err) {
      this.opts.logger.warn(`프레임 처리 실패: ${String(err)}`, 'SelfChat');
    }
  }

  private async onSend(ws: WebSocket, f: Record<string, unknown>): Promise<void> {
    const text = typeof f.text === 'string' ? f.text : '';
    const channelId = typeof f.channelId === 'string' ? f.channelId : '';
    if (!text.trim() || !channelId) return;
    const ch = this.store.listChannels().find((c) => c.id === channelId);
    if (!ch) { this.sendTo(ws, { t: 'error', text: 'unknown channel' }); return; }
    const msg = this.store.appendMessage(channelId, {
      authorId: typeof f.authorId === 'string' && f.authorId ? f.authorId : 'owner',
      text,
      threadId: typeof f.threadId === 'string' && f.threadId ? f.threadId : undefined,
    });
    if (!msg) return;
    this.broadcast({ t: 'msg', channelId, message: msg });

    const name = this.opts.engramName ?? 'Engram';
    const isMention = ch.respondMode !== 'mention' || hasEngramMention(text, name);
    const anchor = msg.threadId ?? msg.id;
    const e: MentionEvent = {
      text: stripEngramMention(text, name),
      channelId,
      threadId: msg.threadId, // 본류면 undefined → bridge threadKey=channelId(Discord 의미론)
      authorId: msg.authorId,
      target: { channelId, anchorId: anchor } satisfies SelfTarget as ReplyTarget,
    };
    if (isMention) {
      if (this.handler) await this.handler(e);
    } else if (this.msgHandler) {
      await this.msgHandler(e); // 관찰 — 정책 필터는 bridge 몫(어댑터는 정책을 모른다)
    }
  }

  async reply(target: ReplyTarget, text: string): Promise<void> {
    const t = target as SelfTarget;
    const msg = this.store.appendMessage(t.channelId, { authorId: 'engram', text, threadId: t.anchorId });
    if (msg) this.broadcast({ t: 'msg', channelId: t.channelId, message: msg });
  }

  async postToChannel(channelId: string, text: string, threadId?: string): Promise<void> {
    const msg = this.store.appendMessage(channelId, { authorId: 'engram', text, threadId });
    if (msg) this.broadcast({ t: 'msg', channelId, message: msg });
  }

  async stop(): Promise<void> {
    for (const c of this.wss?.clients ?? []) {
      try { c.terminate(); } catch { /* 무시 */ }
    }
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: 커밋**

```powershell
git add package.json package-lock.json src/edge/messenger/self.adapter.ts src/edge/messenger/self.adapter.spec.ts
git commit -m "feat(phase9): SelfMessenger 코어 - ws 서버·send→멘션·reply 영속/브로드캐스트 (+ws dep)"
```

---

### Task 4: SelfMessenger 프로토콜 확장 — history/채널 CRUD/respondMode 게이팅

**Files:**
- Modify: `src/edge/messenger/self.adapter.ts` (handleFrame switch 확장)
- Test: `src/edge/messenger/self.adapter.spec.ts` (describe 블록 추가)

**Interfaces:**
- Consumes: T1 `ChatStore` 전체 API, T3 `SelfMessenger`
- Produces (chat.html=T7이 사용하는 프로토콜 완성):
  - 수신: `{t:'history', channelId, before?}` → 송신 `{t:'history', channelId, messages}`
  - 수신: `{t:'channels'}` → 송신 `{t:'channels', list}`
  - 수신: `{t:'createChannel', name}` / `{t:'deleteChannel', id}` / `{t:'setRespondMode', id, mode}` → 각각 처리 후 **전 클라이언트에** `{t:'channels', list}` 브로드캐스트
  - respondMode='mention' 채널: 멘션 포함 → onMention, 미포함 → onMessage(관찰)

- [ ] **Step 1: 실패하는 테스트 추가**

`self.adapter.spec.ts`에 describe 블록 추가:

```ts
describe('SelfMessenger 프로토콜 확장', () => {
  let dir: string;
  let store: ChatStore;
  let sm: SelfMessenger;
  let client: WebSocket;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-self2-'));
    store = new ChatStore(dir);
    store.listChannels();
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1' }, store, { logger: noLog });
    await sm.start();
    client = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(client, 'open');
  });
  afterEach(async () => {
    client.terminate();
    await sm.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('channels 요청 → 목록 응답', async () => {
    client.send(JSON.stringify({ t: 'channels' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('channels');
    expect(f.list[0].id).toBe('general');
  });

  it('createChannel → 생성 + channels 브로드캐스트', async () => {
    client.send(JSON.stringify({ t: 'createChannel', name: 'dev' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('channels');
    expect(f.list.map((c: { name: string }) => c.name)).toContain('dev');
  });

  it('deleteChannel·setRespondMode → 반영 + 브로드캐스트', async () => {
    const ch = store.createChannel('tmp')!;
    client.send(JSON.stringify({ t: 'setRespondMode', id: ch.id, mode: 'mention' }));
    const f1 = await nextFrame(client);
    expect(f1.list.find((c: { id: string }) => c.id === ch.id).respondMode).toBe('mention');
    client.send(JSON.stringify({ t: 'deleteChannel', id: ch.id }));
    const f2 = await nextFrame(client);
    expect(f2.list.find((c: { id: string }) => c.id === ch.id)).toBeUndefined();
  });

  it('history 요청 → 저장된 메시지 응답', async () => {
    store.appendMessage('general', { authorId: 'owner', text: 'old' });
    client.send(JSON.stringify({ t: 'history', channelId: 'general' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('history');
    expect(f.messages.map((m: { text: string }) => m.text)).toEqual(['old']);
  });

  it("respondMode='mention': 멘션은 onMention, 비멘션은 onMessage(관찰)", async () => {
    const ch = store.createChannel('team')!;
    store.setRespondMode(ch.id, 'mention');
    const mentions: string[] = [];
    const observed: string[] = [];
    sm.onMention(async (e) => { mentions.push(e.text); });
    sm.onMessage(async (e) => { observed.push(e.text); });
    client.send(JSON.stringify({ t: 'send', channelId: ch.id, text: '@Engram 회의 잡아줘' }));
    await nextFrame(client);
    client.send(JSON.stringify({ t: 'send', channelId: ch.id, text: '그냥 잡담' }));
    await nextFrame(client);
    expect(mentions).toEqual(['회의 잡아줘']);
    expect(observed).toEqual(['그냥 잡담']);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: 새 블록 5개 FAIL (기존 8개는 PASS 유지 — respondMode 테스트는 T3 구현으로 이미 통과할 수 있음, 그 경우도 OK)

- [ ] **Step 3: handleFrame switch 확장**

`self.adapter.ts`의 `handleFrame` switch에 케이스 추가:

```ts
      switch (f?.t) {
        case 'send': return await this.onSend(ws, f);
        case 'history': {
          const channelId = typeof f.channelId === 'string' ? f.channelId : '';
          const before = typeof f.before === 'string' ? f.before : undefined;
          this.sendTo(ws, { t: 'history', channelId, messages: this.store.history(channelId, { before }) });
          return;
        }
        case 'channels':
          this.sendTo(ws, { t: 'channels', list: this.store.listChannels() });
          return;
        case 'createChannel':
          if (typeof f.name === 'string') this.store.createChannel(f.name);
          this.broadcast({ t: 'channels', list: this.store.listChannels() });
          return;
        case 'deleteChannel':
          if (typeof f.id === 'string') this.store.deleteChannel(f.id);
          this.broadcast({ t: 'channels', list: this.store.listChannels() });
          return;
        case 'setRespondMode':
          if (typeof f.id === 'string' && (f.mode === 'all' || f.mode === 'mention')) {
            this.store.setRespondMode(f.id, f.mode);
          }
          this.broadcast({ t: 'channels', list: this.store.listChannels() });
          return;
        default:
          return; // 미지 타입 무시(스펙 §6)
      }
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: 커밋**

```powershell
git add src/edge/messenger/self.adapter.ts src/edge/messenger/self.adapter.spec.ts
git commit -m "feat(phase9): SelfMessenger 프로토콜 - history·채널 CRUD·respondMode 게이팅"
```

---

### Task 5: MessengerHub + ChannelPoster 타입 좁히기

**Files:**
- Create: `src/edge/messenger/messenger-hub.ts`
- Test: `src/edge/messenger/messenger-hub.spec.ts`
- Modify: `src/edge/messenger/messenger.port.ts` (타입 1개 추가)
- Modify: `src/edge/schedule-service.ts:23` (생성자 `port` 파라미터 타입)
- Modify: `src/edge/ambient-service.ts:21` (생성자 `port` 파라미터 타입)

**Interfaces:**
- Consumes: `MessengerPort`(기존), T1 `ChatStore.has`
- Produces (T6이 사용):
  ```ts
  // messenger.port.ts에 추가:
  export type ChannelPoster = Pick<MessengerPort, 'postToChannel'>;
  // messenger-hub.ts:
  class MessengerHub implements ChannelPoster {
    constructor(store: { has(channelId: string): boolean }, self: ChannelPoster, fallback?: ChannelPoster)
    postToChannel(channelId: string, text: string, threadId?: string): Promise<void>
    // 라우팅: store.has(channelId) → self, 아니면 fallback ?? self
  }
  ```
- ScheduleService·AmbientService의 `port` 파라미터를 `MessengerPort` → `ChannelPoster`로 좁힘(둘 다 `postToChannel`만 사용 — 확인됨). 기존 테스트는 FakeMessenger가 구조적으로 만족하므로 무변경 통과.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/edge/messenger/messenger-hub.spec.ts
import { MessengerHub } from './messenger-hub';

function makePoster() {
  const calls: Array<{ channelId: string; text: string; threadId?: string }> = [];
  return {
    calls,
    async postToChannel(channelId: string, text: string, threadId?: string) {
      calls.push({ channelId, text, threadId });
    },
  };
}

describe('MessengerHub', () => {
  it('self가 아는 채널이면 self로', async () => {
    const self = makePoster();
    const discord = makePoster();
    const hub = new MessengerHub({ has: (id) => id === 'general' }, self, discord);
    await hub.postToChannel('general', 'hi', 'th-1');
    expect(self.calls).toEqual([{ channelId: 'general', text: 'hi', threadId: 'th-1' }]);
    expect(discord.calls).toHaveLength(0);
  });

  it('모르는 채널이면 fallback(Discord)으로', async () => {
    const self = makePoster();
    const discord = makePoster();
    const hub = new MessengerHub({ has: () => false }, self, discord);
    await hub.postToChannel('123456789', 'hi');
    expect(discord.calls).toHaveLength(1);
    expect(self.calls).toHaveLength(0);
  });

  it('fallback 없으면 self로 강등(단독 운용)', async () => {
    const self = makePoster();
    const hub = new MessengerHub({ has: () => false }, self);
    await hub.postToChannel('anything', 'hi');
    expect(self.calls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/messenger-hub.spec.ts`
Expected: FAIL — `Cannot find module './messenger-hub'`

- [ ] **Step 3: 구현 + 타입 좁히기**

```ts
// messenger.port.ts 끝에 추가:
// 게시만 필요한 소비자(예약·ambient)용 좁은 포트 — Hub가 이것만 구현.
export type ChannelPoster = Pick<MessengerPort, 'postToChannel'>;
```

```ts
// src/edge/messenger/messenger-hub.ts
import { ChannelPoster } from './messenger.port';

// postToChannel 라우터(스펙 §4.3): self ChatStore가 아는 채널이면 self,
// 아니면 fallback(Discord). 포트가 하나뿐이면 사실상 통과.
export class MessengerHub implements ChannelPoster {
  constructor(
    private readonly store: { has(channelId: string): boolean },
    private readonly self: ChannelPoster,
    private readonly fallback?: ChannelPoster,
  ) {}

  async postToChannel(channelId: string, text: string, threadId?: string): Promise<void> {
    const port = this.store.has(channelId) ? this.self : (this.fallback ?? this.self);
    await port.postToChannel(channelId, text, threadId);
  }
}
```

`schedule-service.ts`: import에 `ChannelPoster` 추가, 생성자 파라미터 변경:
```ts
import { MessengerPort, ChannelPoster } from './messenger/messenger.port';
// ...
    private readonly port: ChannelPoster,   // 기존: MessengerPort
```
`ambient-service.ts`: 동일하게
```ts
import { ChannelPoster } from './messenger/messenger.port';
// ...
    private readonly port: ChannelPoster,   // 기존: MessengerPort
```
(각 파일에서 `MessengerPort` import가 더 이상 안 쓰이면 제거.)

- [ ] **Step 4: 통과 + 기존 스위트 회귀 확인**

Run: `npx jest src/edge`
Expected: PASS (hub 3 tests + 기존 edge 스위트 전부 — schedule/ambient 기존 테스트가 타입 좁히기에도 그대로 통과해야 함)

- [ ] **Step 5: 커밋**

```powershell
git add src/edge/messenger/messenger-hub.ts src/edge/messenger/messenger-hub.spec.ts src/edge/messenger/messenger.port.ts src/edge/schedule-service.ts src/edge/ambient-service.ts
git commit -m "feat(phase9): MessengerHub - 예약/ambient postToChannel 라우팅 + ChannelPoster 타입"
```

---

### Task 6: main.ts 결선 — self 상시 가동, Discord 병행

**Files:**
- Modify: `src/main.ts` (bootstrap 재구성)

**Interfaces:**
- Consumes: T1~T5 전부 + 기존 `bindMessenger`/`loadChannelPolicy`/`ScheduleStore`/`ScheduleService`/`AmbientService`/`resolveResourceFile`(`src/pal/resource-dir.ts`)
- Produces: 상주 기동 시 self 채팅 서버 리슨(기본 127.0.0.1:47800). CLI 원샷(`cli.ts`)은 무변경.

- [ ] **Step 1: bootstrap 재구성**

`src/main.ts`의 bootstrap을 다음으로 교체(import는 기존 것 + 신규 4개):

```ts
import { loadChatConfig } from './edge/messenger/chat.config';
import { ChatStore } from './edge/messenger/chat-store';
import { SelfMessenger } from './edge/messenger/self.adapter';
import { MessengerHub } from './edge/messenger/messenger-hub';
import { ChannelPoster } from './edge/messenger/messenger.port';
import { resolveResourceFile } from './pal/resource-dir';
```

```ts
async function bootstrap(): Promise<void> {
  process.env.ENGRAM_RESIDENT = '1'; // 상주 표식 — HeartbeatEmitter가 기동 즉시 1회 발화
  const app = await NestFactory.createApplicationContext(AppModule);
  await app.init();

  const paths = app.get(PathResolver);
  const logger = app.get(PinoLogger);
  const orchestrator = app.get(Orchestrator);
  const policy = loadChannelPolicy(paths.getConfigDir());

  // 자체 채팅(Phase 9): 기본 가동(chat.json enabled:false만 끔). 실패해도 상주 불사.
  let self: SelfMessenger | null = null;
  let chatStore: ChatStore | null = null;
  const chatCfg = loadChatConfig(paths.getConfigDir());
  if (chatCfg.enabled) {
    chatStore = new ChatStore(path.join(paths.getStateDir(), 'chat'));
    self = new SelfMessenger(chatCfg, chatStore, {
      htmlPath: resolveResourceFile(path.join('src', 'desktop', 'chat.html')),
      logger,
    });
  }

  // Discord(Phase 6a): messenger.json에 있으면 병행.
  const cfg = loadMessengerConfig(paths.getConfigDir());
  let discord: MessengerPort | null = null;
  try {
    discord = createMessenger(cfg);
  } catch (e) {
    logger.warn(`메신저 설정 오류(비활성): ${String(e)}`, 'Messenger');
  }

  const ports: MessengerPort[] = [self, discord].filter((p): p is MessengerPort => p !== null);
  if (ports.length === 0) return; // 채팅 끔 + Discord 없음 = 상주만 가동(기존 동작)

  for (const p of ports) bindMessenger(p, orchestrator, logger, policy);

  // 예약·ambient의 게시 통로: self가 있으면 Hub 라우팅, 없으면 Discord 직결.
  const poster: ChannelPoster =
    self && chatStore ? new MessengerHub(chatStore, self, discord ?? undefined) : discord!;

  const store = new ScheduleStore(paths.getConfigDir());
  const scheduler = new ScheduleService(orchestrator, poster, app.get(SchedulerRegistry), store, logger);
  orchestrator.setScheduler(scheduler);
  scheduler.start();
  const ambient = new AmbientService(
    orchestrator, poster, app.get(SchedulerRegistry), app.get(ProposalStore), policy,
    path.join(paths.getDataDir(), 'state', 'conversations'), logger,
  );
  ambient.start();

  // 포트 기동: self 리슨 실패(포트 점유 등)는 채팅만 비활성(경고)하고 상주는 계속.
  for (const p of ports) {
    try {
      await p.start();
    } catch (e) {
      logger.warn(`메신저 기동 실패(해당 채널 비활성): ${String(e)}`, 'Messenger');
    }
  }
  const active = [self ? `self(:${chatCfg.port})` : null, discord ? cfg.provider : null].filter(Boolean);
  logger.log(`메신저 가동: ${active.join(', ')}`, 'Messenger');
}
```

- [ ] **Step 2: 빌드·전체 회귀 확인**

Run: `npx tsc --noEmit; npm run build; npm test`
Expected: tsc 클린, build 성공, 전체 스위트 PASS (main.ts는 결선이라 단위테스트 없음 — 기존 관례)

- [ ] **Step 3: 상주 수동 스모크(서버 리슨 확인)**

```powershell
$env:ENGRAM_DATA_DIR = Join-Path $env:TEMP 'engram-p9-smoke'
Start-Process node -ArgumentList 'dist/src/main.js' -PassThru
# 몇 초 대기 후:
Invoke-WebRequest http://127.0.0.1:47800/ -UseBasicParsing
```
Expected: chat.html 미작성 시점이므로 **404**(서버 리슨 자체가 검증 대상). 확인 후 프로세스 종료, `Remove-Item Env:ENGRAM_DATA_DIR`.

- [ ] **Step 4: 커밋**

```powershell
git add src/main.ts
git commit -m "feat(phase9): main.ts 결선 - self 채팅 서버 상시 가동 + Discord 병행(Hub 라우팅)"
```

---

### Task 7: chat.html — 채팅 UI(채널·자동 스레드·재연결·i18n)

**Files:**
- Create: `src/desktop/chat.html`
- Modify: `package.json` build.files에 `"src/desktop/chat.html"` 추가

**Interfaces:**
- Consumes: T3·T4 ws 프로토콜 전부(`send`/`history`/`channels`/`createChannel`/`deleteChannel`/`setRespondMode` ↔ `msg`/`history`/`channels`/`error`)
- Produces: 서버가 서빙하는 단일 페이지(Electron 창=T8과 폰 브라우저가 공용).

**UI 규칙(스펙 §4.4):**
- 좌측 채널 목록(+새 채널, 채널별 ⋯ 메뉴: respondMode 토글·삭제), 우측 대화+입력창.
- 스레드 표시: threadId 없는 메시지가 본류. 같은 anchor에 매달린 답이 1개면 인라인, **2개 이상이면 `<details>`로 접기**(summary="답글 N개"/"N replies"), 펼치면 답들 + 스레드 답장 입력(그 입력은 `threadId=anchor`로 send).
- 재연결: 1s→5s→30s 캡 백오프, 연결 상태 점(초록/빨강) 표시.
- i18n: `navigator.language` ko → 한국어, 아니면 영어(설정창 관례). 외부 문자열은 전부 `textContent`.
- 스타일: 설정창(settings.html)과 같은 잉크다크+앰버 계열, 시스템 폰트. **구현 전에 settings.html을 열어 CSS 변수 팔레트를 그대로 복사할 것.**

- [ ] **Step 1: chat.html 작성**

아래 골격 그대로(팔레트 변수 값만 settings.html에서 복사). 로직은 완결이라 그대로 쓰면 동작한다:

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Engram</title>
<style>
  /* 팔레트: settings.html의 :root 변수를 그대로 복사해 동일 계열 유지 */
  :root { --bg:#14151c; --panel:#1b1d27; --line:#2a2d3a; --text:#e8e6e0; --dim:#8b8fa3; --amber:#e0a458; }
  * { box-sizing: border-box; margin: 0; }
  body { display:flex; height:100vh; background:var(--bg); color:var(--text);
         font-family:system-ui,-apple-system,'Segoe UI',sans-serif; font-size:14px; }
  #side { width:220px; background:var(--panel); border-right:1px solid var(--line);
          display:flex; flex-direction:column; }
  #side h1 { font-size:14px; padding:14px 16px; color:var(--amber); display:flex; align-items:center; gap:8px; }
  #dot { width:8px; height:8px; border-radius:50%; background:#c0504d; }
  #dot.on { background:#6aa84f; }
  #channels { flex:1; overflow-y:auto; }
  .ch { padding:8px 16px; cursor:pointer; color:var(--dim); display:flex; justify-content:space-between; }
  .ch:hover { background:rgba(255,255,255,.04); }
  .ch.sel { color:var(--text); background:rgba(224,164,88,.12); border-right:2px solid var(--amber); }
  .ch .menu { visibility:hidden; }
  .ch:hover .menu { visibility:visible; }
  #newch { padding:10px 16px; color:var(--dim); cursor:pointer; border-top:1px solid var(--line); }
  #main { flex:1; display:flex; flex-direction:column; min-width:0; }
  #msgs { flex:1; overflow-y:auto; padding:16px; }
  .msg { margin-bottom:10px; max-width:80%; }
  .msg .who { font-size:11px; color:var(--dim); margin-bottom:2px; }
  .msg .body { background:var(--panel); border:1px solid var(--line); border-radius:8px;
               padding:8px 12px; white-space:pre-wrap; word-break:break-word; }
  .msg.me { margin-left:auto; }
  .msg.me .body { background:rgba(224,164,88,.14); border-color:rgba(224,164,88,.3); }
  details.thread { margin:-4px 0 10px 16px; }
  details.thread summary { color:var(--amber); font-size:12px; cursor:pointer; }
  details.thread .msg { max-width:100%; }
  .treply { display:flex; gap:6px; margin-top:6px; }
  #inputbar { display:flex; gap:8px; padding:12px 16px; border-top:1px solid var(--line); }
  input[type=text] { flex:1; background:var(--panel); border:1px solid var(--line); border-radius:8px;
                     padding:10px 12px; color:var(--text); outline:none; }
  input[type=text]:focus { border-color:var(--amber); }
  button { background:var(--amber); border:0; border-radius:8px; padding:0 16px; cursor:pointer;
           color:#14151c; font-weight:600; }
</style>
</head>
<body>
<div id="side">
  <h1><span id="dot"></span>Engram</h1>
  <div id="channels"></div>
  <div id="newch"></div>
</div>
<div id="main">
  <div id="msgs"></div>
  <div id="inputbar">
    <input id="input" type="text">
    <button id="send"></button>
  </div>
</div>
<script>
'use strict';
// ---- i18n (영어 기본, ko 로케일 한국어 — 설정창 관례) ----
const ko = navigator.language.toLowerCase().startsWith('ko');
const T = {
  placeholder: ko ? '메시지 입력…' : 'Message…',
  send: ko ? '보내기' : 'Send',
  newChannel: ko ? '+ 새 채널' : '+ New channel',
  newChannelPrompt: ko ? '채널 이름:' : 'Channel name:',
  replies: (n) => (ko ? `답글 ${n}개` : `${n} replies`),
  replyPh: ko ? '스레드에 답장…' : 'Reply in thread…',
  delConfirm: (name) => (ko ? `'${name}' 채널을 삭제할까요? (기록 파일은 남습니다)` : `Delete channel '${name}'? (history file is kept)`),
  modeAll: ko ? '모든 메시지에 반응' : 'Respond to all',
  modeMention: ko ? '@Engram 멘션에만 반응' : 'Respond to @Engram only',
  engram: 'Engram', me: ko ? '나' : 'me',
};
document.getElementById('input').placeholder = T.placeholder;
document.getElementById('send').textContent = T.send;
document.getElementById('newch').textContent = T.newChannel;

// ---- 상태 ----
let ws = null;
let channels = [];
let current = null;                 // 선택된 channelId
const msgsByCh = new Map();         // channelId -> ChatMessage[]
const openThreads = new Set();      // 렌더 후에도 펼침 유지할 anchor id

// ---- ws 연결(재연결 백오프 1s→5s→30s) ----
const delays = [1000, 5000, 30000];
let attempt = 0;
function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => {
    attempt = 0;
    document.getElementById('dot').classList.add('on');
    ws.send(JSON.stringify({ t: 'channels' }));
  };
  ws.onclose = () => {
    document.getElementById('dot').classList.remove('on');
    const d = delays[Math.min(attempt++, delays.length - 1)];
    setTimeout(connect, d);
  };
  ws.onmessage = (ev) => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }
    if (f.t === 'channels') {
      channels = f.list;
      if (!current || !channels.some((c) => c.id === current)) selectChannel(channels[0] && channels[0].id);
      renderChannels();
    } else if (f.t === 'history') {
      msgsByCh.set(f.channelId, f.messages);
      if (f.channelId === current) renderMsgs();
    } else if (f.t === 'msg') {
      const arr = msgsByCh.get(f.channelId) || [];
      arr.push(f.message);
      msgsByCh.set(f.channelId, arr);
      if (f.channelId === current) renderMsgs();
    }
  };
}

function selectChannel(id) {
  if (!id) return;
  current = id;
  if (!msgsByCh.has(id) && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ t: 'history', channelId: id }));
  }
  renderChannels();
  renderMsgs();
}

// ---- 렌더(외부 문자열은 전부 textContent) ----
function renderChannels() {
  const box = document.getElementById('channels');
  box.replaceChildren();
  for (const c of channels) {
    const div = document.createElement('div');
    div.className = 'ch' + (c.id === current ? ' sel' : '');
    const name = document.createElement('span');
    name.textContent = '# ' + c.name;
    div.appendChild(name);
    const menu = document.createElement('span');
    menu.className = 'menu';
    menu.textContent = '⋯';
    menu.onclick = (e) => { e.stopPropagation(); channelMenu(c); };
    div.appendChild(menu);
    div.onclick = () => selectChannel(c.id);
    box.appendChild(div);
  }
}

function channelMenu(c) {
  const toggle = c.respondMode === 'all' ? 'mention' : 'all';
  const label = toggle === 'all' ? T.modeAll : T.modeMention;
  // 미니멀 메뉴: confirm 2단(모드 토글 → 삭제). ponytail: 커스텀 팝오버는 필요해지면.
  if (window.confirm(label + ' — OK?')) {
    ws.send(JSON.stringify({ t: 'setRespondMode', id: c.id, mode: toggle }));
  } else if (window.confirm(T.delConfirm(c.name))) {
    ws.send(JSON.stringify({ t: 'deleteChannel', id: c.id }));
  }
}

function makeMsgEl(m) {
  const div = document.createElement('div');
  div.className = 'msg' + (m.authorId !== 'engram' ? ' me' : '');
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = (m.authorId === 'engram' ? T.engram : T.me) + ' · ' + new Date(m.ts).toLocaleTimeString();
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = m.text;
  div.appendChild(who);
  div.appendChild(body);
  return div;
}

function renderMsgs() {
  const box = document.getElementById('msgs');
  box.replaceChildren();
  const msgs = msgsByCh.get(current) || [];
  const replies = new Map(); // anchorId -> msgs
  for (const m of msgs) {
    if (m.threadId) {
      if (!replies.has(m.threadId)) replies.set(m.threadId, []);
      replies.get(m.threadId).push(m);
    }
  }
  for (const m of msgs) {
    if (m.threadId) continue; // 본류만 직접 렌더
    box.appendChild(makeMsgEl(m));
    const rs = replies.get(m.id) || [];
    if (rs.length === 1) {
      box.appendChild(makeMsgEl(rs[0])); // 답 1개 = 인라인(일반 채팅처럼)
    } else if (rs.length >= 2) {
      const det = document.createElement('details');
      det.className = 'thread';
      if (openThreads.has(m.id)) det.open = true;
      det.ontoggle = () => { det.open ? openThreads.add(m.id) : openThreads.delete(m.id); };
      const sum = document.createElement('summary');
      sum.textContent = '🧵 ' + T.replies(rs.length);
      det.appendChild(sum);
      for (const r of rs) det.appendChild(makeMsgEl(r));
      const bar = document.createElement('div');
      bar.className = 'treply';
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = T.replyPh;
      inp.onkeydown = (e) => {
        if (e.key === 'Enter' && inp.value.trim()) {
          ws.send(JSON.stringify({ t: 'send', channelId: current, threadId: m.id, text: inp.value }));
          inp.value = '';
        }
      };
      bar.appendChild(inp);
      det.appendChild(bar);
      box.appendChild(det);
    }
  }
  box.scrollTop = box.scrollHeight;
}

// ---- 입력 ----
function sendMain() {
  const inp = document.getElementById('input');
  if (!inp.value.trim() || !current || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ t: 'send', channelId: current, text: inp.value }));
  inp.value = '';
}
document.getElementById('send').onclick = sendMain;
document.getElementById('input').onkeydown = (e) => { if (e.key === 'Enter') sendMain(); };
document.getElementById('newch').onclick = () => {
  const name = window.prompt(T.newChannelPrompt);
  if (name && name.trim() && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ t: 'createChannel', name }));
  }
};

connect();
</script>
</body>
</html>
```

- [ ] **Step 2: electron-builder files 목록에 추가**

`package.json` `build.files` 배열의 `"src/desktop/settings.html"` 다음 줄에:
```json
      "src/desktop/chat.html",
```

- [ ] **Step 3: 수동 스모크(브라우저)**

```powershell
npm run build
$env:ENGRAM_DATA_DIR = Join-Path $env:TEMP 'engram-p9-smoke'
node dist/src/main.js
```
브라우저에서 `http://127.0.0.1:47800/` 열기. 확인 체크리스트:
1. general 채널 보임, 연결 점 초록.
2. 메시지 입력 → 내 말풍선 표시(영속 확인: 상주 재시작 후 새로고침 → 기록 복원).
3. 새 채널 만들기 → 목록 반영.
4. (claude CLI 인증돼 있으면) 질문 → Engram 답 인라인 표시. 여러 답이 달리는 작업(협업 위임)은 🧵 접힘 확인.
5. 상주 프로세스 kill → 점 빨강 → 재기동 → 자동 재연결(점 초록).

확인 후 정리: 프로세스 종료, `Remove-Item Env:ENGRAM_DATA_DIR`.

- [ ] **Step 4: 커밋**

```powershell
git add src/desktop/chat.html package.json
git commit -m "feat(phase9): chat.html - 채널·자동 스레드·재연결·i18n 채팅 UI(서버 서빙 단일 페이지)"
```

---

### Task 8: Electron 트레이 "채팅 열기" + 채팅 창

**Files:**
- Modify: `src/desktop/main.ts`

**Interfaces:**
- Consumes: T2 `loadChatConfig`(같은 빌드 산출물이라 직접 import), T7 서버가 서빙하는 페이지
- Produces: 트레이 메뉴 최상단 "Open Chat"/"채팅 열기", 트레이 더블클릭=채팅. 자식(상주) 기동 전이면 2초 간격 재시도.

- [ ] **Step 1: desktop/main.ts 수정**

import 추가:
```ts
import { loadChatConfig } from '../edge/messenger/chat.config';
```

상태 변수(설정창 옆에):
```ts
let chatWin: BrowserWindow | null = null;
```

T 사전에 추가:
```ts
  openChat: () => (ko() ? '채팅 열기' : 'Open Chat'),
```

함수 추가(openSettings 아래):
```ts
// ---- 채팅 창(Phase 9): 자식(상주)이 서빙하는 페이지를 그대로 로드 — 폰 브라우저와 단일 코드 경로 ----
function openChat(): void {
  if (chatWin) {
    chatWin.focus();
    return;
  }
  const cfg = loadChatConfig(configDir, childEnv);
  chatWin = new BrowserWindow({ width: 980, height: 720, title: 'Engram' });
  const load = (): void => {
    void chatWin?.loadURL(`http://127.0.0.1:${cfg.port}/`);
  };
  // 자식이 아직 리슨 전이면 로드 실패 → 2초 후 재시도(자식 감독 백오프와 별개, 창 닫히면 중단).
  chatWin.webContents.on('did-fail-load', () => {
    setTimeout(() => { if (chatWin) load(); }, 2000);
  });
  chatWin.on('closed', () => (chatWin = null));
  load();
}
```

`createTray()`의 메뉴/더블클릭 변경:
```ts
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: T.openChat(), click: () => openChat() },
      { label: T.openSettings(), click: () => openSettings() },
      { label: T.restart(), click: () => restartChild() },
      { type: 'separator' },
      { label: T.quit(), click: () => app.quit() },
    ]),
  );
  tray.on('double-click', () => openChat());
```

- [ ] **Step 2: 빌드·기존 스위트 확인**

Run: `npx tsc --noEmit; npm run build; npx jest src/desktop`
Expected: 클린 + desktop 기존 테스트 PASS(main.ts는 Electron 글루 — 테스트 없음 관례)

- [ ] **Step 3: 수동 스모크(Electron)**

```powershell
npm run desktop:dev
```
확인: 트레이 아이콘 더블클릭 → 채팅 창. 자식 기동 직후 잠깐 실패해도 2초 내 자동 로드. 채팅 창에서 T7 체크리스트 2번(메시지 왕복) 재확인. 설정 창도 메뉴에서 여전히 열림.

- [ ] **Step 4: 커밋**

```powershell
git add src/desktop/main.ts
git commit -m "feat(phase9): 트레이 '채팅 열기' + Electron 채팅 창(did-fail-load 재시도)"
```

---

### Task 9: README + 전체 검증

**Files:**
- Modify: `README.md` (채팅 UI 섹션 추가)

- [ ] **Step 1: README에 섹션 추가**

기존 Discord/설정 안내 근처에(문체·수준 맞출 것):

```markdown
## 채팅 UI (Phase 9)

상주가 자체 채팅 서버를 내장한다(기본 `127.0.0.1:47800`). 트레이 → **채팅 열기**,
또는 브라우저에서 `http://127.0.0.1:47800/`.

- 채널 = 대화 기억 단위(채널마다 별도 맥락). 작업 위임 시 진행 보고는 해당
  메시지 밑 🧵 스레드로 접힌다. 스레드 안에서 답장하면 그 작업에 대한 지시가 된다.
- 설정: `config/chat.json` `{ "enabled": true, "port": 47800, "bind": "127.0.0.1" }`
  (env `ENGRAM_CHAT_PORT`/`ENGRAM_CHAT_BIND` 우선). `enabled: false`로 끌 수 있다.
- 채널별 반응 모드: 기본은 모든 메시지에 반응. 채널 ⋯ 메뉴에서 `@Engram` 멘션에만
  반응(나머지는 관찰)으로 바꿀 수 있다.
- Discord는 기존대로 병행 동작한다(`config/messenger.json`).

⚠️ **보안**: 인증이 아직 없다. `bind`를 `127.0.0.1` 이외(외부 개방)로 바꾸지 말 것 —
원격 접속(폰·팀원)은 인증이 들어오는 다음 단계에서 지원된다.
```

- [ ] **Step 2: 전체 검증**

Run: `npx tsc --noEmit; npm run build; npm test`
Expected: 전부 클린/PASS. 실패가 있으면 고치고 나서 진행(자기보고 금지 — 출력 확인).

- [ ] **Step 3: 커밋**

```powershell
git add README.md
git commit -m "docs(phase9): 채팅 UI 사용법·보안 주의(바인딩 개방 금지)"
```

---

## 자체 검토 노트 (플랜 작성 시 확인됨)

- 스펙 §2 범위 1~5 ↔ T3·T4(어댑터), T1(스토어), T5(허브), T7·T8(UI), T6(결선) — 전부 매핑됨. §9 테스트 항목도 각 태스크 Step에 포함.
- ScheduleService·AmbientService가 `postToChannel`만 쓰는 것 grep으로 확인됨(타입 좁히기 안전).
- `MentionEvent.threadId`는 본류에서 undefined(스펙 수정 반영) — `상태` 조회의 채널 단위 집계(threadKey=channelId) 유지.
- `channelId` 신뢰 경계 검증은 ChatStore(`safeId`+`has`)에 한 곳으로 모음 — 어댑터·허브는 스토어를 통해서만 파일에 닿는다.
- 알려진 한계(의도): 채널 ⋯ 메뉴가 confirm 2단(투박) — 9b에서 UI 다듬기. `history`는 최신 100개만 로드(스크롤 페이지네이션 미구현, `before` 프로토콜만 준비됨).
