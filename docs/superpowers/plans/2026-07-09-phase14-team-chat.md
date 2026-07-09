# Phase 14 — 사람 팀채팅 (Team Chat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 한 서버(두뇌) 위에 사람 여러 명이 모이는 공용 단톡방을 연다 — 각자 자가선언 닉네임, `@Engram`에만 그 서버 Engram이 답한다.

**Architecture:** 서버는 team 채널(`mode:'team'`, `respondMode:'mention'`)·브로드캐스트가 이미 구현돼 있어 변경은 사칭 방지 가드 한 곳뿐. 렌더러는 team 탭을 열고(봉인 해제), 닉네임을 로컬 저장해 전송에 실으며, team 영역을 **기본 연결(그 서버) 하나로 스코프**(다중연결 머지·`@`라우팅 안 씀)하고, 메시지에 작성자 이름을 표시한다. 두뇌 코어·오케스트레이터·ws 프레임 계약 무변경.

**Tech Stack:** NestJS + TypeScript + `ws`(백엔드, Jest) / React 19 + Vite + TypeScript(렌더러, Vitest + Testing Library).

## Global Constraints

- **하위호환 절대**: Ask/Code(mode≠'team') 동작·렌더 100% 무변경. 기존 테스트 무변경 통과.
- **team = 기본 연결(그 서버) 하나로 스코프**: team 채널 목록·메시지·전송은 `defaultConnId`에서만. 다중연결 머지(`logicalChannels`/`mergeThreads`)·`@`라우팅(`routeTarget`)을 team엔 쓰지 않는다.
- **신원 = 자가선언 라벨**: 닉네임은 검증 안 함(계정=Phase 16). 서버는 클라 `authorId`가 `engram`이면 `owner`로 강등(사칭 방지).
- **UI 문구 영어 기본 / ko 로케일 한국어**(`i18n.ts`의 `ko` 삼항).
- **두뇌 코어·오케스트레이터·위키·`ChatStore`·ws 프레임 계약 무변경.**
- 백엔드 테스트: `npx jest <path>` · 백엔드 빌드: `npm run build`
- 렌더러 테스트: `cd renderer ; npx vitest run <path>` · 렌더러 빌드: `npm run renderer:build`

## File Structure

| 파일 | 책임 | 변경 |
|------|------|------|
| `src/edge/messenger/self.adapter.ts` | ws 서버·전송 | `onSend` authorId `engram` 강등 가드 |
| `renderer/src/display-name.ts` | 닉네임 저장 | (신규) load/save |
| `renderer/src/multi.ts` | 순수 라우팅/머지 | (신규) `scopedConnections`·`scopedChannels` |
| `renderer/src/components/Message.tsx` | 메시지 1개 | `myName` prop → 작성자 이름/‘me’/Engram |
| `renderer/src/components/Thread.tsx` | 스레드 | `myName` 통과 |
| `renderer/src/theme.css` | 스타일 | `.msg.other`(남의 메시지) |
| `renderer/src/i18n.ts` | 문구 | `displayNamePh` |
| `renderer/src/config.ts` | 부트 설정 | `TEAM_CHAT = true` |
| `renderer/src/App.tsx` | 배선 | team 스코프·닉네임 입력·전송 authorId·`myName` 전달 |
| `README.md` | 문서 | team 사용법 |

---

## Task 1: 서버 — authorId `engram` 사칭 방지

**Files:**
- Modify: `src/edge/messenger/self.adapter.ts`
- Test: `src/edge/messenger/self.adapter.spec.ts`

**Interfaces:**
- Produces: `onSend`이 클라 `authorId`를 그대로 저장하되, `engram`(대소문자 무시)이면 `owner`로 강등. 미지정→`owner`(기존).

- [ ] **Step 1: 실패 테스트 작성**

`self.adapter.spec.ts`의 기존 `describe('SelfMessenger 코어', ...)` 블록(무토큰, `client`가 이미 연결·`general` 채널 존재)에 추가:

