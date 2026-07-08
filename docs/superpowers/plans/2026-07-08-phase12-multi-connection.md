# Phase 12 — 다중 연결 (Multi-Connection) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Engram Desktop 클라이언트가 N개 Engram(두뇌)에 동시 연결하고, 연결마다 이름을 주고, `@이름`으로 특정 Engram에 라우팅하며, 공유 채널을 스레드 단위로 합쳐 보여준다.

**Architecture:** 렌더러(React) 안에서 끝난다 — 두뇌 코어·ws 프레임(`shared/protocol.ts`) 무변경. 연결마다 소켓 하나(연결 관리자 훅), 연결 목록·기본값은 localStorage. 채널은 이름으로 식별되는 논리 채널이고, 통합 기록은 연결별 history를 스레드(anchor ts)순으로 머지한다. 라우팅: `@이름` 있으면 그 Engram, 없으면 기본 Engram.

**Tech Stack:** React 19 + Vite + TypeScript, Vitest + Testing Library (렌더러). 서버 변경 없음.

## Global Constraints

- **ws 프레임 계약(`shared/protocol.ts`)·두뇌 코어 무변경.** 연결 id는 와이어에 안 싣는다 — 클라가 수신 소켓으로 로컬 태깅.
- **저장 대상은 `{ connections: Connection[], defaultConnId: string }` 뿐**(localStorage). 채널 id 매핑·머지는 런타임 상태.
- **채널 = 이름으로 식별**(논리 키). `// ponytail: 이름 키 — 우연 동명이 합쳐지는 천장, 필요 시 클라 소유 id 매핑으로 승격.`
- **저장 범위 = 자기 것만(②)**: 메시지는 지목/기본 Engram에만 보내 저장. 통합 뷰는 클라가 머지.
- **스레드 안 답글 → 그 스레드를 연 Engram(anchor의 connId)로.** 교차 @는 이번 미지원.
- **채널 생성=기본 Engram에만**, 다른 Engram엔 그 채널로 첫 전송 시 지연 생성. **삭제=그 이름 채널을 가진 모든 연결에 팬아웃.**
- **안전 경계**: 인증 없음(Phase 13). 로컬/신뢰 LAN 전제. 자동 탐색 안 함(사용자가 endpoint 직접 입력).
- **UI 문구 영어 기본 / ko 로케일 한국어**(`config.ts`의 `ko`). 타이틀 = `Engram Desktop`.
- 첫 실행(연결 목록 없음) = `{ name:'Local', endpoint: ws://127.0.0.1:<현재 ?port 또는 47800> }` 하나 시드 + 기본 지정 → Phase 11 동작과 회귀 0.
- 렌더러 테스트: `npm --prefix renderer test`. `renderer/`는 자체 tsconfig/vitest.

---

## Task 1: 연결 모델 + localStorage 저장 (`connections.ts`)

**Files:**
- Create: `renderer/src/connections.ts`
- Test: `renderer/src/connections.test.ts`

**Interfaces (Produces):**
- `interface Connection { id: string; name: string; endpoint: string }`
- `loadConnections(): { connections: Connection[]; defaultConnId: string }` — 없으면 Local 시드(id 고정 `'local'`) + default=`'local'`.
- `saveConnections(state: { connections: Connection[]; defaultConnId: string }): void`
- `defaultEndpoint(): string` — `ws://127.0.0.1:${?port||47800}` (config.ts WS_URL 재사용).
- `addConnection(state, name, endpoint): { connections; defaultConnId }` (순수, id 생성=`c${connections.length}-${name}` 충돌 피하려 endpoint 기반 아님 — 간단히 랜덤 대체 없이 `crypto.randomUUID?.() ?? name+len`).

