# Phase 13 — 인증 + 원격 노출 (Auth + Remote) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 두뇌 채팅 WS 소켓에 단일 공유 토큰 인증을 넣어, 원격(폰·다른 기기)에서 붙을 수 있게 한다.

**Architecture:** 서버(`self.adapter.ts`)가 `chat.json`의 `token`이 설정되면 모든 WS 연결에 인증 프레임(`{t:'auth',token}`)을 요구한다 — 접속 직후 미인증 상태로 두고, 올바른 토큰 프레임이 오면 승격, 아니면 소켓을 닫는다. 클라(renderer)는 연결마다 `token`을 갖고 open 시 auth 프레임을 먼저 보낸다. 데스크톱 로컬 연결은 main이 URL로 토큰을 주입해 마찰 0. 릴레이·터널·TLS는 만들지 않는다(사용자가 앞에 세움 — 문서화만).

**Tech Stack:** NestJS + TypeScript + `ws`(백엔드, Jest) / React 19 + Vite + TypeScript(렌더러, Vitest + Testing Library).

## Global Constraints

- **하위호환 절대**: `token` 미설정 시 서버·클라 동작은 현행과 100% 동일. 기존 테스트 무변경 통과.
- **로프백 예외 없음**: 토큰이 설정되면 로컬 접속도 인증 필요(터널 앞단이면 원격이 로프백으로 보이므로).
- **토큰 전달 = 인증 프레임**(URL 쿼리 금지 — 프록시·히스토리 평문 누수 방지).
- **두뇌 코어·오케스트레이터·위키·`ChatStore` 무변경.** 변경은 config·adapter·protocol·renderer에 국한.
- **UI 문구 영어 기본 / ko 로케일 한국어**(`i18n.ts`의 `ko` 삼항).
- **자체 릴레이/터널/TLS 미구현** — 원격 도달은 사용자가 Cloudflare Tunnel/리버스 프록시로 해결(README 안내만).
- 백엔드 테스트: `npx jest <path>` · 백엔드 빌드: `npm run build`
- 렌더러 테스트: `cd renderer && npx vitest run <path>` · 렌더러 빌드: `npm run renderer:build`

## File Structure

| 파일 | 책임 | 변경 |
|------|------|------|
| `shared/protocol.ts` | ws 프레임 계약 | `auth`(C→S)·`authErr`(S→C) 프레임 추가 |
| `src/edge/messenger/chat.config.ts` | 채팅 설정 로드 | `token` 필드 + `ENGRAM_CHAT_TOKEN` env |
| `src/edge/messenger/self.adapter.ts` | ws 서버·인증 관문 | 미인증 상태·타임아웃·broadcast 게이트 |
| `src/desktop/main.ts` | Electron 렌더러 로드 | 로컬 URL에 `?token=` 주입 |
| `renderer/src/config.ts` | 렌더러 부트 설정 | `LOCAL_TOKEN` export |
| `renderer/src/connections.ts` | 연결 모델·저장 | `Connection.token` + seed/patch |
| `renderer/src/i18n.ts` | UI 문구 | `tokenPh`·`authFailed` |
| `renderer/src/components/ManageEngrams.tsx` | 연결 관리 UI | 토큰 입력칸 |
| `renderer/src/ws/connections-client.ts` | 소켓 관리 훅 | auth 선전송·authErr 중단·토큰 변경 재접속 |
| `renderer/src/App.tsx` | 앱 배선 | onFrame authErr·addConnection(token) |
| `README.md` | 문서 | 보안 단락 갱신 |

---

## Task 1: 설정에 토큰 필드

**Files:**
- Modify: `src/edge/messenger/chat.config.ts`
- Test: `src/edge/messenger/chat.config.spec.ts`

**Interfaces:**
- Produces: `ChatConfig.token?: string` — 설정 시 서버가 인증 요구. env `ENGRAM_CHAT_TOKEN` 우선. 빈/공백 → `undefined`.

- [ ] **Step 1: 실패 테스트 작성**

`src/edge/messenger/chat.config.spec.ts`에 아래 테스트를 추가한다(파일 기존 import·`describe`를 따르되, 자체 tmpdir로 독립적으로):