```ts
it('클라가 authorId를 보내면 그 이름으로 저장한다(자가선언)', async () => {
  client.send(JSON.stringify({ t: 'send', channelId: 'general', text: 'hi', authorId: 'alice' }));
  const f = await nextFrame(client);
  expect(f.message.authorId).toBe('alice');
});

it('클라가 authorId=engram으로 사칭하면 owner로 강등한다', async () => {
  client.send(JSON.stringify({ t: 'send', channelId: 'general', text: 'hi', authorId: 'Engram' }));
  const f = await nextFrame(client);
  expect(f.message.authorId).toBe('owner');
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: FAIL — 사칭 테스트에서 authorId가 'Engram'으로 그대로 저장됨(강등 없음).

- [ ] **Step 3: 구현**

`self.adapter.ts` `onSend`의 `appendMessage` 호출부에서 authorId 계산을 분리·가드:

```ts
    if (!ch) { this.sendTo(ws, { t: 'error', text: 'unknown channel' }); return; }
    // 자가선언 이름 수용. 단 'engram'은 예약(사람이 Engram 사칭 방지) → owner로 강등.
    let author = typeof f.authorId === 'string' && f.authorId ? f.authorId : 'owner';
    if (author.toLowerCase() === 'engram') author = 'owner';
    const msg = this.store.appendMessage(channelId, {
      authorId: author,
      text,
      threadId: typeof f.threadId === 'string' && f.threadId ? f.threadId : undefined,
    });
```

(Engram 자신의 메시지는 `reply`/`postToChannel`이 서버에서 `authorId:'engram'`을 직접 박으므로 이 가드의 영향을 받지 않는다 — 클라 경로만 막는다.)

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: PASS (신규 2건 + 기존 전부, 인증 블록 포함).

- [ ] **Step 5: 커밋**

```bash
git add src/edge/messenger/self.adapter.ts src/edge/messenger/self.adapter.spec.ts
git commit -m "feat(phase14): onSend authorId 자가선언 수용 + engram 사칭 강등 가드"
```

---

## Task 2: 닉네임 저장 (`display-name.ts`)

**Files:**
- Create: `renderer/src/display-name.ts`
- Test: `renderer/src/display-name.test.ts` (Create)

**Interfaces:**
- Produces: `loadDisplayName(): string`(미설정→`''`), `saveDisplayName(name: string): void`. localStorage `engram.displayName`.

- [ ] **Step 1: 실패 테스트 작성**

`renderer/src/display-name.test.ts` 생성:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { loadDisplayName, saveDisplayName } from './display-name';

describe('display-name', () => {
  beforeEach(() => localStorage.clear());

  it('저장하고 로드에서 복원한다', () => {
    saveDisplayName('alice');
    expect(loadDisplayName()).toBe('alice');
  });

  it('미설정이면 빈 문자열', () => {
    expect(loadDisplayName()).toBe('');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd renderer && npx vitest run src/display-name.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`renderer/src/display-name.ts`:

```ts
// 팀채팅 표시용 자가선언 닉네임(전역 1개). 검증 안 함 — 계정은 Phase 16.
const KEY = 'engram.displayName';

export function loadDisplayName(): string {
  try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; }
}