- [ ] **Step 1: 실패 테스트** — `renderer/src/connections.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { loadConnections, saveConnections, addConnection } from './connections';

beforeEach(() => localStorage.clear());

describe('connections store', () => {
  it('seeds a Local default when empty', () => {
    const s = loadConnections();
    expect(s.connections).toHaveLength(1);
    expect(s.connections[0].id).toBe('local');
    expect(s.defaultConnId).toBe('local');
    expect(s.connections[0].endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:/);
  });
  it('persists and reloads', () => {
    const s = addConnection(loadConnections(), 'Work', 'ws://192.168.0.9:47800');
    saveConnections(s);
    const r = loadConnections();
    expect(r.connections.map((c) => c.name)).toEqual(['Local', 'Work']);
  });
  it('addConnection is pure (does not mutate input)', () => {
    const a = loadConnections();
    const b = addConnection(a, 'Work', 'ws://x:1');
    expect(a.connections).toHaveLength(1);
    expect(b.connections).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 실패 확인** — `npm --prefix renderer test` → FAIL (module 없음)

- [ ] **Step 3: 구현** — `renderer/src/connections.ts`

```ts
import { WS_URL } from './config';

export interface Connection { id: string; name: string; endpoint: string }
interface State { connections: Connection[]; defaultConnId: string }

const KEY = 'engram.connections';

export function defaultEndpoint(): string { return WS_URL; }

function seed(): State {
  return { connections: [{ id: 'local', name: 'Local', endpoint: defaultEndpoint() }], defaultConnId: 'local' };
}

export function loadConnections(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return seed();
    const s = JSON.parse(raw) as State;
    if (!s.connections?.length) return seed();
    // 기본이 사라졌으면 첫 연결로 보정
    if (!s.connections.some((c) => c.id === s.defaultConnId)) s.defaultConnId = s.connections[0].id;
    return s;
  } catch { return seed(); }
}

export function saveConnections(state: State): void {
  localStorage.setItem(KEY, JSON.stringify(state));
}

function newId(state: State, name: string): string {
  const g = (globalThis.crypto as any)?.randomUUID?.();
  return g ?? `${name}-${state.connections.length}-${state.connections.length}`;
}

export function addConnection(state: State, name: string, endpoint: string): State {
  const conn: Connection = { id: newId(state, name), name, endpoint };
  return { connections: [...state.connections, conn], defaultConnId: state.defaultConnId };
}

export function removeConnection(state: State, id: string): State {
  const connections = state.connections.filter((c) => c.id !== id);
  const defaultConnId = state.defaultConnId === id ? (connections[0]?.id ?? '') : state.defaultConnId;
  return { connections, defaultConnId };
}

export function setDefault(state: State, id: string): State {
  return state.connections.some((c) => c.id === id) ? { ...state, defaultConnId: id } : state;
}
```

- [ ] **Step 4: 통과 확인** — `npm --prefix renderer test` → PASS
- [ ] **Step 5: 커밋**
```
git add renderer/src/connections.ts renderer/src/connections.test.ts
git commit -m "feat(phase12): 연결 모델 + localStorage 저장(Local 시드)"
```

---

## Task 2: 다중 연결 관리자 훅 (`useConnections`)

**Files:**
- Create: `renderer/src/ws/connections-client.ts`
- Test: `renderer/src/ws/connections-client.test.ts`
- (기존 `renderer/src/ws/client.ts`의 `useWs`는 단일 연결 — 이 훅이 연결당 그 로직을 재사용/대체. Task 5에서 App이 이 훅으로 전환.)

**Interfaces:**
- Consumes: `Connection` (Task 1), `ClientFrame`/`ServerFrame` (`shared/protocol`).
- Produces:
  - `useConnections(connections: Connection[], onFrame: (connId: string, f: ServerFrame) => void, onOpen?: (connId: string) => void): { send: (connId: string, f: ClientFrame) => void; statusById: Record<string, boolean> }`
  - 연결마다 WebSocket + 백오프(1s→5s→30s) 재연결. 프레임 수신 시 `onFrame(connId, f)`. 열릴 때 `onOpen(connId)`.
  - `connections` 배열이 바뀌면(추가/삭제) 소켓을 그에 맞춰 열고/닫는다.

- [ ] **Step 1: 실패 테스트** — 모의 WebSocket으로 2개 연결·프레임 태깅·재연결

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useConnections } from './connections-client';

class FakeWS {
  static instances: FakeWS[] = [];
  url: string; readyState = 0; onopen: any; onclose: any; onerror: any; onmessage: any;
  sent: string[] = [];
  constructor(url: string) { this.url = url; FakeWS.instances.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  msg(obj: any) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

beforeEach(() => { FakeWS.instances = []; vi.stubGlobal('WebSocket', FakeWS as any); (FakeWS as any).OPEN = 1; });

it('opens one socket per connection and tags frames by connId', () => {
  const frames: Array<[string, any]> = [];
  const conns = [{ id: 'a', name: 'A', endpoint: 'ws://a' }, { id: 'b', name: 'B', endpoint: 'ws://b' }];
  renderHook(() => useConnections(conns, (id, f) => frames.push([id, f])));
  expect(FakeWS.instances).toHaveLength(2);
  act(() => { FakeWS.instances[0].open(); FakeWS.instances[0].msg({ t: 'error', text: 'x' }); });
  expect(frames).toEqual([['a', { t: 'error', text: 'x' }]]);
});
```
(재연결 백오프 테스트는 `vi.useFakeTimers()`로 close→타이머 진행→새 소켓 확인. 기존 `client.ts`의 백오프 상수/패턴 재사용.)