```ts
import * as os from 'os';
// (파일 상단에 이미 fs, path, loadChatConfig import 있음 — 없으면 추가)

describe('chat.config 토큰', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cfgtok-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('chat.json token 값을 수용한다', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ token: 'sekret' }));
    expect(loadChatConfig(dir, {}).token).toBe('sekret');
  });
  it('env ENGRAM_CHAT_TOKEN이 파일보다 우선한다', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ token: 'file' }));
    expect(loadChatConfig(dir, { ENGRAM_CHAT_TOKEN: 'env' }).token).toBe('env');
  });
  it('빈/공백 토큰은 undefined(무인증)', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ token: '   ' }));
    expect(loadChatConfig(dir, {}).token).toBeUndefined();
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({}));
    expect(loadChatConfig(dir, {}).token).toBeUndefined();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/edge/messenger/chat.config.spec.ts`
Expected: FAIL — `token` 프로퍼티 없음(타입/런타임 undefined).

- [ ] **Step 3: 최소 구현**

`src/edge/messenger/chat.config.ts` — 인터페이스에 필드 추가(주석 갱신):

```ts
// 자체 채팅 서버 설정(스펙 §3). 기본 = 가동·127.0.0.1:47800. enabled:false만 끔.
// token 설정 시 모든 ws 연결이 인증 필요(Phase 13). env는 포트/바인딩/토큰 오버라이드.

export interface ChatConfig {
  enabled: boolean;
  port: number;
  bind: string;
  language?: string; // BCP-47 코드(예 'ko'/'en'). 미설정=OS 로케일 폴백(main.ts).
  token?: string;    // 설정 시 모든 ws 연결이 auth 프레임으로 제시해야 함. 미설정=무인증(현행).
}
```

`loadChatConfig`의 `return` 직전에 token 계산을 추가하고 반환에 포함:

```ts
  const language = typeof raw.language === 'string' && raw.language.trim() ? raw.language.trim() : undefined;
  const token = (typeof env.ENGRAM_CHAT_TOKEN === 'string' && env.ENGRAM_CHAT_TOKEN.trim())
    || (typeof raw.token === 'string' && raw.token.trim())
    || undefined;
  return { enabled: raw.enabled !== false, port, bind, language, token };
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/edge/messenger/chat.config.spec.ts`
Expected: PASS (신규 3건 + 기존 전부).

- [ ] **Step 5: 커밋**

```bash
git add src/edge/messenger/chat.config.ts src/edge/messenger/chat.config.spec.ts
git commit -m "feat(phase13): chat.config에 token 필드 + ENGRAM_CHAT_TOKEN env"
```

---

## Task 2: 서버 인증 관문

**Files:**
- Modify: `shared/protocol.ts`
- Modify: `src/edge/messenger/self.adapter.ts`
- Test: `src/edge/messenger/self.adapter.spec.ts`

**Interfaces:**
- Consumes: `ChatConfig.token`(Task 1).
- Produces: 와이어 프레임 `{t:'auth',token:string}`(C→S), `{t:'authErr'}`(S→C). 토큰 설정 시 미인증 소켓은 auth 외 프레임 미처리·close. broadcast는 인증 소켓에만.

- [ ] **Step 1: 실패 테스트 작성**

`src/edge/messenger/self.adapter.spec.ts` 맨 아래에 새 `describe` 추가(파일 상단의 `fs/os/path/WebSocket/SelfMessenger/ChatStore/noLog/once/nextFrame`를 그대로 사용):

```ts
describe('SelfMessenger 인증(토큰)', () => {
  let dir: string;
  let store: ChatStore;
  let sm: SelfMessenger;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-auth-'));
    store = new ChatStore(dir);
    store.listChannels(); // general 생성
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', token: 'sekret' }, store, { logger: noLog });
    await sm.start();
  });
  afterEach(async () => {
    await sm.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('올바른 auth 후 channels 프레임이 처리된다', async () => {
    const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(c, 'open');
    c.send(JSON.stringify({ t: 'auth', token: 'sekret' }));
    c.send(JSON.stringify({ t: 'channels' }));
    const f = await nextFrame(c);
    expect(f.t).toBe('channels');
    c.terminate();
  });

  it('틀린 토큰 → authErr 후 서버가 소켓을 닫는다', async () => {
    const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(c, 'open');
    c.send(JSON.stringify({ t: 'auth', token: 'wrong' }));
    const f = await nextFrame(c);
    expect(f.t).toBe('authErr');
    await once(c, 'close');
    c.terminate();
  });

  it('auth 없이 바로 channels → authErr(미처리)', async () => {
    const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(c, 'open');
    c.send(JSON.stringify({ t: 'channels' }));
    const f = await nextFrame(c);
    expect(f.t).toBe('authErr');
    c.terminate();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: FAIL — 인증 없이 `channels`가 처리되어 `authErr` 대신 `channels`가 돌아옴.

- [ ] **Step 3: 프레임 타입 추가**

`shared/protocol.ts` — `ClientFrame`·`ServerFrame` 유니온에 각각 추가:

```ts
// 클라 → 서버
export type ClientFrame =
  | { t: 'auth'; token: string }
  | { t: 'channels' }
  | { t: 'history'; channelId: string; before?: string }
  | { t: 'send'; channelId: string; text: string; threadId?: string; authorId?: string }
  | { t: 'createChannel'; name: string; mode?: 'chat' | 'code' | 'team' }
  | { t: 'deleteChannel'; id: string }
  | { t: 'setRepoPath'; id: string; repoPath: string }
  | { t: 'setRespondMode'; id: string; mode: 'all' | 'mention' };