export function saveDisplayName(name: string): void {
  try { localStorage.setItem(KEY, name); } catch { /* 무시 */ }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd renderer && npx vitest run src/display-name.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add renderer/src/display-name.ts renderer/src/display-name.test.ts
git commit -m "feat(phase14): display-name 닉네임 로드/저장(localStorage)"
```

---

## Task 3: 메시지 작성자 이름 렌더 (`Message`/`Thread`)

**Files:**
- Modify: `renderer/src/components/Message.tsx`
- Modify: `renderer/src/components/Thread.tsx`
- Modify: `renderer/src/theme.css`
- Test: `renderer/src/components/Message.test.tsx` (Create)

**Interfaces:**
- Consumes: `Message`/`Thread`에 `myName?: string`.
- Produces: `myName` 지정 시 `authorId===myName`만 ‘나/me’, `authorId==='engram'`은 Engram, 그 외는 그 이름(+`.other` 스타일). `myName` 미지정(Ask/Code)이면 비-engram은 전부 ‘me’(기존 동작).

- [ ] **Step 1: 실패 테스트 작성**

`renderer/src/components/Message.test.tsx` 생성:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Message } from './Message';

const msg = (authorId: string, id = '1') => ({ id, authorId, text: 'hi', ts: new Date(0).toISOString() });

describe('Message 작성자 렌더', () => {
  it('team(myName): 내 이름은 me, 남은 이름 + other 스타일', () => {
    const mine = render(<Message m={msg('alice')} myName="alice" />);
    expect(mine.container.querySelector('.msg')?.className).toContain('me');
    expect(mine.container.querySelector('.who')?.textContent).toMatch(/^(나|me) · /);

    const other = render(<Message m={msg('bob', '2')} myName="alice" />);
    expect(other.container.querySelector('.msg')?.className).toContain('other');
    expect(other.container.querySelector('.who')?.textContent).toMatch(/^bob · /);
  });

  it('engram은 항상 Engram', () => {
    const r = render(<Message m={msg('engram', '3')} myName="alice" />);
    expect(r.container.querySelector('.who')?.textContent).toMatch(/^Engram · /);
    expect(r.container.querySelector('.msg')?.className).not.toContain('me');
    expect(r.container.querySelector('.msg')?.className).not.toContain('other');
  });

  it('myName 미지정(Ask/Code): 비-engram은 me(기존 동작)', () => {
    const r = render(<Message m={msg('owner', '4')} />);
    expect(r.container.querySelector('.msg')?.className).toContain('me');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd renderer && npx vitest run src/components/Message.test.tsx`
Expected: FAIL — `myName` 미지원, other 스타일·이름 라벨 없음.

- [ ] **Step 3: `Message.tsx` 구현**

```tsx
import { useEffect, useRef } from 'react';
import type { Message as Msg } from '../../../shared/protocol';
import { renderMarkdown } from '../render/markdown';
import { ko } from '../config';
import { ActionButtons } from './ActionButtons';

// 메시지 1개. 본문은 검증된 DOM 빌더를 ref로 마운트(XSS 안전).
// myName 지정(team) 시 authorId===myName만 '나', 그 외 사람은 이름 표시(.other).
// myName 미지정(Ask/Code)이면 비-engram은 전부 '나'(기존 동작 유지).
export function Message({ m, onSend, myName }: { m: Msg; onSend?: (text: string) => void; myName?: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const isEngram = m.authorId === 'engram';
  const isMe = !isEngram && (myName === undefined || m.authorId === myName);
  const who = isEngram ? 'Engram' : isMe ? (ko ? '나' : 'me') : m.authorId;
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.replaceChildren(renderMarkdown(m.text));
  }, [m.text]);
  return (
    <div className={'msg' + (isEngram ? '' : isMe ? ' me' : ' other')}>
      <div className="who">{who + ' · ' + new Date(m.ts).toLocaleTimeString()}</div>
      <div className="body" ref={bodyRef} />
      {m.actions && m.actions.length > 0 && onSend && <ActionButtons actions={m.actions} onSend={onSend} />}
    </div>
  );
}
```

- [ ] **Step 4: `Thread.tsx` — `myName` 통과**

props 타입에 `myName?: string` 추가하고 모든 `<Message ... />`에 `myName={props.myName}` 전달:

```tsx
export function Thread(props: {
  anchor: Msg; replies: Msg[]; draft: string; collapsed: boolean;
  onDraft: (v: string) => void; onReply: (text: string) => void;
  onToggle: (collapsed: boolean) => void; onSend?: (text: string) => void;
  myName?: string;
}) {
  const { anchor, replies } = props;
  if (replies.length === 0) return <Message m={anchor} onSend={props.onSend} myName={props.myName} />;
  if (replies.length === 1) {
    return (<>
      <Message m={anchor} onSend={props.onSend} myName={props.myName} />
      <div className="msg reply"><Message m={replies[0]} onSend={props.onSend} myName={props.myName} /></div>
    </>);
  }
  return (<>
    <Message m={anchor} onSend={props.onSend} myName={props.myName} />
    <details className="thread" open={!props.collapsed} onToggle={(e) => props.onToggle(!(e.target as HTMLDetailsElement).open)}>
      <summary>{'🧵 ' + T.replies(replies.length)}</summary>
      {replies.map((r) => <Message key={r.id} m={r} onSend={props.onSend} myName={props.myName} />)}
      <div className="treply">
        <input type="text" placeholder={T.replyPh} value={props.draft}
          onChange={(e) => props.onDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && props.draft.trim()) { props.onReply(props.draft); props.onDraft(''); } }} />
      </div>
    </details>
  </>);
}
```

- [ ] **Step 5: `theme.css` — `.msg.other` 스타일**

기존 `.msg`/`.msg.me` 규칙 근처에 남의 메시지 스타일을 추가한다. `.msg.me`가 오른쪽 정렬/강조라면 `.other`는 왼쪽 정렬·중립 배경으로 구분한다(기존 `.msg` 기본형과 조화). 예:

```css
/* 팀채팅: 남의 메시지(내 것 .me와 구분). 왼쪽 정렬·중립 톤. */
.msg.other { /* 기존 .msg 기본형을 따르되 살짝 다른 배경/보더로 구분 */ }
.msg.other .who { opacity: .8; }
```

(정확한 색/정렬 값은 `theme.css`의 기존 `.msg`·`.msg.me` 규칙을 읽고 그 팔레트에 맞춘다. CSS는 단위테스트 없음 — 수동 스모크로 확인.)

- [ ] **Step 6: 테스트 통과 확인**

Run: `cd renderer && npx vitest run src/components/Message.test.tsx`
Expected: PASS (신규 4건).

- [ ] **Step 7: 커밋**

```bash
git add renderer/src/components/Message.tsx renderer/src/components/Thread.tsx renderer/src/theme.css renderer/src/components/Message.test.tsx
git commit -m "feat(phase14): 메시지 작성자 이름 렌더(myName)·남 메시지 .other 스타일"
```

---

## Task 4: team 단일연결 스코프 순수 헬퍼 (`multi.ts`)

**Files:**
- Modify: `renderer/src/multi.ts`
- Test: `renderer/src/multi.test.ts`

**Interfaces:**
- Produces:
  - `scopedConnections<C extends {id:string}>(connections: C[], mode, defaultConnId): C[]` — team이면 `defaultConnId` 하나만, 아니면 전부.
  - `scopedChannels(channelsByConn: Record<string, Channel[]>, mode, defaultConnId): Record<string, Channel[]>` — team이면 `{[defaultConnId]: 그 연결 채널 ?? []}`, 아니면 원본 그대로.
  - `mode` 타입은 기존 `'chat' | 'code' | 'team'`.

- [ ] **Step 1: 실패 테스트 작성**

`renderer/src/multi.test.ts`에 추가(파일 상단 import에 두 헬퍼 추가):

```ts
import { scopedConnections, scopedChannels } from './multi';

describe('team 단일연결 스코프', () => {
  it('scopedConnections: team은 기본 연결만, 그 외 모드는 전부', () => {
    const conns = [{ id: 'a', name: 'A', endpoint: 'ws://a' }, { id: 'b', name: 'B', endpoint: 'ws://b' }];
    expect(scopedConnections(conns, 'team', 'a')).toEqual([{ id: 'a', name: 'A', endpoint: 'ws://a' }]);
    expect(scopedConnections(conns, 'chat', 'a')).toBe(conns);
    expect(scopedConnections(conns, 'code', 'a')).toBe(conns);
  });

  it('scopedChannels: team은 기본 연결 채널만(동명 team 채널 오합침 방지)', () => {
    const cbc = {
      a: [{ id: '1', name: 'general', respondMode: 'mention' as const, mode: 'team' as const }],
      b: [{ id: '2', name: 'general', respondMode: 'mention' as const, mode: 'team' as const }],
    };
    expect(Object.keys(scopedChannels(cbc, 'team', 'a'))).toEqual(['a']);
    expect(scopedChannels(cbc, 'chat', 'a')).toBe(cbc);
  });

  it('scopedChannels: team에 기본 연결 항목이 없으면 빈 배열', () => {
    expect(scopedChannels({}, 'team', 'a')).toEqual({ a: [] });
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd renderer && npx vitest run src/multi.test.ts`
Expected: FAIL — 두 헬퍼 없음.

- [ ] **Step 3: 구현**

`renderer/src/multi.ts` 하단에 추가:

```ts
// team 모드는 기본 연결(그 서버) 하나로 스코프 — 다중연결 머지/라우팅 대상에서 제외.
// (Ask/Code는 원본 그대로 반환 → 기존 다중연결 경로 무변경.)
export function scopedConnections<C extends { id: string }>(
  connections: C[], mode: 'chat' | 'code' | 'team', defaultConnId: string,
): C[] {
  return mode === 'team' ? connections.filter((c) => c.id === defaultConnId) : connections;
}

export function scopedChannels(
  channelsByConn: Record<string, Channel[]>, mode: 'chat' | 'code' | 'team', defaultConnId: string,
): Record<string, Channel[]> {
  return mode === 'team' ? { [defaultConnId]: channelsByConn[defaultConnId] ?? [] } : channelsByConn;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd renderer && npx vitest run src/multi.test.ts`
Expected: PASS (신규 3건 + 기존 전부).

- [ ] **Step 5: 커밋**

```bash
git add renderer/src/multi.ts renderer/src/multi.test.ts
git commit -m "feat(phase14): team 단일연결 스코프 순수 헬퍼(scopedConnections/scopedChannels)"
```

---

## Task 5: App 배선 — team 탭·스코프·닉네임·전송

**Files:**
- Modify: `renderer/src/config.ts`
- Modify: `renderer/src/i18n.ts`
- Modify: `renderer/src/App.tsx`

**Interfaces:**
- Consumes: `scopedConnections`/`scopedChannels`(Task 4), `loadDisplayName`/`saveDisplayName`(Task 2), `Thread.myName`(Task 3), `authorId` send 프레임 필드(기존 protocol).
- Produces: team 탭 노출, team 화면이 `defaultConnId` 하나로 스코프, team 전송에 닉네임 실림·미설정 시 차단, `@Engram`은 라우팅 안 되고 멘션으로 전달.

- [ ] **Step 1: team 탭 열기 + i18n**

`renderer/src/config.ts`:
```ts
export const TEAM_CHAT = true; // Phase 14: 팀채팅 개방(11b 봉인 해제).
```

`renderer/src/i18n.ts` — `T`에 추가:
```ts
  displayNamePh: ko ? '닉네임 (팀채팅 표시용)' : 'Your name (for team chat)',
```

- [ ] **Step 2: 닉네임 상태 + 스코프 뷰 도입**

`App.tsx` 상단 import 추가:
```ts
import { scopedConnections, scopedChannels } from './multi';
import { loadDisplayName, saveDisplayName } from './display-name';
```
(`routeTarget`·`logicalChannels`·`mergeThreads`는 기존 import 유지.)

상태 추가(다른 `useState`들 근처):
```ts
const [displayName, setDisplayName] = useState(loadDisplayName());
```

스코프 뷰 도입(`useConnections` 호출 이후, `mergedMsgs`/`sidebarChannels` 파생 이전 — `useMemo`로 안정 참조):
```ts
// team은 기본 연결(그 서버) 하나로 스코프. Ask/Code는 원본 그대로(무변경).
const viewConns = useMemo(
  () => scopedConnections(connState.connections, mode, connState.defaultConnId),
  [connState.connections, mode, connState.defaultConnId],
);
const viewChannelsByConn = useMemo(
  () => scopedChannels(channelsByConn, mode, connState.defaultConnId),
  [channelsByConn, mode, connState.defaultConnId],
);
```

- [ ] **Step 3: 파생부를 스코프 뷰로 전환**

App의 아래 파생 지점에서 `connState.connections` → `viewConns`, `channelsByConn` → `viewChannelsByConn`로 바꾼다(team만 달라지고 Ask/Code는 동일):

1. 채널 선택 효과(currentName 보정):
```ts
useEffect(() => {
  const names = logicalChannels(viewChannelsByConn, mode);
  setCurrentName((cur) => (cur && names.includes(cur) ? cur : (names[0] ?? null)));
}, [viewChannelsByConn, mode]);
```

2. history 요청 효과: 루프를 `viewConns`로.
```ts
useEffect(() => {
  if (!currentName) return;
  for (const c of viewConns) {
    const chanId = chanIdByConnName.get(chanKey(c.id, mode, currentName));
    if (chanId && !msgsByConnCh.has(`${c.id}::${chanId}`)) {
      send(c.id, { t: 'history', channelId: chanId });
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [currentName, mode, viewChannelsByConn]);
```

3. `mergedMsgs`: `connState.connections` → `viewConns`(그리고 dep 교체).

4. `anchorConn`: `connState.connections` → `viewConns`(그리고 dep 교체).

5. `sidebarChannels`: `logicalChannels(channelsByConn, mode)` → `logicalChannels(viewChannelsByConn, mode)`; 그 안 `channelsByConn[connState.defaultConnId]`·`Object.values(channelsByConn)` 조회도 `viewChannelsByConn` 기준으로.

(단순 치환이라 Ask/Code에선 `viewConns===connState.connections`·`viewChannelsByConn===channelsByConn`라 동작 동일.)

- [ ] **Step 4: 전송 라우팅 — team은 defaultConnId·authorId**

`sendText`의 `targetConnId` 계산과 send 프레임을 team 대응으로:
```ts
const sendText = (text: string, threadId?: string) => {
  if (!text.trim() || !currentName) return;
  if (mode === 'team' && !displayName.trim()) return; // 닉네임 없으면 team 전송 차단
  const targetConnId = threadId
    ? (anchorConn.get(threadId) ?? connState.defaultConnId)
    : mode === 'team'
      ? connState.defaultConnId               // team: @라우팅 안 씀 → @Engram은 멘션으로 전달
      : routeTarget(text, connState.defaultConnId, connState.connections);
  if (!statusById[targetConnId]) {
    const targetName = connState.connections.find((c) => c.id === targetConnId)?.name ?? targetConnId;
    setErrText((prev) => ({ ...prev, [targetConnId]: T.notConnected(targetName) }));
    return;
  }
  const authorId = mode === 'team' && displayName.trim() ? displayName.trim() : undefined;
  const channelId = chanIdByConnName.get(chanKey(targetConnId, mode, currentName));
  if (channelId) {
    send(targetConnId, { t: 'send', channelId, text, threadId, ...(authorId ? { authorId } : {}) });
  } else if (!threadId) {
    pendingSendRef.current.set(targetConnId, { name: currentName, mode, text, authorId });
    send(targetConnId, { t: 'createChannel', name: currentName, mode });
  }
  expectReply(currentName, text, targetConnId);
};
```

`pendingSendRef` 타입에 `authorId?` 추가:
```ts
const pendingSendRef = useRef<Map<string, { name: string; mode: string; text: string; authorId?: string }>>(new Map());
```

`onFrame`의 pending flush(현재 `send(connId, { t: 'send', channelId: chan.id, text: pending.text })`)에 authorId 통과:
```ts
send(connId, { t: 'send', channelId: chan.id, text: pending.text, ...(pending.authorId ? { authorId: pending.authorId } : {}) });
```

- [ ] **Step 5: 닉네임 입력 UI + `myName` 전달**

team 모드일 때 메시지 영역 위(`<div id="msgs">` 직전)에 닉네임 입력 한 줄 추가:
```tsx
{mode === 'team' && (
  <div id="teamName">
    <input type="text" placeholder={T.displayNamePh} value={displayName}
      onChange={(e) => { setDisplayName(e.target.value); saveDisplayName(e.target.value); }} />
  </div>
)}
```

`Thread`에 `myName` 전달(team일 때만 이름으로 me/남 구분; Ask/Code는 undefined=기존 동작):
```tsx
<Thread key={m.id} anchor={m} replies={byAnchor.get(m.id) ?? []}
  draft={drafts.get(m.id) ?? ''}
  collapsed={collapsed.has(m.id)}
  myName={mode === 'team' ? displayName : undefined}
  onToggle={...} onDraft={...} onReply={...} onSend={(text) => sendText(text)} />
```

- [ ] **Step 6: 빌드 + 전체 렌더러 스위트**

Run: `cd renderer && npx vitest run`
Expected: PASS (전체 — 기존 + 신규, Ask/Code 회귀 0).
Run: `npm run renderer:build`
Expected: `tsc -b` exit 0 + vite build 성공(타입 정합: authorId·myName·스코프 헬퍼).

- [ ] **Step 7: 커밋**

```bash
git add renderer/src/config.ts renderer/src/i18n.ts renderer/src/App.tsx
git commit -m "feat(phase14): team 탭 개방·단일연결 스코프·닉네임 입력·전송 authorId 배선"
```

---

## Task 6: 문서(README)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: team 사용법 추가**

`README.md`의 "채팅 UI (Phase 9)" 절(또는 Phase 13 원격 안내 근처)에 team 안내를 추가:

```markdown
### 팀채팅 (Phase 14)

`Team` 탭 = **그 서버 Engram의 공용 단톡방**. 여러 사람이 같은 방에 모여 대화하고,
`@Engram`에만 그 서버의 Engram이 답한다(사람끼리는 그냥 대화).

- **참여**: 팀원은 Phase 13 토큰으로 그 서버에 접속해 같은 방을 공유한다.
- **닉네임**: 각자 Team 화면 상단에 표시용 이름을 정한다(계정·로그인 아님 — 검증 안 함).
  `engram`이라는 이름은 예약이라 쓸 수 없다(Engram 사칭 방지).
- **방 = 서버 하나**: 내 앱이 여러 Engram에 붙어 있어도 Team 화면은 지금 고른 하나의
  서버 방만 본다(EngramSelector로 전환). 다른 서버 방과 섞이지 않는다.

⚠️ 검증된 다중 사용자 계정·권한은 이후 단계(Phase 16).
```

- [ ] **Step 2: 커밋**

```bash
git add README.md
git commit -m "docs(phase14): 팀채팅 사용법 — 그 서버 Engram의 공용 단톡방·닉네임"
```

---

## 완료 검증(전 태스크 후)

- [ ] 백엔드 전체: `npm test` → 녹색
- [ ] 렌더러 전체: `cd renderer && npx vitest run` → 녹색
- [ ] 빌드: `npm run build` && `npm run renderer:build` → exit 0
- [ ] 수동 스모크(선택): `TEAM_CHAT` 켜진 채 `npm run desktop:dev` → Team 탭에서 채널 생성·닉네임 설정·메시지(작성자 이름 표시)·`@Engram` 응답 확인. 두 번째 클라(다른 닉네임)로 같은 서버 붙어 서로 메시지 보이는지(브로드캐스트) 확인.

---

## Self-Review 결과

- **스펙 커버리지**: §3.1 engram 강등=Task1 / §3.2 non-mention 무개입=기존(변경 없음, Task5 회귀 확인) / §4.1 team 탭=Task5 / §4.2 닉네임=Task2+Task5 UI / §4.3 단일연결 스코프=Task4 헬퍼+Task5 배선 / §4.4 작성자 렌더=Task3 / §5 README=Task6 / §6 테스트=각 태스크 TDD. 갭 없음.
- **타입 정합**: `scopedConnections`/`scopedChannels`(Task4)를 Task5가 소비 · `myName`(Task3 Message/Thread)을 Task5가 전달 · `loadDisplayName`/`saveDisplayName`(Task2)을 Task5가 소비 · `authorId` send 필드(기존 protocol)를 Task5·Task1이 각각 클라/서버에서 사용. 시그니처 일치.
- **하위호환**: Ask/Code는 `mode!=='team'`라 `viewConns===connections`·`viewChannelsByConn===channelsByConn`·`myName===undefined`·authorId 미첨부 → 기존 경로 무변경. Task5 Step6 전체 스위트로 회귀 확인.
- **YAGNI**: 프레즌스·타이핑·읽음·계정은 스펙 §8대로 제외.