- [ ] **Step 2: 실패 확인** — `npm --prefix renderer test` → FAIL

- [ ] **Step 3: 구현** — `renderer/src/ws/connections-client.ts`. 기존 `client.ts`의 단일 연결 로직(백오프 `[1000,5000,30000]`·손상 프레임 무시·closed 가드)을 연결당 하나씩 관리. `useEffect`가 `connections`(id 목록) 변화에 반응해 없어진 소켓 close, 새 소켓 connect. 각 소켓의 `onmessage`→`onFrame(connId, parsed)`, `onopen`→상태 true+`onOpen(connId)`, `onclose`→상태 false+백오프 재연결. `send(connId, f)`는 해당 소켓이 OPEN이면 전송. `statusById`는 연결별 boolean state.
  - 최신 콜백은 ref로 잡아 stale 클로저 방지(client.ts 패턴).
  - connections 배열 정체성 변화 감지: id들의 join을 deps로.

- [ ] **Step 4: 통과 확인** — `npm --prefix renderer test` → PASS
- [ ] **Step 5: 커밋**
```
git add renderer/src/ws/connections-client.ts renderer/src/ws/connections-client.test.ts
git commit -m "feat(phase12): 다중 연결 관리자 훅(연결당 소켓·프레임 connId 태깅·재연결)"
```

---

## Task 3: 라우팅 + 논리 채널 + 스레드 머지 순수 함수 (`multi.ts`)

**Files:**
- Create: `renderer/src/multi.ts`
- Test: `renderer/src/multi.test.ts`

**Interfaces:**
- Consumes: `Connection`, `Channel`/`Message` (`shared/protocol`).
- Produces:
  - `routeTarget(text: string, defaultConnId: string, connections: Connection[]): string` — 텍스트 앞부분에 `@이름`(대소문자 무시, 연결 이름 매치) 있으면 그 connId, 없으면 defaultConnId.
  - `logicalChannels(channelsByConn: Record<string, Channel[]>, mode: 'chat'|'code'|'team'): string[]` — 그 mode인 채널 이름들의 합집합(정렬·중복 제거).
  - `mergeThreads(msgsByConnForName: Array<{ connId: string; messages: Message[] }>): Message[]` — 각 연결의 그 이름 채널 메시지를 합쳐, anchor(비-threadId) ts 오름차순 정렬 + 답(threadId)은 그 뒤 유지. 각 메시지에 connId 태그가 필요하면 별도 맵으로 반환하지 말고, 호출부가 connId를 알도록 `Message & { _connId?: string }`는 쓰지 말 것 — 대신 순수 병합만; connId 소유는 App이 별도 맵으로 관리(아래 Task 5).