// 서버 → 클라
export type ServerFrame =
  | { t: 'channels'; list: Channel[] }
  | { t: 'history'; channelId: string; messages: Message[] }
  | { t: 'msg'; channelId: string; message: Message }
  | { t: 'authErr' }
  | { t: 'error'; text: string };
```

- [ ] **Step 4: 서버 인증 상태 머신 구현**

`src/edge/messenger/self.adapter.ts`:

(a) 클래스 상단 필드에 인증 소켓 집합 추가(`private wss?` 근처):

```ts
  private authed = new WeakSet<WebSocket>();
```

(b) `start()`의 `connection` 핸들러를 교체 — 토큰 없으면 즉시 통과, 있으면 5초 인증 타임아웃:

```ts
    this.wss.on('connection', (ws) => {
      if (!this.cfg.token) {
        this.authed.add(ws); // 무인증 모드: 즉시 통과(현행 동작)
      } else {
        const timer = setTimeout(() => {
          if (!this.authed.has(ws)) { try { ws.close(); } catch { /* 격리 */ } }
        }, 5000);
        ws.once('close', () => clearTimeout(timer));
      }
      ws.on('message', (raw) => { void this.handleFrame(ws, String(raw)); });
      ws.on('error', () => { /* 접속 단위 격리 */ });
    });