- [ ] **Step 1: 실패 테스트**

```ts
import { describe, it, expect } from 'vitest';
import { routeTarget, logicalChannels, mergeThreads } from './multi';

const conns = [{ id: 'home', name: '집', endpoint: '' }, { id: 'work', name: '회사', endpoint: '' }];

it('routeTarget: @name → that conn, else default', () => {
  expect(routeTarget('@회사 배포됐어?', 'home', conns)).toBe('work');
  expect(routeTarget('그냥 질문', 'home', conns)).toBe('home');
  expect(routeTarget('@집 안녕', 'work', conns)).toBe('home');
});
it('logicalChannels: union of names by mode', () => {
  const byConn = {
    home: [{ id: 'h1', name: '일반', respondMode: 'all', mode: 'chat' }] as any,
    work: [{ id: 'w1', name: '일반', respondMode: 'all', mode: 'chat' }, { id: 'w2', name: '배포', respondMode: 'all', mode: 'chat' }] as any,
  };
  expect(logicalChannels(byConn, 'chat')).toEqual(['배포', '일반']);
});
it('mergeThreads: anchors sorted by ts, replies kept under anchor', () => {
  const a = { messages: [{ id: 'm1', authorId: 'owner', text: 'q', ts: '2026-01-01T00:00:00Z' }] } as any;
  const b = { messages: [
    { id: 'm2', authorId: 'owner', text: 'q2', ts: '2026-01-01T00:01:00Z' },
    { id: 'm2r', authorId: 'engram', text: 'a2', ts: '2026-01-01T00:01:05Z', threadId: 'm2' },
  ] } as any;
  const merged = mergeThreads([{ connId: 'home', ...a }, { connId: 'work', ...b }]);
  expect(merged.map((m) => m.id)).toEqual(['m1', 'm2', 'm2r']);
});
```

- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현** — `renderer/src/multi.ts`:
  - `routeTarget`: `const m = text.trim().match(/^@(\S+)/); if (m) { const c = connections.find((c) => c.name.toLowerCase() === m[1].toLowerCase()); if (c) return c.id; } return defaultConnId;`
  - `logicalChannels`: 모든 연결의 채널 중 `(c.mode||'chat')===mode`인 것의 `name` 합집합 → `[...new Set(names)].sort()`.
  - `mergeThreads`: 모든 메시지 flat → anchors(비 threadId) ts 오름차순 → 각 anchor 뒤에 그 anchor를 threadId로 갖는 답들(ts순) 붙임. (App이 이 배열을 기존 Thread 렌더로 넘김.)
- [ ] **Step 4: 통과 확인** → PASS
- [ ] **Step 5: 커밋**
```
git add renderer/src/multi.ts renderer/src/multi.test.ts
git commit -m "feat(phase12): 라우팅·논리채널·스레드 머지 순수 함수"
```

---

## Task 4: App 다중 연결 배선 (`App.tsx`)

**Files:**
- Modify: `renderer/src/App.tsx`
- Test: `renderer/src/App.multi.test.tsx` (신규, 통합 렌더 스모크)

**Interfaces:** Consumes Task 1~3. 서버 프레임 계약 무변경.

**새 상태 구조(현 단일 상태 대체):**
- `const [{ connections, defaultConnId }, setConns] = useState(loadConnections())` — 변경 시 saveConnections.
- `channelsByConn: Record<connId, Channel[]>`, `msgsByConnCh: Map<`${connId}::${channelId}`, Message[]>` — 연결·채널별 원시.
- `chanIdByConnName: Map<`${connId}::${name}`, channelId>` — 지연 생성 매핑.
- 현재 논리 채널 = `currentName: string | null`(이름). 현재 mode(area).
- 파생: `logicalChannels(channelsByConn, mode)` → 채널 목록. 통합 기록 = `mergeThreads(연결들 중 currentName 채널 가진 것들의 msgs)`.
- **anchor→connId 맵**: 수신 시 `msgsByConnCh` 키가 connId를 품으므로, 렌더 시 각 anchor의 connId를 함께 들고 있어야 답글 라우팅 가능. `mergeThreads` 입력에 connId가 있으니, 머지 결과와 별도로 `anchorConn: Map<msgId, connId>`를 만들어 답글 전송에 사용.