```

(c) `handleFrame`의 JSON 파싱 직후, `switch` 앞에 인증 게이트 삽입:

```ts
  private async handleFrame(ws: WebSocket, raw: string): Promise<void> {
    let f: Record<string, unknown>;
    try { f = JSON.parse(raw) as Record<string, unknown>; } catch { return; } // 손상 무시
    if (this.cfg.token && !this.authed.has(ws)) {
      if (f?.t === 'auth' && f.token === this.cfg.token) {
        this.authed.add(ws); // 승격 — 이후 정상 처리
      } else {
        this.sendTo(ws, { t: 'authErr' });
        try { ws.close(); } catch { /* 격리 */ }
      }
      return;
    }
    try {
      switch (f?.t) {
        // ... 기존 case 그대로 ...
```

(d) `broadcast`가 인증 소켓에만 보내도록 게이트 추가:

```ts
  private broadcast(frame: ServerFrame): void {
    const data = JSON.stringify(frame);
    for (const c of this.wss?.clients ?? []) {
      if (c.readyState === WebSocket.OPEN && this.authed.has(c)) {
        try { c.send(data); } catch { /* 격리 */ }
      }
    }
  }
```

(e) 파일 상단 주석의 "개방(0.0.0.0)은 9b(토큰 인증)까지 금지" 문장을 갱신:

```ts
// 기본 바인딩 127.0.0.1. token(chat.json/ENGRAM_CHAT_TOKEN) 설정 시 모든 연결이 auth 프레임 필요(Phase 13).
// 인터넷 노출은 여전히 TLS 앞단(터널/리버스 프록시)이 필수 — Engram은 릴레이/TLS를 제공하지 않는다.
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: PASS (신규 3건 + 기존 코어 전부 — 무토큰이라 회귀 없음).

- [ ] **Step 6: 커밋**

```bash
git add shared/protocol.ts src/edge/messenger/self.adapter.ts src/edge/messenger/self.adapter.spec.ts
git commit -m "feat(phase13): ws 인증 관문 — auth/authErr 프레임, 미인증 소켓 차단·타임아웃"
```

---

## Task 3: 렌더러 연결 모델에 토큰

**Files:**
- Modify: `renderer/src/connections.ts`
- Test: `renderer/src/connections.test.ts`

**Interfaces:**
- Produces: `Connection.token?: string`; `addConnection(state, name, endpoint, token?)`. localStorage 라운드트립에 token 보존.

- [ ] **Step 1: 실패 테스트 작성**

`renderer/src/connections.test.ts`에 추가(기존 import·localStorage setup 그대로 사용):

```ts
it('addConnection: token을 저장하고 로드에서 복원한다', () => {
  const s = addConnection(loadConnections(), 'Remote', 'ws://r', 'tok');
  saveConnections(s);
  expect(loadConnections().connections.find((c) => c.name === 'Remote')?.token).toBe('tok');
});

it('addConnection: token 없으면 undefined(필드 미포함)', () => {
  const s = addConnection(loadConnections(), 'Plain', 'ws://p');
  expect(s.connections.find((c) => c.name === 'Plain')?.token).toBeUndefined();
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd renderer && npx vitest run src/connections.test.ts`
Expected: FAIL — `addConnection` 4번째 인자 없음(타입 에러) / token undefined.

- [ ] **Step 3: 최소 구현**

`renderer/src/connections.ts`:

인터페이스에 token 추가:
```ts
export interface Connection { id: string; name: string; endpoint: string; token?: string }
```

`addConnection` 시그니처·본문:
```ts
export function addConnection(state: State, name: string, endpoint: string, token?: string): State {
  const conn: Connection = { id: newId(state, name), name, endpoint, ...(token ? { token } : {}) };
  return { connections: [...state.connections, conn], defaultConnId: state.defaultConnId };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd renderer && npx vitest run src/connections.test.ts`
Expected: PASS (신규 2건 + 기존 전부).

- [ ] **Step 5: 커밋**

```bash
git add renderer/src/connections.ts renderer/src/connections.test.ts
git commit -m "feat(phase13): Connection.token 모델 + addConnection token 인자"
```

---

## Task 4: WS 클라이언트 인증 선전송·재접속 처리

**Files:**
- Modify: `renderer/src/ws/connections-client.ts`
- Test: `renderer/src/ws/connections-client.test.ts`

**Interfaces:**
- Consumes: `Connection.token`(Task 3), `authErr` 프레임(Task 2).
- Produces: open 시 token 있으면 `{t:'auth',token}` 최우선 전송. `authErr` 수신 시 그 연결 재연결 중단. token 변경 시 소켓 재생성.

- [ ] **Step 1: 실패 테스트 작성**

`renderer/src/ws/connections-client.test.ts`에 추가(파일 상단 `FakeWS`·`beforeEach` stub 그대로 사용):

```ts
it('토큰이 있으면 open 시 auth 프레임을 가장 먼저 보낸다', () => {
  const conns = [{ id: 'a', name: 'A', endpoint: 'ws://a', token: 'sekret' }];
  renderHook(() => useConnections(conns, () => {}));
  act(() => { FakeWS.instances[0].open(); });
  expect(FakeWS.instances[0].sent[0]).toBe(JSON.stringify({ t: 'auth', token: 'sekret' }));
});

it('토큰이 없으면 auth 프레임을 보내지 않는다', () => {
  const conns = [{ id: 'a', name: 'A', endpoint: 'ws://a' }];
  renderHook(() => useConnections(conns, () => {}));
  act(() => { FakeWS.instances[0].open(); });
  expect(FakeWS.instances[0].sent).toHaveLength(0);
});

it('authErr 수신 시 재연결하지 않는다', () => {
  vi.useFakeTimers();
  const conns = [{ id: 'a', name: 'A', endpoint: 'ws://a', token: 'wrong' }];
  renderHook(() => useConnections(conns, () => {}));
  act(() => {
    FakeWS.instances[0].open();
    FakeWS.instances[0].msg({ t: 'authErr' });
    FakeWS.instances[0].close();
  });
  act(() => { vi.advanceTimersByTime(30000); });
  expect(FakeWS.instances).toHaveLength(1); // 재연결 시도 없음
  vi.useRealTimers();
});

it('토큰을 바꾸면 소켓을 새 토큰으로 재접속한다', () => {
  const { rerender } = renderHook(
    ({ connections }) => useConnections(connections, () => {}),
    { initialProps: { connections: [{ id: 'a', name: 'A', endpoint: 'ws://a', token: 't1' }] } },
  );
  act(() => { FakeWS.instances[0].open(); });
  expect(FakeWS.instances).toHaveLength(1);
  act(() => { rerender({ connections: [{ id: 'a', name: 'A', endpoint: 'ws://a', token: 't2' }] }); });
  expect(FakeWS.instances).toHaveLength(2);          // 재생성
  expect(FakeWS.instances[0].readyState).toBe(3);    // 옛 소켓 닫힘
  act(() => { FakeWS.instances[1].open(); });
  expect(FakeWS.instances[1].sent[0]).toBe(JSON.stringify({ t: 'auth', token: 't2' }));
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd renderer && npx vitest run src/ws/connections-client.test.ts`
Expected: FAIL — auth 미전송, authErr 후에도 재연결, 토큰 변경 시 재생성 안 함.

- [ ] **Step 3: 구현**

`renderer/src/ws/connections-client.ts`:

(a) `Slot` 인터페이스에 필드 추가:
```ts
interface Slot {
  ws: WebSocket | null;
  attempt: number;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  authFailed: boolean;   // authErr 받으면 true → 재연결 중단
  token?: string;        // 이 소켓이 붙을 때 쓴 토큰(변경 감지용)
}
```

(b) `ids`가 토큰 변경도 감지하도록:
```ts
  const ids = connections.map((c) => `${c.id}:${c.token ?? ''}`).join(',');
```

(c) effect의 정리 루프를 "사라짐 OR 토큰 변경"으로 확장:
```ts
    // 사라졌거나 토큰이 바뀐 슬롯은 닫는다(토큰 변경=재접속 필요).
    for (const [id, slot] of slots) {
      const w = wanted.get(id);
      if (w && w.token === slot.token) continue;
      slot.closed = true;
      if (slot.timer) clearTimeout(slot.timer);
      slot.ws?.close();
      slots.delete(id);
      setStatusById((s) => {
        if (!(id in s)) return s;
        const next = { ...s };
        delete next[id];
        return next;
      });
    }
```

(d) 새 슬롯 생성 시 `authFailed`·`token` 채우기:
```ts
      const slot: Slot = { ws: null, attempt: 0, closed: false, timer: null, authFailed: false, token: conn.token };
```

(e) `ws.onopen`에서 토큰 있으면 auth 먼저(최신 토큰을 ref로 읽음):
```ts
        ws.onopen = () => {
          slot.attempt = 0;
          const tok = connectionsRef.current.find((c) => c.id === connId)?.token;
          if (tok) ws.send(JSON.stringify({ t: 'auth', token: tok }));
          setStatusById((s) => ({ ...s, [connId]: true }));
          onOpenRef.current?.(connId);
        };
```

(f) `ws.onclose`에서 authFailed면 재연결 스킵:
```ts
        ws.onclose = () => {
          setStatusById((s) => ({ ...s, [connId]: false }));
          if (slot.closed || slot.authFailed) return;
          const d = DELAYS[Math.min(slot.attempt++, DELAYS.length - 1)];
          slot.timer = setTimeout(connect, d);
        };
```

(g) `ws.onmessage`에서 authErr 감지 후 상위로도 전달:
```ts
        ws.onmessage = (ev) => {
          let f: ServerFrame;
          try { f = JSON.parse(ev.data as string) as ServerFrame; } catch { return; }
          if (f.t === 'authErr') slot.authFailed = true; // onclose가 재연결 중단
          onFrameRef.current(connId, f);
        };
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd renderer && npx vitest run src/ws/connections-client.test.ts`
Expected: PASS (신규 4건 + 기존 전부).

- [ ] **Step 5: 커밋**

```bash
git add renderer/src/ws/connections-client.ts renderer/src/ws/connections-client.test.ts
git commit -m "feat(phase13): ws 클라 auth 선전송·authErr 재연결 중단·토큰 변경 재접속"
```

---

## Task 5: 렌더러 배선 — Manage 입력·App authErr

**Files:**
- Modify: `renderer/src/i18n.ts`
- Modify: `renderer/src/components/ManageEngrams.tsx`
- Modify: `renderer/src/App.tsx`
- Test: `renderer/src/components/ManageEngrams.test.tsx` (Create)

**Interfaces:**
- Consumes: `addConnection(...,token?)`(Task 3), `authErr` 프레임(Task 2), `T.tokenPh`/`T.authFailed`.
- Produces: Manage 모달의 토큰 입력 → `onAdd(name, endpoint, token?)`. App은 authErr를 그 연결 `errText`로 표시.

- [ ] **Step 1: 실패 테스트 작성**

`renderer/src/components/ManageEngrams.test.tsx` 생성:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { ManageEngrams } from './ManageEngrams';

it('토큰 입력을 onAdd 3번째 인자로 넘긴다', () => {
  const calls: unknown[][] = [];
  const { container } = render(
    <ManageEngrams
      connections={[{ id: 'local', name: 'Local', endpoint: 'ws://x' }]}
      defaultConnId="local"
      onAdd={(...a) => calls.push(a)}
      onRemove={() => {}}
      onSetDefault={() => {}}
      onClose={() => {}}
    />,
  );
  const inputs = container.querySelectorAll('#addEngram input');
  fireEvent.change(inputs[0], { target: { value: 'Remote' } });
  fireEvent.change(inputs[1], { target: { value: 'ws://r' } });
  fireEvent.change(inputs[2], { target: { value: 'tok' } });
  fireEvent.click(screen.getByText(/Add Engram|Engram 추가/));
  expect(calls[0]).toEqual(['Remote', 'ws://r', 'tok']);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd renderer && npx vitest run src/components/ManageEngrams.test.tsx`
Expected: FAIL — 토큰 입력칸(3번째 input) 없음 / onAdd가 2인자만 넘김.

- [ ] **Step 3: i18n 키 추가**

`renderer/src/i18n.ts` — `T` 객체의 기존 `manageEngrams`/`addEngram` 근처에 두 줄 추가:

```ts
  tokenPh: ko ? '토큰 (선택)' : 'Token (optional)',
  authFailed: ko ? '인증 실패 — 토큰을 확인하세요' : 'Authentication failed — check the token',
```

- [ ] **Step 4: Manage 모달에 토큰 입력**

`renderer/src/components/ManageEngrams.tsx`:

`onAdd` prop 타입에 token 추가:
```ts
  onAdd: (name: string, endpoint: string, token?: string) => void;
```

token 상태·submit·입력칸:
```ts
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');

  const submit = () => {
    if (!name.trim() || !endpoint.trim()) return;
    onAdd(name.trim(), endpoint.trim(), token.trim() || undefined);
    setName(''); setEndpoint(''); setToken('');
  };
```

`#addEngram` 블록의 endpoint input 다음에 토큰 input 추가(password 타입 — 어깨너머 노출 방지):
```tsx
        <div id="addEngram">
          <input type="text" placeholder={T.engramNamePh} value={name} onChange={(e) => setName(e.target.value)} />
          <input type="text" placeholder={T.engramEndpointPh} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
          <input type="password" placeholder={T.tokenPh} value={token} onChange={(e) => setToken(e.target.value)} />
          <button type="button" onClick={submit}>{T.addEngram}</button>
        </div>
```

- [ ] **Step 5: App 배선 — authErr 표시 + token 전달**

`renderer/src/App.tsx`:

`onFrame`의 `error` 분기 앞(또는 뒤)에 authErr 분기 추가:
```ts
    } else if (f.t === 'authErr') {
      setErrText((prev) => ({ ...prev, [connId]: T.authFailed }));
    } else if (f.t === 'error') {
```
(`T`가 App에 import되어 있지 않으면 상단에 `import { T } from './i18n';` 확인 — 이미 있으면 스킵.)

`ManageEngrams`의 `onAdd`가 token을 통과하도록(기존 line ~278):
```tsx
          onAdd={(name, endpoint, token) => setConnState((s) => addConnection(s, name, endpoint, token))}
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `cd renderer && npx vitest run src/components/ManageEngrams.test.tsx`
Expected: PASS.

- [ ] **Step 7: 렌더러 전체 테스트 + 빌드**

Run: `cd renderer && npx vitest run`
Expected: PASS (전체).
Run: `npm run renderer:build`
Expected: `tsc -b` exit 0 + vite build 성공(타입 에러 0 — authErr·token 타입 정합).

- [ ] **Step 8: 커밋**

```bash
git add renderer/src/i18n.ts renderer/src/components/ManageEngrams.tsx renderer/src/components/ManageEngrams.test.tsx renderer/src/App.tsx
git commit -m "feat(phase13): Manage 토큰 입력·App authErr 표시 배선"
```

---

## Task 6: 데스크톱 로컬 연결 토큰 자동 주입

**Files:**
- Modify: `renderer/src/config.ts`
- Modify: `renderer/src/connections.ts`
- Modify: `src/desktop/main.ts`
- Test: `renderer/src/connections.test.ts` (seed patch 단위)

**Interfaces:**
- Consumes: `ChatConfig.token`(Task 1), `LOCAL_TOKEN`.
- Produces: 데스크톱에서 main이 `?token=` 주입 → `config.ts`의 `LOCAL_TOKEN` → 로컬 연결에 실림. 소유자가 토큰을 켜도 로컬 앱은 마찰 0.

주의: `main.ts`는 Electron 전용이라 이 레포에 단위 테스트가 없다(기존 관례). main 변경은 빌드(tsc)로만 검증하고 수동 스모크로 확인한다. `config.ts`의 `LOCAL_TOKEN`은 모듈 로드시 `window.location.search`를 읽으므로 단위 테스트가 까다롭다 — `connections.ts` seed 패치는 인자 주입형으로 테스트 가능하게 만든다(아래).

- [ ] **Step 1: 실패 테스트 작성**

`renderer/src/connections.test.ts`에 seed 토큰 주입 테스트 추가. seed가 `LOCAL_TOKEN`을 직접 참조하면 테스트가 어려우므로, **`loadConnections`가 로컬 연결 토큰을 부팅 주입값으로 맞추는** 동작을 인자로 검증한다:

```ts
it('loadConnections: LOCAL_TOKEN이 있으면 local 연결에 실린다(신규 시드)', () => {
  localStorage.clear();
  expect(loadConnections('injected').connections.find((c) => c.id === 'local')?.token).toBe('injected');
});

it('loadConnections: LOCAL_TOKEN이 있으면 기존 local 연결에도 패치된다', () => {
  saveConnections({ connections: [{ id: 'local', name: 'Local', endpoint: 'ws://x' }], defaultConnId: 'local' });
  expect(loadConnections('patched').connections.find((c) => c.id === 'local')?.token).toBe('patched');
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd renderer && npx vitest run src/connections.test.ts`
Expected: FAIL — `loadConnections`가 인자를 받지 않음 / token 미주입.

- [ ] **Step 3: config.ts LOCAL_TOKEN**

`renderer/src/config.ts` 하단에 추가:
```ts
// 데스크톱: Electron main이 chat.json의 token을 ?token=로 주입(main.ts). 브라우저(폰)엔 없음.
const tokenParam = new URLSearchParams(window.location.search).get('token');
export const LOCAL_TOKEN = (tokenParam && tokenParam.trim()) || undefined;
```

- [ ] **Step 4: connections.ts seed/patch**

`renderer/src/connections.ts`:

import에 `LOCAL_TOKEN` 추가:
```ts
import { WS_URL, LOCAL_TOKEN } from './config';
```

`loadConnections`가 선택적 토큰 인자를 받아 local 연결에 주입(기본값은 `LOCAL_TOKEN` — 프로덕션 경로, 테스트는 명시 인자):
```ts
export function loadConnections(localToken: string | undefined = LOCAL_TOKEN): State {
  let s: State;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) { s = seed(); }
    else {
      const parsed = JSON.parse(raw) as State;
      if (!parsed.connections?.length) s = seed();
      else {
        if (!parsed.connections.some((c) => c.id === parsed.defaultConnId)) parsed.defaultConnId = parsed.connections[0].id;
        s = parsed;
      }
    }
  } catch { s = seed(); }
  // 로컬 연결 토큰은 main(chat.json)이 진실원 — 부팅 주입값으로 맞춘다.
  // ponytail: localToken 있을 때만 패치. 서버 토큰 해제 후 stale 토큰이 남아도 무인증 서버는 무시하므로 무해.
  if (localToken) {
    const local = s.connections.find((c) => c.id === 'local');
    if (local) local.token = localToken;
  }
  return s;
}
```

`seed()`는 변경 없음(토큰은 위 패치에서 일괄 주입 — 신규/기존 경로 모두 커버). 기존 `seed()` 정의 유지.

- [ ] **Step 5: main.ts 주입**

`src/desktop/main.ts` line ~167의 `loadFile` search에 토큰 추가:
```ts
      const auth = cfg.token ? `&token=${encodeURIComponent(cfg.token)}` : '';
      if (chatWin) void chatWin.loadFile(rendererIndex, { search: `port=${cfg.port}&lang=${lang}${auth}` }); // 헬스 200 → 클라 로드(포트·언어·토큰 주입)
```
(기존 한 줄을 두 줄로 교체. `cfg`는 이미 이 스코프에 `loadChatConfig(configDir, childEnv)`로 있음 — line 124.)

- [ ] **Step 6: 테스트 통과 확인**

Run: `cd renderer && npx vitest run src/connections.test.ts`
Expected: PASS (신규 2건 + 기존 전부).

- [ ] **Step 7: 빌드 확인(전체 타입)**

Run: `npm run renderer:build`
Expected: `tsc -b` exit 0.
Run: `npm run build`
Expected: nest build 성공(main.ts 타입 정합 — `cfg.token` 존재).

- [ ] **Step 8: 커밋**

```bash
git add renderer/src/config.ts renderer/src/connections.ts renderer/src/connections.test.ts src/desktop/main.ts
git commit -m "feat(phase13): 데스크톱 로컬 연결 토큰 자동 주입(main ?token= → LOCAL_TOKEN → local 연결)"
```

---

## Task 7: 문서(README) 갱신

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 보안 단락 교체**

`README.md`의 "채팅 UI (Phase 9)" 절 안 `⚠️ **보안**: 인증이 아직 없다 ...` 단락(현재 line ~73-74)을 아래로 교체:

```markdown
### 원격 접속·인증 (Phase 13)

기본은 인증 없음·`127.0.0.1` 전용이다(로컬 데스크톱 앱만 붙음). **원격(폰·다른 기기)에서 붙으려면**:

1. **토큰 설정**: `config/chat.json`에 `{ "token": "임의의-긴-비밀문자열" }`(또는 env `ENGRAM_CHAT_TOKEN`).
   토큰이 설정되면 **모든 ws 연결**(로컬 포함)이 인증을 요구한다. 데스크톱 로컬 앱은 자동으로 토큰을 실어 붙으므로 추가 설정이 필요 없다.
2. **도달**: Engram은 릴레이·터널·TLS를 **제공하지 않는다**. 인터넷 노출은 **Cloudflare Tunnel**·**리버스 프록시(nginx 등)**·**Tailscale** 같은 걸 앞에 세워 처리한다. 평문 `ws://`를 그대로 인터넷에 열지 말 것 — TLS 앞단이 필수다(토큰·대화 평문 노출 방지).
3. **클라이언트**: 원격 브라우저·기기에서 renderer(정적 빌드 또는 데스크톱 앱)를 연 뒤, **Manage Engrams**에서 원격 ws 엔드포인트와 **토큰**을 입력해 연결을 추가한다. (두뇌 http는 UI 페이지를 서빙하지 않는다 — 헬스 프로브만.)

⚠️ 토큰 인증은 소켓 접근만 막는다. 뚫려도 소유자 자기 기기만 위험한 개인 셀프호스팅 전제다 — 다중 사용자 계정·신원은 이후 단계(Phase 16).
```

- [ ] **Step 2: 커밋**

```bash
git add README.md
git commit -m "docs(phase13): 원격 접속·토큰 인증 안내 — 도달은 터널/프록시 위임"
```

---

## 완료 검증(전 태스크 후)

- [ ] 백엔드 전체: `npm test` → 녹색
- [ ] 렌더러 전체: `cd renderer && npx vitest run` → 녹색
- [ ] 빌드: `npm run build` && `npm run renderer:build` → exit 0
- [ ] 수동 스모크(선택): `chat.json`에 토큰 넣고 `npm run desktop:dev` → 로컬 앱이 그대로 붙는지 확인. 토큰 지우고 재기동 → 무인증 경로 정상.

---

## Self-Review 결과

- **스펙 커버리지**: §3.1 토큰 config=Task1 / §3.2 인증 프레임·상태머신·타임아웃·broadcast 게이트=Task2 / §3.3 하위호환=Task1·2(무토큰 경로) / §4.1 Connection.token=Task3 / §4.2 Manage 입력=Task5 / §4.3 ws 클라 auth·authErr·재접속=Task4 / §4.4 로컬 주입=Task6 / §5 README=Task7 / §6 테스트=각 태스크 TDD. 갭 없음.
- **타입 정합**: `auth`/`authErr` 프레임(Task2)을 Task4가 소비, `Connection.token`(Task3)을 Task4·5·6이 소비, `addConnection(...,token?)`(Task3)을 Task5가 소비 — 시그니처 일치 확인.
- **YAGNI**: 사용자별 계정·릴레이·TLS·토큰 회전 CLI는 스펙 §8대로 제외. authErr 후 UX는 errText 표시까지만.