**핵심 동작:**
- `onFrame(connId, f)`:
  - `channels` → `channelsByConn[connId]=f.list`; 각 채널의 (connId,name)→id 매핑 갱신; currentName 없으면 첫 논리 채널로.
  - `history` → `msgsByConnCh[connId::f.channelId]=f.messages`.
  - `msg` → append; engram 답이면 그 논리 채널 awaiting 해제.
  - `error` → errText.
- `onOpen(connId)`: 그 연결에 `{t:'channels'}` 전송(+ 현재 논리 채널을 그 연결이 가지면 history 요청).
- `send`(라우팅): `sendText(text)` → `targetConnId = routeTarget(text, defaultConnId, connections)` → 그 연결에 currentName 채널 id 있으면 `send(targetConnId,{t:'send',channelId,text})`, 없으면 `send(targetConnId,{t:'createChannel',name:currentName,mode})` 먼저(그 연결 channels 프레임 오면 id 확보 후 큐된 전송) — 간단화: createChannel 후 곧바로 보낼 수 없으니 "대기 전송 1건" 저장했다가 그 연결 channels 갱신 시 flush. `// ponytail: 채널 생성→전송 2스텝, 대기전송 1건 버퍼.`
- 스레드 답글: `onReply(anchorId, text)` → `connId = anchorConn.get(anchorId) ?? defaultConnId` → 그 connId로 `{t:'send', channelId, text, threadId:anchorId}`.
- 채널 생성(UI): 기본 연결에만 `createChannel`. 삭제: 그 이름 채널 가진 모든 연결에 `deleteChannel`.
- 기본 Engram 변경: setDefault + save.

- [ ] **Step 1: 실패 테스트** — `App.multi.test.tsx`: FakeWS(Task 2 패턴)로 2연결 mount → 각 연결 `channels`(같은 이름 '일반') → 논리 채널 1개 표시, 각 history 머지되어 두 메시지 보임. 라우팅: 입력 `@회사 hi` 전송 시 work 소켓으로 send 프레임 나감(sent 검사).
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현** — App.tsx를 위 구조로 재배선. 기존 Thread/Palette/Composer/FolderEmpty 컴포넌트 재사용. `useWs` → `useConnections`. 단일 `current`(id) → `currentName`. 렌더 시 `mergeThreads`로 통합 스레드. Code 영역의 repoPath 헤더/FolderEmpty는 현재 연결 맥락 필요 → **기본 Engram의 그 채널** 기준(간단화, 코드 영역은 기본 Engram로).
- [ ] **Step 4: 통과 확인** — `npm --prefix renderer test` → PASS
- [ ] **Step 5: 커밋**
```
git add renderer/src/App.tsx renderer/src/App.multi.test.tsx
git commit -m "feat(phase12): App 다중 연결 배선(라우팅·논리채널·머지·지연생성)"
```

---

## Task 5: UI — Engram 선택기 + Manage 모달 + @ 자동완성 + 타이틀

**Files:**
- Create: `renderer/src/components/EngramSelector.tsx` (입력창 하단 오른쪽 칩 + 드롭다운)
- Create: `renderer/src/components/ManageEngrams.tsx` (추가/삭제/기본 지정 모달)
- Create: `renderer/src/components/MentionAutocomplete.tsx` (`@` 입력 시 연결 이름 후보)
- Modify: `renderer/src/App.tsx` (선택기·모달·자동완성 배선, 타이틀 `Engram`→`Engram Desktop`)
- Modify: `renderer/src/i18n.ts` (문구: Engrams, Add Engram, Manage Engrams, Default 등 en/ko)
- Test: `renderer/src/components/EngramSelector.test.tsx`, `ManageEngrams.test.tsx`

**요구:**
- 선택기: 입력바 하단 **오른쪽**(보내기 버튼 옆) `[아이콘] <기본 Engram 이름> ▾` + 연결 상태 점. 클릭→드롭다운(연결 목록[상태점·기본엔 ✓], 구분선, "Manage Engrams…"). `/` 팔레트에도 기본 Engram 변경 항목.
- Manage 모달: 목록 행(이름·endpoint mono·[기본/기본으로]·삭제) + 추가 폼(이름+endpoint+Add). 저장=localStorage(App이 setConns→saveConnections).
- @ 자동완성: 입력값 커서 앞 토큰 `@`로 시작 시 연결 이름 후보 팝오버, 선택 시 `@이름 ` 삽입(팔레트 패턴 재사용, 순수 필터 함수 분리해 테스트).
- 타이틀바 `Engram` → `Engram Desktop`.

- [ ] **Step 1: 실패 테스트** — EngramSelector: 연결 2개·기본 표시·드롭다운 항목 렌더·onSetDefault 콜백. ManageEngrams: 추가 폼 제출 시 onAdd(name,endpoint) 콜백·삭제 버튼 onRemove(id). 순수 `@` 필터: `mentionCandidates(text, names)`.
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현** — 세 컴포넌트 + App 배선 + i18n. XSS: 이름/endpoint는 textContent(React 기본 이스케이프). 상태점은 `statusById`.
- [ ] **Step 4: 통과 확인** — `npm --prefix renderer test` → PASS
- [ ] **Step 5: 커밋**
```
git add renderer/src/components/EngramSelector.tsx renderer/src/components/ManageEngrams.tsx renderer/src/components/MentionAutocomplete.tsx renderer/src/App.tsx renderer/src/i18n.ts renderer/src/components/*.test.tsx
git commit -m "feat(phase12): Engram 선택기·Manage 모달·@ 자동완성·타이틀 Engram Desktop"
```

---

## Task 6: 회귀 스윕 + 정리

**Files:** (필요 시) `renderer/src/ws/client.ts` — `useConnections`로 완전 대체됐으면 제거(다른 참조 없을 때). 남는 참조 있으면 유지.

- [ ] **Step 1:** `renderer/src/ws/client.ts`(`useWs`) 참조 grep. App이 useConnections로 전환됐고 다른 참조 없으면 파일·`client.test.ts` 제거; 있으면 유지.
- [ ] **Step 2:** 전체 렌더러 테스트 `npm --prefix renderer test` → 전부 PASS.
- [ ] **Step 3:** `npm --prefix renderer run build`(Vite 빌드) → 성공. 루트 `npx tsc --noEmit`(renderer는 exclude됨 — 영향 없음 확인).
- [ ] **Step 4: 커밋**
```
git add -A
git commit -m "chore(phase12): 단일 useWs 정리 + 회귀 스윕"
```

---

## Self-Review (작성자 체크)

- **스펙 커버리지**: 다중 연결(T1·T2)·라우팅/논리채널/머지(T3)·App 배선(T4)·UI 선택기·Manage·@·타이틀(T5)·정리(T6). 지연 생성·삭제 팬아웃·스레드 답글 소유·기본 시드·안전경계 전부 Global Constraints + 태스크에 명시.
- **Placeholder**: 순수 모듈(T1·T3)은 완전 코드. T2·T4·T5는 구조·핵심 로직·인터페이스·테스트를 명시(대형 통합이라 App 전체 재현 대신 상태 구조+동작 규칙+테스트로 계약 고정 — 리뷰 루프가 갭 포착).
- **타입 일관성**: `Connection`(T1)·`useConnections`(T2)·`routeTarget/logicalChannels/mergeThreads`(T3) 시그니처가 T4 소비와 일치.
- **비범위**: 인증·원격(13)·Team 실동작(14)·공유 wiki(15)·스레드 교차@·실시간 설정. 서버·ws 프레임 무변경.
- **리스크(리뷰 주목)**: T4의 "지연 생성→전송" 2스텝 대기 버퍼, anchor→connId 맵, Code 영역의 기본-Engram 가정.
