# Phase 11a — 클라이언트 앱 토대 + 기능 이전 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 지금의 단일 `src/desktop/chat.html`(vanilla)를 독립 **React+Vite+TS 앱(`renderer/`)** 으로 교체하고, 두뇌는 HTML 서빙을 멈춰 http를 헬스+ws만 하게 바꾼다. 현 기능 회귀 0.

**Architecture:** ws 프레임 타입을 `shared/protocol.ts` 한 곳에 정의(단일 진실원)해 두뇌(`src/edge/messenger`)와 `renderer/`가 **같은 타입**을 참조한다. `SelfMessenger.start()`는 chat.html 읽기를 버리고 GET `/`를 200 헬스로만 응답(ws 업그레이드는 그대로). Electron `main.ts`는 `loadURL(http://…)` 대신 http 헬스 프로브로 준비를 감지한 뒤 `loadFile(renderer/dist/index.html)`로 진입한다. 렌더러는 검증된 chat.html의 XSS-안전 DOM 빌더(마크다운/차트)를 **그대로 옮겨** ref로 마운트하고, 나머지(채널/스레드/팔레트/모드탭/폴더선택)는 React 컴포넌트로 이전한다.

**Tech Stack:** TypeScript, React 19, Vite 6, Vitest + @testing-library/react(렌더러), Electron 43, NestJS + ws + Jest(두뇌).

## Global Constraints

- **회귀 0**: `src/desktop/chat.html`의 §2.5 인벤토리 기능을 빠짐없이 옮긴다(채널 사이드바·생성[인라인]·삭제·⋯메뉴, 자동 스레드[답1=인라인/2+=접힘·기본펼침], 마크다운[헤딩·목록·체크리스트·비교표·인라인강조·외부링크], 인라인 SVG 차트[bar/line/pie], `/`명령 팔레트, 번호목록 클릭채움, "생각 중"[180s 타임아웃], 재연결 백오프[1s→5s→30s]+재동기화, 초안 유지, i18n[en 기본/ko], 커스텀 타이틀바+화이트/하늘 테마[시스템 다크 추종], 연결 점, 모드 탭[Chat/Code]+모드별 채널 필터, Code empty state[폴더 선택]+레포 헤더).
- **두뇌 코어 로직 무변경**: `MessengerPort`/`MentionEvent`/`ChatStore`/`ChatConfig`/`MessengerHub` 계약 그대로. 두뇌 변경은 `SelfMessenger.start()`의 http 핸들러(헬스화)와 그 호출부(main.ts htmlPath 제거)뿐.
- **11a 비범위**: `actions` 필드·`ActionButtons`·3영역(Team/Ask/Code) 재편은 **11b**. 11a는 현행 Chat/Code 모드탭 구조를 그대로 옮긴다.
- **ws 프레임 계약 무변경**: 현행 프레임(`send`/`history`/`channels`/`createChannel`/`deleteChannel`/`setRepoPath`/`setRespondMode` ↔ `channels`/`history`/`msg`/`error`)을 타입으로 명문화만 한다. 신규 프레임 없음.
- **XSS 유지**: 외부 문자열(메시지 본문·채널명·라벨)은 React 기본 이스케이프 또는 `textContent`/DOM 조립으로만. `innerHTML`/`dangerouslySetInnerHTML` 금지.
- **엔드포인트 고정**: 렌더러는 `ws://127.0.0.1:47800`(설정된 값)에 붙는다. 기본 포트 47800(`chat.config`와 동일). Vite/렌더러 config에 상수로.
- **셸은 PowerShell**(이 머신 Bash 훅 깨짐). 두뇌 테스트 `npx jest <경로>`, 렌더러 테스트 `npm --prefix renderer test`.
- UI 문구는 영어 기본 + ko 로케일 한국어(`navigator.language`). 기존 chat.html의 `T` 사전 문구를 그대로 옮긴다.
- `renderer/`는 같은 레포 최상위(모노레포식), 자체 package.json·Vite. `src/`(nest 빌드 대상) 밖이라 빌드 안 섞임.

## File Structure

**신규 (`shared/`)**
- `shared/protocol.ts` — ws 프레임·`Channel`·`Message` 타입. **런타임 값 0(인터페이스만)** → 양쪽 `import type`로 erase. nest는 rootDir=repo root라 `dist/shared/`로 안 나감(type-only 미방출), 렌더러는 상대경로로 참조.

**신규 (`renderer/`)**
- `renderer/package.json`, `renderer/tsconfig.json`, `renderer/tsconfig.node.json`, `renderer/vite.config.ts`, `renderer/index.html`
- `renderer/src/main.tsx` — React 부트
- `renderer/src/config.ts` — 엔드포인트(`ws://127.0.0.1:47800`), i18n `ko` 판정, feature flag 자리(11b용, 지금은 endpoint만)
- `renderer/src/App.tsx` — 셸: 타이틀바+사이드(모드탭/채널/새채널)+메인(헤더/msgs/팔레트/입력바). 전역 상태(channels/current/mode/msgsByCh/drafts/collapsed/awaiting).
- `renderer/src/theme.css` — chat.html `<style>` 그대로 이전(CSS 변수·라이트/다크)
- `renderer/src/i18n.ts` — chat.html `T` 사전 이전
- `renderer/src/ws/client.ts` — `useWs` 훅(연결·백오프·재동기화·프레임 디스패치)
- `renderer/src/render/markdown.ts` — chat.html의 `mdInline`/`mdLink`/`renderChart`/`renderMarkdown` **verbatim 이전**(DOM 빌더)
- `renderer/src/components/Message.tsx` — 메시지 1개: `render/markdown`을 ref로 마운트 + engram 번호목록 클릭채움
- `renderer/src/components/Channels.tsx` — 사이드바(모드탭·목록·⋯메뉴·새채널 인라인)
- `renderer/src/components/Thread.tsx` — 자동 스레드(답1 인라인/2+ 접힘·초안)
- `renderer/src/components/Palette.tsx` — `/`명령 팔레트
- `renderer/src/components/FolderEmpty.tsx` — Code 채널 폴더 선택 empty state
- 테스트: `renderer/src/**/{markdown,client,Message,App}.test.tsx`(Vitest)

**변경 (두뇌)**
- `src/edge/messenger/self.adapter.ts` — http 헬스화, 프레임 타입을 `shared/protocol`로. `htmlPath` opt 제거.
- `src/edge/messenger/self.adapter.spec.ts` — "GET / htmlPath 서빙/404" 테스트를 "GET / 200 헬스" 회귀로 교체.
- `src/main.ts` — `SelfMessenger` 생성에서 `htmlPath`/`resolveResourceFile(chat.html)` 제거.
- `src/desktop/main.ts` — `openChat()` loadURL→loadFile(프로브 유지), will-navigate 가드 file:// 대응.
- `package.json` — build.files에서 `src/desktop/chat.html` 제거, `renderer/dist/**` 추가. 스크립트 `renderer:build`/`renderer:install` + `desktop:*`가 선행.

**삭제**
- `src/desktop/chat.html` (기능 이전 완료 후, 마지막 태스크)

---

### Task 1: `shared/protocol.ts` — 타입 ws 프로토콜(단일 진실원)

**Files:**
- Create: `shared/protocol.ts`
- Modify: `src/edge/messenger/self.adapter.ts`
- Test: 타입 전용 — `npx tsc --noEmit` (별도 spec 없음; jest rootDir=src라 shared/*.spec.ts는 어차피 안 잡힘)

**Interfaces:**
- Consumes: 없음(신규, import 0).
- Produces:
  - `Channel { id; name; respondMode:'all'|'mention'; mode?:'chat'|'code'; repoPath?:string }`
  - `Message { id; authorId; text; ts; threadId? }`
  - `ClientFrame` 유니온(클라→서버): `channels`/`history`/`send`/`createChannel`/`deleteChannel`/`setRepoPath`/`setRespondMode`
  - `ServerFrame` 유니온(서버→클라): `channels`/`history`/`msg`/`error`

- [ ] **Step 1: `shared/protocol.ts` 작성**

```ts
// ws 프레임 계약 — 두뇌(src/edge/messenger)와 renderer/의 단일 진실원.
// 인터페이스만(런타임 값 0) → 양쪽에서 `import type`로 참조, 컴파일 시 erase.
// 현행 프레임을 명문화만 한다(신규 프레임 없음). Phase 11b에서 Message.actions 추가 예정.

export interface Channel {
  id: string;
  name: string;
  respondMode: 'all' | 'mention';
  mode?: 'chat' | 'code'; // 누락/오염=chat
  repoPath?: string;      // Code 채널이 바인딩한 레포 절대경로
}

export interface Message {
  id: string;
  authorId: string; // 'engram' | 'owner' | ...
  text: string;
  ts: number;
  threadId?: string;
}

// 클라 → 서버
export type ClientFrame =
  | { t: 'channels' }
  | { t: 'history'; channelId: string; before?: string }
  | { t: 'send'; channelId: string; text: string; threadId?: string; authorId?: string }
  | { t: 'createChannel'; name: string; mode?: 'chat' | 'code' }
  | { t: 'deleteChannel'; id: string }
  | { t: 'setRepoPath'; id: string; repoPath: string }
  | { t: 'setRespondMode'; id: string; mode: 'all' | 'mention' };

// 서버 → 클라
export type ServerFrame =
  | { t: 'channels'; list: Channel[] }
  | { t: 'history'; channelId: string; messages: Message[] }
  | { t: 'msg'; channelId: string; message: Message }
  | { t: 'error'; text: string };
```

- [ ] **Step 2: `self.adapter.ts`가 서버→클라 프레임을 타입으로**

`self.adapter.ts` 상단에 추가:

```ts
import type { ServerFrame } from '../../../shared/protocol';
```

`sendTo`/`broadcast`의 인자 타입을 `unknown` → `ServerFrame`으로 좁힌다(계약 강제, 런타임 무변경):

```ts
  private sendTo(ws: WebSocket, frame: ServerFrame): void {
    try { ws.send(JSON.stringify(frame)); } catch { /* 격리 */ }
  }
  private broadcast(frame: ServerFrame): void {
    const data = JSON.stringify(frame);
    for (const c of this.wss?.clients ?? []) {
      if (c.readyState === WebSocket.OPEN) {
        try { c.send(data); } catch { /* 격리 */ }
      }
    }
  }
```

> `handleFrame`의 수신 파싱은 지금처럼 `Record<string, unknown>` + 방어 파싱을 유지한다(손상 프레임 무시 성질 보존). 타입 강제는 **송신 측만**.

- [ ] **Step 3: 타입 확인**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 에러 없음(모든 `sendTo`/`broadcast` 호출이 `ServerFrame`에 부합 — 현행 프레임이 그대로 매칭).

- [ ] **Step 4: 두뇌 테스트 회귀 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: PASS(송신 타입만 좁혔으므로 런타임 동일).

- [ ] **Step 5: 커밋**

```bash
git add shared/protocol.ts src/edge/messenger/self.adapter.ts
git commit -m "feat(phase11a): shared/protocol.ts 타입 ws 프레임(단일 진실원) + self 송신 타입화"
```

---

### Task 2: SelfMessenger — http 헬스화(chat.html 서빙 중단)

**Files:**
- Modify: `src/edge/messenger/self.adapter.ts`
- Modify: `src/main.ts`
- Test: `src/edge/messenger/self.adapter.spec.ts`

**Interfaces:**
- Consumes: 없음.
- Produces: GET `/`·`/index.html` → 200 `{ok:true}` 헬스. `htmlPath` opt 제거. ws 업그레이드는 그대로 http 서버에 붙음.

- [ ] **Step 1: 실패 테스트로 교체** — `self.adapter.spec.ts`의 "GET / 는 htmlPath 파일을 서빙, 없으면 404"(97–108행)를 아래로 교체

```ts
it('GET / 는 chat.html을 서빙하지 않고 200 헬스만 응답한다', async () => {
  const res = await fetch(`http://127.0.0.1:${sm.addressPort()}/`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  // 임의 경로는 404(기존 성질 유지)
  const res2 = await fetch(`http://127.0.0.1:${sm.addressPort()}/nope`);
  expect(res2.status).toBe(404);
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts -t "헬스"`
Expected: FAIL(현재 GET / 는 htmlPath 미지정이라 404).

- [ ] **Step 3: 구현** — `self.adapter.ts`

`import * as fs from 'fs';`가 이 파일에서 더 안 쓰이면 제거(다른 사용처 없음 확인 후). 생성자 opts에서 `htmlPath?: string;`(34행) 제거:

```ts
    private readonly opts: {
      engramName?: string;
      logger: { warn(msg: string, ctx?: string): void };
    },
```

`start()`의 http 핸들러(48–59행)를 헬스로 교체:

```ts
    this.server = http.createServer((req, res) => {
      // Phase 11: 클라(renderer/)가 페이지를 소유 — 두뇌 http는 헬스 프로브 + ws 업그레이드만.
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
```

- [ ] **Step 4: main.ts에서 htmlPath 배선 제거** — `src/main.ts` 43–46행

```ts
    self = new SelfMessenger(chatCfg, chatStore, { logger });
```

`resolveResourceFile` import(23행)가 이 파일에서 더 안 쓰이면 제거(다른 사용처 grep 후 없으면 삭제, 있으면 유지).

- [ ] **Step 5: 통과 + 타입 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts` 그리고 `npx tsc --noEmit -p tsconfig.json`
Expected: PASS / 에러 없음.

- [ ] **Step 6: 커밋**

```bash
git add src/edge/messenger/self.adapter.ts src/edge/messenger/self.adapter.spec.ts src/main.ts
git commit -m "feat(phase11a): 두뇌 http를 헬스+ws만으로(chat.html 서빙 중단) + htmlPath 제거"
```

---

### Task 3: `renderer/` 스캐폴딩 — Vite+React+TS 부트(+Vitest)

**Files:**
- Create: `renderer/package.json`, `renderer/tsconfig.json`, `renderer/tsconfig.node.json`, `renderer/vite.config.ts`, `renderer/index.html`, `renderer/src/main.tsx`, `renderer/src/config.ts`, `renderer/src/App.tsx`, `renderer/src/vitest.setup.ts`
- Test: `renderer/src/App.test.tsx`

**Interfaces:**
- Consumes: 없음.
- Produces: `App`(default export) 렌더 가능. `config.ts`가 `WS_URL`·`ko` export. `npm --prefix renderer run build` → `renderer/dist/index.html` 생성.

- [ ] **Step 1: `renderer/package.json`**

```json
{
  "name": "engram-renderer",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.1.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^25.0.1",
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: `renderer/tsconfig.json` + `renderer/tsconfig.node.json`**

`renderer/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": false,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "../shared"]
}
```

`renderer/tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "noEmit": true
  },
  "include": ["vite.config.ts"]
}
```

> `include`에 `../shared`를 넣어 `shared/protocol.ts`를 렌더러 타입 컴파일에 포함(단일 진실원 참조). type-only import라 번들엔 안 실림.

- [ ] **Step 3: `renderer/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Electron이 file://로 로드하므로 상대 경로 자산(base './') 필수.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { fs: { allow: ['..'] } }, // ../shared 참조 허용
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/vitest.setup.ts',
  },
});
```

- [ ] **Step 4: `renderer/index.html` + `main.tsx` + `config.ts` + `vitest.setup.ts`**

`renderer/index.html`:

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Engram</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

`renderer/src/config.ts`:

```ts
// 붙을 두뇌 ws 엔드포인트(Phase 11: 로컬 두뇌 1개 고정. Phase 12에서 다중/설정화).
export const WS_URL = 'ws://127.0.0.1:47800';
// UI 언어: 영어 기본, 시스템 로케일이 한국어면 한국어(두뇌 T 사전과 동일 판정).
export const ko = navigator.language.toLowerCase().startsWith('ko');
```

`renderer/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './theme.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

> `theme.css`는 Task 6에서 생성. 이 태스크에서는 빈 파일이라도 만들어 import가 깨지지 않게 한다: `renderer/src/theme.css`(빈 파일 또는 `/* Phase 11a */`).

`renderer/src/vitest.setup.ts`:

```ts
import '@testing-library/jest-dom';
```

- [ ] **Step 5: 최소 `App.tsx` + 실패 테스트**

`renderer/src/App.tsx`:

```tsx
export default function App() {
  return <div id="titlebar">Engram</div>;
}
```

`renderer/src/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import App from './App';

it('앱이 타이틀을 렌더한다', () => {
  render(<App />);
  expect(screen.getByText('Engram')).toBeInTheDocument();
});
```

- [ ] **Step 6: 설치 · 테스트 · 빌드**

```bash
npm --prefix renderer install
npm --prefix renderer test
npm --prefix renderer run build
```

Expected: 테스트 PASS. 빌드가 `renderer/dist/index.html` + 상대경로(`./assets/…`) 번들 생성.

- [ ] **Step 7: `.gitignore`에 `renderer/dist`·`renderer/node_modules` 추가**(레포에 빌드 산출물/의존성 안 올림; electron-builder는 로컬 `renderer/dist`를 패키징)

`.gitignore` 말미에 추가:

```
renderer/node_modules
renderer/dist
```

- [ ] **Step 8: 커밋**

```bash
git add renderer/package.json renderer/tsconfig.json renderer/tsconfig.node.json renderer/vite.config.ts renderer/index.html renderer/src/main.tsx renderer/src/config.ts renderer/src/App.tsx renderer/src/App.test.tsx renderer/src/vitest.setup.ts renderer/src/theme.css .gitignore
git commit -m "feat(phase11a): renderer/ Vite+React+TS 스캐폴딩 + Vitest 부트"
```

---

### Task 4: ws 클라이언트 훅 — 연결·재연결 백오프·재동기화

**Files:**
- Create: `renderer/src/ws/client.ts`
- Test: `renderer/src/ws/client.test.ts`

**Interfaces:**
- Consumes: `WS_URL`(config), `ClientFrame`/`ServerFrame`(shared/protocol).
- Produces: `useWs(onFrame: (f: ServerFrame) => void): { send: (f: ClientFrame) => void; connected: boolean }`.
  - open 시: `connected=true`, **재동기화** — 호출부가 open 콜백에서 `channels`(+현재 채널 `history`)를 다시 요청하도록 `onOpen` 노출.
  - close 시: 백오프 `[1000,5000,30000]`(초과분은 마지막 값)로 재연결, `connected=false`.
  - message 시: `JSON.parse` 실패는 무시(손상 프레임), 성공하면 `onFrame`.

- [ ] **Step 1: 실패 테스트 작성** — `renderer/src/ws/client.test.ts`

```ts
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWs } from './client';

// 최소 모의 소켓: 인스턴스를 배열에 모아 테스트가 open/close/message를 구동.
class FakeWS {
  static instances: FakeWS[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  sent: string[] = [];
  constructor(public url: string) { FakeWS.instances.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
  _open() { this.readyState = 1; this.onopen?.(); }
}

beforeEach(() => { FakeWS.instances = []; (globalThis as any).WebSocket = FakeWS as any; });

it('open 시 connected=true, onOpen 콜백 발화, onFrame이 파싱된 프레임을 받는다', async () => {
  const frames: any[] = [];
  let opened = 0;
  const { result } = renderHook(() => useWs((f) => frames.push(f), () => { opened++; }));
  act(() => { FakeWS.instances[0]._open(); });
  await waitFor(() => expect(result.current.connected).toBe(true));
  expect(opened).toBe(1);
  act(() => { FakeWS.instances[0].onmessage!({ data: JSON.stringify({ t: 'error', text: 'x' }) }); });
  expect(frames).toEqual([{ t: 'error', text: 'x' }]);
});

it('손상 프레임은 무시한다', () => {
  const frames: any[] = [];
  renderHook(() => useWs((f) => frames.push(f)));
  act(() => { FakeWS.instances[0].onmessage!({ data: '{broken' }); });
  expect(frames).toHaveLength(0);
});

it('close 시 백오프 후 재연결한다', () => {
  vi.useFakeTimers();
  renderHook(() => useWs(() => {}));
  act(() => { FakeWS.instances[0]._open(); FakeWS.instances[0].close(); });
  expect(FakeWS.instances).toHaveLength(1);
  act(() => { vi.advanceTimersByTime(1000); });
  expect(FakeWS.instances).toHaveLength(2); // 첫 백오프 1s 후 새 소켓
  vi.useRealTimers();
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm --prefix renderer test -- client`
Expected: FAIL(`useWs` 없음).

- [ ] **Step 3: 구현** — `renderer/src/ws/client.ts`

```ts
import { useEffect, useRef, useState } from 'react';
import { WS_URL } from '../config';
import type { ClientFrame, ServerFrame } from '../../../shared/protocol';

const DELAYS = [1000, 5000, 30000]; // 재연결 백오프(chat.html과 동일)

// 두뇌 ws에 붙는 단일 연결 훅. onOpen에서 호출부가 재동기화(channels/history 재요청)한다.
export function useWs(onFrame: (f: ServerFrame) => void, onOpen?: () => void) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const attempt = useRef(0);
  const closed = useRef(false);
  // 최신 콜백을 ref로 잡아 재연결 루프가 stale 클로저를 안 쓰게.
  const onFrameRef = useRef(onFrame); onFrameRef.current = onFrame;
  const onOpenRef = useRef(onOpen); onOpenRef.current = onOpen;

  useEffect(() => {
    closed.current = false;
    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => { attempt.current = 0; setConnected(true); onOpenRef.current?.(); };
      ws.onclose = () => {
        setConnected(false);
        if (closed.current) return;
        const d = DELAYS[Math.min(attempt.current++, DELAYS.length - 1)];
        setTimeout(connect, d);
      };
      ws.onerror = () => { /* onclose가 재연결 담당 */ };
      ws.onmessage = (ev) => {
        let f: ServerFrame;
        try { f = JSON.parse(ev.data as string) as ServerFrame; } catch { return; }
        onFrameRef.current(f);
      };
    };
    connect();
    return () => { closed.current = true; wsRef.current?.close(); };
  }, []);

  const send = (f: ClientFrame): void => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
  };
  return { send, connected };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm --prefix renderer test -- client`
Expected: PASS(3건).

- [ ] **Step 5: 커밋**

```bash
git add renderer/src/ws/client.ts renderer/src/ws/client.test.ts
git commit -m "feat(phase11a): useWs 훅 — 연결·재연결 백오프·재동기화·타입 프레임"
```

---

### Task 5: 마크다운·차트 렌더러 verbatim 이전 + Message 컴포넌트

**Files:**
- Create: `renderer/src/render/markdown.ts`
- Create: `renderer/src/components/Message.tsx`
- Test: `renderer/src/render/markdown.test.ts`, `renderer/src/components/Message.test.tsx`

**Interfaces:**
- Consumes: 없음(순수 DOM 빌더).
- Produces:
  - `renderMarkdown(text: string): DocumentFragment` — 헤딩/목록/체크리스트/비교표/인라인강조/외부링크/```chart``` SVG(bar/line/pie). XSS 안전(전부 `textContent`/DOM).
  - `Message({ m, onPick })` — `m: Message`를 렌더. engram 메시지의 `<ol>` 항목 클릭 시 `onPick(String(i+1))`.

- [ ] **Step 1: 실패 테스트 작성** — `renderer/src/render/markdown.test.ts`

```ts
import { renderMarkdown } from './markdown';

const html = (t: string) => { const d = document.createElement('div'); d.appendChild(renderMarkdown(t)); return d; };

it('체크리스트를 disabled 체크박스로 렌더한다', () => {
  const d = html('- [x] 완료\n- [ ] 미완');
  const boxes = d.querySelectorAll('ul.check input[type=checkbox]');
  expect(boxes).toHaveLength(2);
  expect((boxes[0] as HTMLInputElement).checked).toBe(true);
  expect((boxes[0] as HTMLInputElement).disabled).toBe(true);
});

it('비교 표를 렌더하고 +/▲ 셀에 up 클래스를 준다', () => {
  const d = html('| 항목 | 값 |\n| --- | --- |\n| 매출 | ▲ 12% |');
  expect(d.querySelector('table.cmp')).toBeTruthy();
  expect(d.querySelector('td.up')).toBeTruthy();
});

it('```chart bar 블록을 SVG로 렌더한다', () => {
  const d = html('```chart\n{"type":"bar","labels":["a","b"],"values":[1,2]}\n```');
  expect(d.querySelector('.chart svg rect.cbar')).toBeTruthy();
});

it('외부 링크만 허용하고 스크립트 텍스트는 실행 노드가 아니다(XSS)', () => {
  const d = html('[safe](https://x.com) <script>alert(1)</script>');
  expect(d.querySelector('a[href="https://x.com"]')).toBeTruthy();
  expect(d.querySelector('script')).toBeNull(); // textContent로만 들어가 실행 노드 아님
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm --prefix renderer test -- markdown`
Expected: FAIL(`renderMarkdown` 없음).

- [ ] **Step 3: 구현** — `renderer/src/render/markdown.ts`

`src/desktop/chat.html`의 아래 함수들을 **한 글자도 안 바꾸고 그대로 옮긴다**(검증된 XSS-안전 DOM 빌더 재사용 — 재작성 금지):
- `mdLink` (300–307행)
- `mdInline` (308–326행)
- `SVG_NS`/`svgEl` (329–335행)
- `renderChart` (336–403행)
- `renderMarkdown` (404–492행)

파일 맨 끝에 export 추가(다른 파일은 `renderMarkdown`만 씀):

```ts
export { renderMarkdown, renderChart, mdInline };
```

> `ko`를 참조하는 부분은 이 파일엔 없음(마크다운 빌더는 로케일 무관). 그대로 옮기면 된다. `document`/`document.createElementNS`는 jsdom에서 동작.

- [ ] **Step 4: `Message.tsx` + 테스트**

`renderer/src/components/Message.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import type { Message as Msg } from '../../../shared/protocol';
import { renderMarkdown } from '../render/markdown';
import { ko } from '../config';

// 메시지 1개. 본문은 검증된 DOM 빌더를 ref로 마운트(React 이스케이프 밖이지만 빌더가 XSS 안전).
// engram 메시지의 번호목록(후보 선택 등)은 클릭하면 그 번호가 입력창에 채워지도록 onPick 호출.
export function Message({ m, onPick }: { m: Msg; onPick: (text: string) => void }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const isEngram = m.authorId === 'engram';
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.replaceChildren(renderMarkdown(m.text));
    if (isEngram) {
      body.querySelectorAll('ol').forEach((ol) => {
        ol.querySelectorAll(':scope > li').forEach((li, i) => {
          li.classList.add('pick');
          (li as HTMLElement).title = ko ? '클릭하면 번호가 입력됩니다' : 'Click to fill this number';
          (li as HTMLElement).onclick = () => onPick(String(i + 1));
        });
      });
    }
  }, [m.text, isEngram, onPick]);
  return (
    <div className={'msg' + (isEngram ? '' : ' me')}>
      <div className="who">{(isEngram ? 'Engram' : ko ? '나' : 'me') + ' · ' + new Date(m.ts).toLocaleTimeString()}</div>
      <div className="body" ref={bodyRef} />
    </div>
  );
}
```

`renderer/src/components/Message.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { Message } from './Message';

it('engram 번호목록 클릭 시 onPick(번호)를 호출한다', () => {
  const picks: string[] = [];
  const { container } = render(
    <Message m={{ id: '1', authorId: 'engram', ts: 0, text: '1. 하나\n2. 둘' }} onPick={(t) => picks.push(t)} />,
  );
  const items = container.querySelectorAll('ol > li.pick');
  expect(items).toHaveLength(2);
  (items[1] as HTMLElement).click();
  expect(picks).toEqual(['2']);
});
```

- [ ] **Step 5: 통과 확인**

Run: `npm --prefix renderer test -- markdown Message`
Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
git add renderer/src/render/markdown.ts renderer/src/components/Message.tsx renderer/src/render/markdown.test.ts renderer/src/components/Message.test.tsx
git commit -m "feat(phase11a): 마크다운·차트 렌더러 verbatim 이전 + Message 컴포넌트(번호 클릭채움)"
```

---

### Task 6: App 셸 — 테마·i18n·채널 사이드바·모드탭·연결 점·기본 송수신

**Files:**
- Create: `renderer/src/theme.css`(Task 3의 빈 파일 채움), `renderer/src/i18n.ts`, `renderer/src/components/Channels.tsx`
- Modify: `renderer/src/App.tsx`
- Test: `renderer/src/App.test.tsx`(교체/확장)

**Interfaces:**
- Consumes: `useWs`(Task 4), `Message`(Task 5), `Channel`/`ServerFrame`/`ClientFrame`(shared).
- Produces:
  - `T`(i18n 사전) — chat.html `T`(143–161행) 이전.
  - `App` 상태: `channels: Channel[]`, `current: string|null`, `mode: 'chat'|'code'`, `msgsByCh: Map<string, Msg[]>`, `connected`.
  - `Channels({ channels, current, mode, onSelect, onSetMode, onCreate, onDelete, onSetRespondMode })` — 모드탭·목록·⋯메뉴·새채널 인라인.
  - open(재동기화) 시 `channels`+현재 채널 `history` 재요청. `channels`/`history`/`msg`/`error` 프레임 처리.

- [ ] **Step 1: `theme.css` 채움** — `src/desktop/chat.html`의 `<style>` 내용(9–114행)을 **그대로** `renderer/src/theme.css`로 옮긴다. `body`에 chat.html의 body 규칙(22–23행) 적용. 변경 없음(CSS 변수·라이트/다크·`#titlebar`·`.msg`·`.chart`·`#modetabs`·`#empty`·`#chhdr`·`#palette`·`#popmenu` 전부).

- [ ] **Step 2: `i18n.ts`** — chat.html `T`(143–161행)를 이전

```ts
import { ko } from './config';

export const T = {
  placeholder: ko ? '메시지 입력…' : 'Message…',
  send: ko ? '보내기' : 'Send',
  newChannel: ko ? '+ 새 채널' : '+ New channel',
  newChannelPrompt: ko ? '채널 이름:' : 'Channel name:',
  replies: (n: number) => (ko ? `답글 ${n}개` : `${n} replies`),
  replyPh: ko ? '스레드에 답장…' : 'Reply in thread…',
  delConfirm: (name: string) => (ko ? `'${name}' 채널을 삭제할까요? (기록 파일은 남습니다)` : `Delete channel '${name}'? (history file is kept)`),
  delChannel: ko ? '채널 삭제' : 'Delete channel',
  modeAll: ko ? '모든 메시지에 반응' : 'Respond to all',
  modeMention: ko ? '@Engram 멘션에만 반응' : 'Respond to @Engram only',
  engram: 'Engram', me: ko ? '나' : 'me',
  thinking: ko ? 'Engram이 생각하는 중' : 'Engram is thinking',
  tabChat: ko ? '채팅' : 'Chat',
  tabCode: ko ? '코드' : 'Code',
  pickFolder: ko ? '먼저 작업할 폴더를 선택하세요 📁' : 'First choose a folder to work in 📁',
  pickFolderBtn: ko ? '폴더 선택' : 'Choose folder',
  pickFolderPath: ko ? '폴더 경로 입력…' : 'Folder path…',
  newCodeChannelPrompt: ko ? '코드 채널 이름:' : 'Code channel name:',
};
```

- [ ] **Step 3: `Channels.tsx`** — 사이드바(모드탭·모드필터 목록·⋯메뉴·새채널 인라인)

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Channel } from '../../../shared/protocol';
import { T } from '../i18n';

// chat.html의 #modetabs + #channels + #newch + 채널 ⋯메뉴(모드전환/삭제)를 컴포넌트로 이전.
export function Channels(props: {
  channels: Channel[];
  current: string | null;
  mode: 'chat' | 'code';
  onSelect: (id: string) => void;
  onSetMode: (m: 'chat' | 'code') => void;
  onCreate: (name: string, mode: 'chat' | 'code') => void;
  onDelete: (id: string) => void;
  onSetRespondMode: (id: string, mode: 'all' | 'mention') => void;
}) {
  const { channels, current, mode } = props;
  const [creating, setCreating] = useState(false);
  // 팝오버: 열린 채널 id + ⋯ 앵커 좌표(rect.left/bottom). 실제 화면 좌표는 렌더 후 실측해서 pos에.
  const [menu, setMenu] = useState<{ id: string; ax: number; ay: number } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });
  const popRef = useRef<HTMLDivElement>(null);
  const visible = channels.filter((c) => (c.mode || 'chat') === mode);

  // 바깥 클릭·Esc로 닫힘(chat.html document click/keydown 리스너 이전).
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => { if (!popRef.current?.contains(e.target as Node)) setMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu]);

  // ⋯ 클릭 = 앵커 rect만 저장(측정 전 화면 밖으로 두어 깜빡임 방지).
  const openMenu = (id: string, anchor: HTMLElement) => {
    const r = anchor.getBoundingClientRect();
    setMenu({ id, ax: r.left, ay: r.bottom });
    setPos({ left: -9999, top: -9999 });
  };

  // 렌더 직후 팝오버 실측(offsetWidth/offsetHeight)으로 뷰포트 클램프(chat.html 그대로, paint 전 배치).
  useLayoutEffect(() => {
    if (!menu || !popRef.current) return;
    const w = popRef.current.offsetWidth, h = popRef.current.offsetHeight;
    setPos({
      left: Math.max(8, Math.min(menu.ax, window.innerWidth - w - 8)),
      top: Math.min(menu.ay + 4, window.innerHeight - h - 8),
    });
  }, [menu]);

  return (
    <div id="side">
      <div id="modetabs">
        {(['chat', 'code'] as const).map((m) => (
          <div key={m} className={'mtab' + (m === mode ? ' sel' : '')} onClick={() => props.onSetMode(m)}>
            {m === 'chat' ? T.tabChat : T.tabCode}
          </div>
        ))}
      </div>
      <div id="channels">
        {visible.map((c) => (
          <div key={c.id} className={'ch' + (c.id === current ? ' sel' : '')} onClick={() => props.onSelect(c.id)}>
            <span>{'# ' + c.name}</span>
            <span className="menu" onClick={(e) => { e.stopPropagation(); openMenu(c.id, e.currentTarget); }}>⋯</span>
          </div>
        ))}
      </div>
      {menu && (() => {
        const c = channels.find((x) => x.id === menu.id);
        if (!c) return null;
        return (
          <div id="popmenu" ref={popRef} style={{ left: pos.left, top: pos.top }}>
            <div onClick={() => { props.onSetRespondMode(c.id, c.respondMode === 'all' ? 'mention' : 'all'); setMenu(null); }}>
              {c.respondMode === 'all' ? T.modeMention : T.modeAll}
            </div>
            <div className="danger" onClick={() => { setMenu(null); if (window.confirm(T.delConfirm(c.name))) props.onDelete(c.id); }}>
              {T.delChannel}
            </div>
          </div>
        );
      })()}
      <div id="newch">
        {creating ? (
          <input
            autoFocus
            type="text"
            placeholder={mode === 'code' ? T.newCodeChannelPrompt : T.newChannelPrompt}
            onKeyDown={(e) => {
              const v = (e.target as HTMLInputElement).value;
              if (e.key === 'Enter' && v.trim()) { props.onCreate(v, mode); setCreating(false); }
              else if (e.key === 'Escape') setCreating(false);
            }}
            onBlur={() => setCreating(false)}
          />
        ) : (
          <span onClick={() => setCreating(true)}>{T.newChannel}</span>
        )}
      </div>
    </div>
  );
}
```

> `#popmenu`는 chat.html 그대로 `position:fixed`(theme.css) + ⋯ 앵커 rect 기준 + **팝오버 실측(offsetWidth/offsetHeight)으로 뷰포트 클램프**(useLayoutEffect=paint 전 배치, 측정 전엔 -9999로 화면 밖=깜빡임 방지) + 바깥클릭/Esc 닫힘. 채널 목록 밖에 렌더(`overflow-y:auto`인 `#channels`에 안 잘리게). import에 `useEffect`·`useLayoutEffect`·`useRef` 추가.

- [ ] **Step 4: `App.tsx` 재작성** — 셸 + 상태 + ws 배선(스레드/팔레트/폴더는 Task 7·8에서 채움)

```tsx
import { useCallback, useRef, useState } from 'react';
import type { Channel, Message as Msg, ServerFrame } from '../../shared/protocol';
import { useWs } from './ws/client';
import { Channels } from './components/Channels';
import { Message } from './components/Message';
import { T } from './i18n';

export default function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [mode, setMode] = useState<'chat' | 'code'>('chat');
  const [msgsByCh, setMsgsByCh] = useState<Map<string, Msg[]>>(new Map());
  const currentRef = useRef<string | null>(null); currentRef.current = current;

  const onFrame = useCallback((f: ServerFrame) => {
    if (f.t === 'channels') {
      setChannels(f.list);
      setCurrent((cur) => (cur && f.list.some((c) => c.id === cur) ? cur : (f.list[0]?.id ?? null)));
    } else if (f.t === 'history') {
      setMsgsByCh((prev) => new Map(prev).set(f.channelId, f.messages));
    } else if (f.t === 'msg') {
      setMsgsByCh((prev) => {
        const next = new Map(prev);
        next.set(f.channelId, [...(next.get(f.channelId) ?? []), f.message]);
        return next;
      });
    } else if (f.t === 'error') {
      console.warn('server error:', f.text);
    }
  }, []);

  const onOpen = useCallback(() => {
    setMsgsByCh(new Map()); // 재연결 시 파일 진실원과 재동기화
    send({ t: 'channels' });
    if (currentRef.current) send({ t: 'history', channelId: currentRef.current });
  }, []);

  const { send, connected } = useWs(onFrame, onOpen);

  const selectChannel = (id: string) => {
    setCurrent(id);
    if (!msgsByCh.has(id)) send({ t: 'history', channelId: id });
  };
  const onSetMode = (m: 'chat' | 'code') => {
    setMode(m);
    const visible = channels.filter((c) => (c.mode || 'chat') === m);
    if (!visible.some((c) => c.id === current)) setCurrent(visible[0]?.id ?? null);
  };

  const ch = channels.find((c) => c.id === current);
  const fill = (text: string) => { const i = document.getElementById('input') as HTMLInputElement | null; if (i) { i.value = text; i.focus(); } };
  const sendText = (text: string, threadId?: string) => {
    if (!text.trim() || !current) return;
    send({ t: 'send', channelId: current, text, threadId });
  };

  return (
    <>
      <div id="titlebar"><span id="dot" className={connected ? 'on' : ''} /><span id="tbtitle">Engram</span></div>
      <div id="app">
        <Channels
          channels={channels} current={current} mode={mode}
          onSelect={selectChannel} onSetMode={onSetMode}
          onCreate={(name, m) => send({ t: 'createChannel', name, mode: m })}
          onDelete={(id) => send({ t: 'deleteChannel', id })}
          onSetRespondMode={(id, m) => send({ t: 'setRespondMode', id, mode: m })}
        />
        <div id="main">
          <div id="msgs">
            {(msgsByCh.get(current ?? '') ?? []).filter((m) => !m.threadId).map((m) => (
              <Message key={m.id} m={m} onPick={fill} />
            ))}
          </div>
          <div id="inputbar" style={ch ? undefined : { display: 'none' }}>
            <input id="input" type="text" placeholder={T.placeholder}
              onKeyDown={(e) => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value; sendText(v); (e.target as HTMLInputElement).value = ''; } }} />
            <button onClick={() => { const i = document.getElementById('input') as HTMLInputElement; sendText(i.value); i.value = ''; }}>{T.send}</button>
          </div>
        </div>
      </div>
    </>
  );
}
```

> 이 태스크는 **본류 메시지 렌더 + 송수신 + 채널/모드/연결점**까지. 스레드(답글)·팔레트·"생각 중"·폴더 empty state는 Task 7·8에서 이 셸에 얹는다. `#input` id는 Message의 번호 클릭채움(Task 5)이 `getElementById('input')`로 참조하므로 유지.

- [ ] **Step 5: `App.test.tsx` 교체** — 모의 소켓으로 channels 수신 → 렌더 확인

```tsx
import { render, screen, act, waitFor } from '@testing-library/react';
import App from './App';

class FakeWS {
  static last: FakeWS;
  onopen: (() => void) | null = null; onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null; onerror: (() => void) | null = null;
  readyState = 1; sent: string[] = [];
  constructor() { FakeWS.last = this; }
  send(d: string) { this.sent.push(d); }
  close() {}
}
beforeEach(() => { (globalThis as any).WebSocket = FakeWS as any; });

it('open 후 channels 프레임을 받으면 채널 탭·목록을 렌더한다', async () => {
  render(<App />);
  act(() => { FakeWS.last.onopen!(); });
  act(() => { FakeWS.last.onmessage!({ data: JSON.stringify({ t: 'channels', list: [{ id: 'g', name: 'general', respondMode: 'all', mode: 'chat' }] }) }); });
  await waitFor(() => expect(screen.getByText('# general')).toBeInTheDocument());
  expect(FakeWS.last.sent.some((s) => s.includes('"channels"'))).toBe(true); // 재동기화 요청
});
```

- [ ] **Step 6: 통과 + 빌드 확인**

Run: `npm --prefix renderer test` 그리고 `npm --prefix renderer run build`
Expected: PASS / 빌드 성공.

- [ ] **Step 7: 커밋**

```bash
git add renderer/src/theme.css renderer/src/i18n.ts renderer/src/components/Channels.tsx renderer/src/App.tsx renderer/src/App.test.tsx
git commit -m "feat(phase11a): App 셸 — 테마·i18n·채널 사이드바·모드탭·연결점·기본 송수신"
```

---

### Task 7: 자동 스레드 + 초안 유지 + "생각 중" 인디케이터

**Files:**
- Create: `renderer/src/components/Thread.tsx`
- Modify: `renderer/src/App.tsx`
- Test: `renderer/src/components/Thread.test.tsx`

**Interfaces:**
- Consumes: `Message`(Task 5), `T`(i18n).
- Produces:
  - `Thread({ anchor, replies, draft, onDraft, onReply, onPick })` — 답 1개=인라인+연결선(`.reply`), 2+=`<details>` 접힘(기본 펼침), 스레드 답장 입력(초안 유지).
  - App: `awaiting` 상태(채널별 "생각 중", 180s 타임아웃), engram 답 도착 시 해제. `collapsedThreads`/`drafts`.

- [ ] **Step 1: 실패 테스트 작성** — `renderer/src/components/Thread.test.tsx`

```tsx
import { render, screen } from '@testing-library/react';
import { Thread } from './Thread';

const anchor = { id: 'a', authorId: 'owner', ts: 0, text: '질문' };
it('답 1개는 인라인(reply)로, 2개 이상은 접힘 요약으로 렌더한다', () => {
  const one = render(<Thread anchor={anchor} replies={[{ id: 'r1', authorId: 'engram', ts: 1, text: '답1' }]}
    draft="" onDraft={() => {}} onReply={() => {}} onPick={() => {}} />);
  expect(one.container.querySelector('.msg.reply')).toBeTruthy();
  one.unmount();
  render(<Thread anchor={anchor}
    replies={[{ id: 'r1', authorId: 'engram', ts: 1, text: '답1' }, { id: 'r2', authorId: 'engram', ts: 2, text: '답2' }]}
    draft="" onDraft={() => {}} onReply={() => {}} onPick={() => {}} />);
  expect(screen.getByText(/답글 2개|2 replies/)).toBeInTheDocument();
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm --prefix renderer test -- Thread`
Expected: FAIL(`Thread` 없음).

- [ ] **Step 3: 구현** — `renderer/src/components/Thread.tsx`

```tsx
import { useState } from 'react';
import type { Message as Msg } from '../../../shared/protocol';
import { Message } from './Message';
import { T } from '../i18n';

// chat.html renderMsgs의 스레드 로직 이전: 답1=인라인(.reply), 2+=<details>(기본 펼침).
export function Thread(props: {
  anchor: Msg; replies: Msg[]; draft: string;
  onDraft: (v: string) => void; onReply: (text: string) => void; onPick: (t: string) => void;
}) {
  const { anchor, replies } = props;
  const [open, setOpen] = useState(true);
  if (replies.length === 0) return <Message m={anchor} onPick={props.onPick} />;
  if (replies.length === 1) {
    return (<>
      <Message m={anchor} onPick={props.onPick} />
      <div className="msg reply"><Message m={replies[0]} onPick={props.onPick} /></div>
    </>);
  }
  return (<>
    <Message m={anchor} onPick={props.onPick} />
    <details className="thread" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{'🧵 ' + T.replies(replies.length)}</summary>
      {replies.map((r) => <Message key={r.id} m={r} onPick={props.onPick} />)}
      <div className="treply">
        <input type="text" placeholder={T.replyPh} value={props.draft}
          onChange={(e) => props.onDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && props.draft.trim()) { props.onReply(props.draft); props.onDraft(''); } }} />
      </div>
    </details>
  </>);
}
```

> `.msg.reply`가 chat.html에선 `makeMsgEl(...).classList.add('reply')`로 msg 자체에 붙었다. 여기선 래퍼 `div.msg.reply`로 동일 스타일 적용(연결선). CSS 규칙 `.msg.reply`(theme.css)와 정합.

- [ ] **Step 4: App에 스레드·awaiting·draft 배선**

`App.tsx`에 상태 추가:

```tsx
const [awaiting, setAwaiting] = useState<Set<string>>(new Set());
const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
const awaitTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
```

`onFrame`의 `msg` 분기에서 engram 답 도착 시 awaiting 해제:

```tsx
} else if (f.t === 'msg') {
  setMsgsByCh((prev) => { const n = new Map(prev); n.set(f.channelId, [...(n.get(f.channelId) ?? []), f.message]); return n; });
  if (f.message.authorId === 'engram') {
    const tm = awaitTimers.current.get(f.channelId);
    if (tm) { clearTimeout(tm); awaitTimers.current.delete(f.channelId); }
    setAwaiting((prev) => { const n = new Set(prev); n.delete(f.channelId); return n; });
  }
}
```

`sendText`가 답을 기대하면 "생각 중" 표시(멘션-전용 채널에서 비멘션이면 안 띄움 — chat.html expectReply):

```tsx
const expectReply = (channelId: string, text: string) => {
  const c = channels.find((x) => x.id === channelId);
  if (c && c.respondMode === 'mention' && !/@engram/i.test(text)) return;
  const prev = awaitTimers.current.get(channelId); if (prev) clearTimeout(prev);
  awaitTimers.current.set(channelId, setTimeout(() => {
    awaitTimers.current.delete(channelId);
    setAwaiting((p) => { const n = new Set(p); n.delete(channelId); return n; });
  }, 180000));
  setAwaiting((p) => new Set(p).add(channelId));
};
```

`sendText`에서 전송 후 `expectReply(current, text)` 호출. `#msgs` 렌더를 본류→`Thread`로 교체(답글 묶기):

```tsx
<div id="msgs">
  {(() => {
    const msgs = msgsByCh.get(current ?? '') ?? [];
    const byAnchor = new Map<string, Msg[]>();
    for (const m of msgs) if (m.threadId) { (byAnchor.get(m.threadId) ?? byAnchor.set(m.threadId, []).get(m.threadId)!).push(m); }
    return msgs.filter((m) => !m.threadId).map((m) => (
      <Thread key={m.id} anchor={m} replies={byAnchor.get(m.id) ?? []}
        draft={drafts.get(m.id) ?? ''}
        onDraft={(v) => setDrafts((p) => new Map(p).set(m.id, v))}
        onReply={(text) => { sendText(text, m.id); expectReply(current!, text); setDrafts((p) => { const n = new Map(p); n.delete(m.id); return n; }); }}
        onPick={fill} />
    ));
  })()}
  {current && awaiting.has(current) && (
    <div className="typing"><span>{T.thinking}</span><span className="dots" /></div>
  )}
</div>
```

- [ ] **Step 5: 통과 + 빌드 확인**

Run: `npm --prefix renderer test` 그리고 `npm --prefix renderer run build`
Expected: PASS / 빌드 성공.

- [ ] **Step 6: 커밋**

```bash
git add renderer/src/components/Thread.tsx renderer/src/components/Thread.test.tsx renderer/src/App.tsx
git commit -m "feat(phase11a): 자동 스레드(답1 인라인/2+ 접힘)+초안 유지+생각 중 인디케이터"
```

---

### Task 8: `/`명령 팔레트 + Code 폴더 empty state + 레포 헤더

**Files:**
- Create: `renderer/src/components/Palette.tsx`, `renderer/src/components/FolderEmpty.tsx`, `renderer/src/desktop.d.ts`
- Modify: `renderer/src/App.tsx`
- Test: `renderer/src/components/Palette.test.tsx`, `renderer/src/components/FolderEmpty.test.tsx`

**Interfaces:**
- Consumes: `T`, `window.engramDesktop.pickFolder`(preload).
- Produces:
  - `Palette({ filter, onPick })` — `/`로 시작 시 명령 목록(chat.html `COMMANDS` 이전), 클릭/Enter로 입력 채움.
  - `FolderEmpty({ onSetRepo })` — `[폴더 선택]` → `window.engramDesktop.pickFolder()`(네이티브) 또는 텍스트 폴백.
  - App: Code 채널 + `!repoPath` → FolderEmpty(입력바 숨김), `repoPath` 있으면 헤더 `📁 폴더명`.

- [ ] **Step 1: `desktop.d.ts`(preload 타입 선언)**

```ts
// Electron preload가 주입하는 최소 API(chat-preload.ts). 브라우저엔 없음(옵셔널).
declare global {
  interface Window {
    engramDesktop?: { pickFolder: () => Promise<string | null> };
  }
}
export {};
```

- [ ] **Step 2: 실패 테스트 작성** — `Palette.test.tsx` + `FolderEmpty.test.tsx`

```tsx
// Palette.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { Palette, filterCommands } from './Palette';
it('필터에 맞는 명령을 보여주고 클릭 시 insert를 onPick 한다', () => {
  const picks: string[] = [];
  render(<Palette filter="team" selected={0} onPick={(v) => picks.push(v)} />);
  fireEvent.click(screen.getByText(/team/));
  expect(picks[0]).toBe('team ');
});
it('selected 인덱스 항목에 .sel 강조를 준다', () => {
  const { container } = render(<Palette filter="" selected={1} onPick={() => {}} />);
  const items = container.querySelectorAll('#palette .item');
  expect(items[1].className).toContain('sel');
  expect(items[0].className).not.toContain('sel');
});
it('filterCommands가 label/insert 부분일치로 거른다', () => {
  expect(filterCommands('resume').map((c) => c.insert)).toEqual(['resume ']);
});
```

```tsx
// FolderEmpty.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FolderEmpty } from './FolderEmpty';
it('네이티브 pickFolder 결과를 onSetRepo로 넘긴다', async () => {
  (window as any).engramDesktop = { pickFolder: async () => 'C:/repo/x' };
  const set: string[] = [];
  render(<FolderEmpty onSetRepo={(p) => set.push(p)} />);
  fireEvent.click(screen.getByText(/폴더 선택|Choose folder/));
  await waitFor(() => expect(set).toEqual(['C:/repo/x']));
  delete (window as any).engramDesktop;
});
```

- [ ] **Step 3: 실패 확인**

Run: `npm --prefix renderer test -- Palette FolderEmpty`
Expected: FAIL(컴포넌트 없음).

- [ ] **Step 4: `Palette.tsx`** — chat.html `COMMANDS`(642–651행) 이전

```tsx
import { ko } from '../config';

export interface Command { insert: string; label: string; desc: string }

const COMMANDS: Command[] = [
  { insert: '상태', label: '상태', desc: ko ? '이 채널의 진행 중/최근 작업 상태' : 'Running/recent tasks in this channel' },
  { insert: 'code ', label: 'code <repo> <goal>', desc: ko ? '레포에 코딩 위임 — 자연어("○○레포에 △△ 해줘")도 됨' : 'Delegate coding to a repo — natural language works too' },
  { insert: 'team ', label: 'team <p1,p2> <question>', desc: ko ? '지정한 페르소나 팀으로 협업' : 'Collaborate with the named persona team' },
  { insert: 'ask ', label: 'ask <question>', desc: ko ? '분류 없이 바로 위키 근거 답변' : 'Direct wiki-grounded answer (skips triage)' },
  { insert: 'schedule ', label: 'schedule <cron> <task>', desc: ko ? '예약 — 자연어("매일 9시에…")도 됨' : 'Schedule — natural language works too' },
  { insert: '예약목록', label: ko ? '예약목록' : '예약목록 (list schedules)', desc: ko ? '이 채널의 예약 보기' : 'List schedules in this channel' },
  { insert: '예약취소 ', label: ko ? '예약취소 <id>' : '예약취소 <id> (cancel)', desc: ko ? '예약 취소' : 'Cancel a schedule' },
  { insert: 'resume ', label: 'resume <projectId>', desc: ko ? '멈춘 코딩 작업 재개' : 'Resume a stopped coding project' },
];

// filter='/' 뒤 소문자. App이 키보드 네비(ArrowUp/Down+Enter)를 몰려면 필터 결과가 필요 → 여기서 export.
export function filterCommands(filter: string): Command[] {
  return COMMANDS.filter((c) => c.label.toLowerCase().includes(filter) || c.insert.toLowerCase().includes(filter));
}

// '/'로 시작하면 표시. selected(=palIdx)에 .sel 강조(chat.html renderPalette 이전). 클릭·Enter로 insert 채움.
export function Palette({ filter, selected, onPick }: { filter: string; selected: number; onPick: (insert: string) => void }) {
  const items = filterCommands(filter);
  if (items.length === 0) return null;
  return (
    <div id="palette" style={{ display: 'block' }}>
      {items.map((c, i) => (
        <div key={c.label} className={'item' + (i === selected ? ' sel' : '')} onClick={() => onPick(c.insert)}>
          <span className="cmd">{c.label}</span>
          <span className="desc">{c.desc}</span>
        </div>
      ))}
    </div>
  );
}
```

> chat.html 방향키 네비 **그대로 이전**: ArrowDown/Up 순환·Enter 선택·Esc 닫힘·`.sel` 강조. 입력에 포커스가 남으므로(팔레트 비포커스) 키 처리는 App의 `#input` onKeyDown이 담당(chat.html과 동일 구조) — 그래서 `filterCommands`를 export해 App이 같은 목록·인덱스를 본다.

- [ ] **Step 5: `FolderEmpty.tsx`** — chat.html `makeFolderEmptyState`(522–551행) 이전

```tsx
import { useState } from 'react';
import { T } from '../i18n';

// Code 채널 첫 진입(폴더 미바인딩) empty state. 네이티브 대화상자 우선, 브라우저는 텍스트 폴백.
export function FolderEmpty({ onSetRepo }: { onSetRepo: (path: string) => void }) {
  const [fallback, setFallback] = useState(false);
  const [val, setVal] = useState('');
  const pick = async () => {
    if (window.engramDesktop?.pickFolder) {
      const p = await window.engramDesktop.pickFolder();
      if (p) onSetRepo(p);
    } else {
      setFallback(true);
    }
  };
  return (
    <div id="empty">
      <div>{T.pickFolder}</div>
      <button onClick={pick}>{T.pickFolderBtn}</button>
      {fallback && (
        <input autoFocus type="text" placeholder={T.pickFolderPath} value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && val.trim()) onSetRepo(val.trim()); }} />
      )}
    </div>
  );
}
```

- [ ] **Step 6: App 배선** — 팔레트 표시 + Code empty/헤더 + 입력바 분기

`App.tsx`에 팔레트 상태(`filterCommands`도 import):

```tsx
const [palFilter, setPalFilter] = useState<string | null>(null); // null=닫힘
const [palIdx, setPalIdx] = useState(0);                          // 선택 인덱스(방향키)
```

입력 `onChange`로 `/` 감지 + `onKeyDown`으로 팔레트 방향키 네비(chat.html input.onkeydown 이전, id='input' 유지):

```tsx
const pickCmd = (insert: string) => { const i = document.getElementById('input') as HTMLInputElement; i.value = insert; i.focus(); setPalFilter(null); };

<input id="input" type="text" placeholder={T.placeholder}
  onChange={(e) => { const v = e.target.value; const open = v.startsWith('/'); setPalFilter(open ? v.slice(1).toLowerCase() : null); setPalIdx(0); }}
  onKeyDown={(e) => {
    if (palFilter !== null) { // 팔레트 열림: 방향키/Enter/Esc는 팔레트 조작(전송 아님)
      const items = filterCommands(palFilter);
      if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); setPalIdx((p) => (p + 1) % items.length); return; }
      if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); setPalIdx((p) => (p - 1 + items.length) % items.length); return; }
      if (e.key === 'Enter' && items.length) { e.preventDefault(); pickCmd(items[Math.min(palIdx, items.length - 1)].insert); return; }
      if (e.key === 'Escape') { setPalFilter(null); return; }
    }
    if (e.key === 'Enter') {
      const i = e.target as HTMLInputElement;
      sendText(i.value); expectReply(current!, i.value); i.value = '';
    }
  }} />
```

`#main` 내부를 채널 상태로 분기:

```tsx
<div id="main">
  {ch && (ch.mode || 'chat') === 'code' && ch.repoPath && (
    <div id="chhdr" style={{ display: 'block' }} title={ch.repoPath}>
      {'📁 ' + ch.repoPath.split(/[\\/]/).filter(Boolean).pop()}
    </div>
  )}
  {ch && (ch.mode || 'chat') === 'code' && !ch.repoPath ? (
    <FolderEmpty onSetRepo={(p) => send({ t: 'setRepoPath', id: ch.id, repoPath: p })} />
  ) : (
    <>
      <div id="msgs">{/* Task 7의 Thread 목록 + 생각 중 */}</div>
      {palFilter !== null && (
        <Palette filter={palFilter} selected={palIdx} onPick={pickCmd} />
      )}
      <div id="inputbar">{/* 입력 + 보내기 버튼 */}</div>
    </>
  )}
</div>
```

> Code 채널 + 폴더 미바인딩이면 입력바·msgs 대신 FolderEmpty만(chat.html renderMsgs 분기와 동일). 바인딩되면 헤더 `📁`.

- [ ] **Step 7: 통과 + 빌드 확인**

Run: `npm --prefix renderer test` 그리고 `npm --prefix renderer run build`
Expected: PASS / 빌드 성공.

- [ ] **Step 8: 커밋**

```bash
git add renderer/src/components/Palette.tsx renderer/src/components/FolderEmpty.tsx renderer/src/desktop.d.ts renderer/src/components/Palette.test.tsx renderer/src/components/FolderEmpty.test.tsx renderer/src/App.tsx
git commit -m "feat(phase11a): / 명령 팔레트 + Code 폴더 선택 empty state + 레포 헤더"
```

---

### Task 9: Electron 연동 — loadFile + 프로브 + builder files + 스크립트

**Files:**
- Modify: `src/desktop/main.ts`
- Modify: `package.json`
- Test: 없음(Electron 런타임 — 수동 스모크). `npx tsc --noEmit`로 타입만.

**Interfaces:**
- Consumes: `renderer/dist/index.html`(Task 3 빌드 산출), 두뇌 http 헬스(Task 2).
- Produces: `openChat()`가 http 헬스 프로브로 준비 감지 후 `loadFile(renderer/dist/index.html)`로 진입. 외부 링크·네비게이션 가드는 file:// 대응. 패키징 `files`에 `renderer/dist/**`.

- [ ] **Step 1: `openChat()` loadFile 전환** — `src/desktop/main.ts` 117–178행

`url`(헬스 프로브용, http)과 페이지 로드(loadFile)를 분리한다. 교체 지점:

`const url = ...` 아래에 렌더러 경로 추가:

```ts
  const cfg = loadChatConfig(configDir, childEnv);
  const healthUrl = `http://127.0.0.1:${cfg.port}/`; // 준비 감지용(두뇌 http 헬스)
  const rendererIndex = path.join(app.getAppPath(), 'renderer', 'dist', 'index.html'); // 클라가 소유하는 페이지
```

`will-navigate` 가드(147–152행)를 file:// 페이지 밖 이탈만 차단하도록 교체:

```ts
  chatWin.webContents.on('will-navigate', (e, navUrl) => {
    // 렌더러(file://) 밖으로 나가는 네비게이션은 외부 브라우저로(창 탈취 방지).
    if (!navUrl.startsWith('file://')) {
      e.preventDefault();
      void shell.openExternal(navUrl);
    }
  });
```

`probe()`(159–165행)가 준비되면 **loadFile**로 진입하도록:

```ts
  const probe = (): void => {
    if (!chatWin) return; // 창 닫힘 = 폴링 중단
    nodeHttp.get(healthUrl, (res) => {
      res.resume();
      if (chatWin) void chatWin.loadFile(rendererIndex); // 헬스 200 → 클라 로드
    }).on('error', () => { setTimeout(probe, 2000); });
  };
```

`did-fail-load`(167–171행)의 복귀도 대기 화면으로(그대로 두되 `loadURL(waiting)` 유지 — waiting은 data: URL이라 무관):

```ts
  chatWin.webContents.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || !chatWin) return;
    void chatWin.loadURL(waiting);
    setTimeout(probe, 2000);
  });
```

> `webPreferences.preload: chat-preload.js`(135행)는 그대로 — file:// 로드에도 preload는 붙어 `window.engramDesktop.pickFolder`가 살아 있다(Task 8 FolderEmpty가 씀).

- [ ] **Step 2: `package.json` — 스크립트 + builder files**

`scripts`에 렌더러 빌드 선행 추가(교체):

```json
    "renderer:install": "npm --prefix renderer install",
    "renderer:build": "npm --prefix renderer run build",
    "desktop:dev": "npm run renderer:build && nest build && electron .",
    "desktop:build": "npm run renderer:build && nest build && electron-builder",
```

`build.files`(31–39행)에서 `"src/desktop/chat.html"` 제거, `"renderer/dist/**"` 추가:

```json
    "files": [
      "dist/**",
      "prompts/**",
      "personas/**",
      "src/desktop/assets/**",
      "src/desktop/settings.html",
      "renderer/dist/**",
      "!node_modules/@huggingface/transformers/.cache/**"
    ],
```

- [ ] **Step 3: 타입 + 빌드 확인**

Run: `npm run renderer:build` 그리고 `npx tsc --noEmit -p tsconfig.json`
Expected: `renderer/dist/index.html` 생성 / main.ts 타입 에러 없음.

- [ ] **Step 4: 수동 스모크(Electron)**

> 주의(메모리): 실사용 인스턴스와 desktop:dev는 포트 락 충돌 — dev 검증 전 설치본 상주 종료(트레이 종료) 또는 다른 포트(`ENGRAM_CHAT_PORT`).

```bash
npm run desktop:dev
```

검증:
1. 트레이 "채팅 열기" → 대기 화면 → 준비되면 React 클라 로드(연결 점 초록).
2. 채널 목록·생성·삭제·⋯메뉴(반응 모드 전환) 동작.
3. 메시지 전송 → 답 도착 전 "생각 중", 도착 시 해제. 답글 스레드(1=인라인/2+=접힘).
4. 마크다운·체크리스트·비교표·```chart``` 렌더. 외부 링크 클릭 → 기본 브라우저.
5. `/` 입력 → 팔레트, 클릭 시 입력 채움.
6. Code 탭 → code 채널 생성 → 진입 → 폴더 선택 empty state → [폴더 선택] OS 대화상자 → 헤더 `📁`, 코딩 흐름.
7. 두뇌 재시작(트레이 재시작) → 대기 화면 → 자동 복귀.

- [ ] **Step 5: 커밋**

```bash
git add src/desktop/main.ts package.json
git commit -m "feat(phase11a): Electron loadFile(renderer/dist) + 헬스 프로브 진입 + builder files/스크립트"
```

---

### Task 10: chat.html 삭제 + 전체 회귀 스윕

**Files:**
- Delete: `src/desktop/chat.html`
- Test: 두뇌 `npx jest`, 렌더러 `npm --prefix renderer test`, 타입 `npx tsc --noEmit`

**Interfaces:**
- Consumes: 전 태스크.
- Produces: 없음(정리).

- [ ] **Step 1: chat.html 삭제**

```bash
git rm src/desktop/chat.html
```

- [ ] **Step 2: 잔여 참조 스캔** — `chat.html` 문자열이 코드(문서 제외)에 남아 있지 않은지 확인

Grep: `chat\.html` in `src/` 및 `package.json`. 남으면 제거(Task 2에서 `resolveResourceFile`/`htmlPath`는 이미 정리됨 — 재확인).

- [ ] **Step 3: 두뇌 전체 테스트**

Run: `npx jest`
Expected: PASS(회귀 없음 — 특히 `self.adapter.spec.ts` 헬스 회귀, messenger 관련).

- [ ] **Step 4: 렌더러 전체 테스트 + 빌드**

Run: `npm --prefix renderer test` 그리고 `npm --prefix renderer run build`
Expected: PASS / 빌드 성공.

- [ ] **Step 5: 타입 확인**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 에러 없음.

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "chore(phase11a): chat.html 삭제 — 기능 renderer/로 이전 완료(회귀 0)"
```

---

## Self-Review

**1. 스펙 커버리지** (spec §1 구현 분할 11a 항목별):
- `renderer/` React+Vite+TS 부트 → Task 3.
- Electron `loadFile` 연결 → Task 9.
- 타입 ws 프로토콜(`protocol.ts`) → Task 1(`shared/protocol.ts`, 양쪽 참조).
- 두뇌 http 헬스+ws만(chat.html 서빙 중단) → Task 2.
- §2.5 현 기능 전부 이전: 채널 사이드바·생성·삭제·⋯메뉴(Task 6) / 자동 스레드(Task 7) / 마크다운·체크리스트·비교표·인라인강조·외부링크·SVG 차트(Task 5) / `/`팔레트·번호 클릭채움(Task 8·5) / "생각 중" 180s(Task 7) / 재연결 백오프+재동기화(Task 4·6) / 초안 유지(Task 7) / i18n·XSS(Task 5·6) / 커스텀 타이틀바+테마(Task 6 theme.css) / 모드 탭·모드별 채널·Code empty state·폴더 선택·레포 헤더(Task 6·8) → **전부 태스크 있음**.
- Electron 연동 이전(§2.6): pickFolder preload 유지·settings.html 무관·builder files → Task 9. `chat-preload.ts`는 **유지**(경로 `chat-preload.js` 그대로, file:// 로드에도 preload 부착).
- 빌드·패키징 → Task 9. 회귀 0 검증 → Task 10.

**2. 플레이스홀더 스캔**: verbatim 이전(마크다운 렌더러 Task 5, theme.css Task 6 Step 1, i18n Task 6 Step 2, COMMANDS Task 8)은 "chat.html 정확한 행 번호에서 그대로 옮김"으로 명시 — 실재 코드 지시(추측 아님). 신규 코드(훅·컴포넌트·config·main.ts diff)는 전문 기재. TODO/TBD 없음.

**3. 타입 일관성**: `Channel`/`Message`/`ClientFrame`/`ServerFrame`(Task 1)을 Task 4·5·6·7·8이 동일 이름·경로(`../../../shared/protocol` from src, `../../shared/protocol` from renderer/src)로 참조. `useWs(onFrame, onOpen)` 시그니처는 Task 4 정의 = Task 6 사용 일치. `T` 사전 키는 chat.html과 동일. `#input` id는 Task 5(번호 클릭채움)·6·8이 공유.

**회귀 0 — 미이전 없음**: chat.html의 모든 동작 기능을 옮긴다(§2.5 "빠짐없이", 안전 충돌 아닌 한 임의 축소 금지). 특히:
- 팔레트 키보드 네비(ArrowDown/Up 순환·Enter 선택·Esc·`.sel` 강조) — Task 8 `filterCommands` export + App `#input` onKeyDown으로 그대로 이전.
- `#popmenu` 좌표 계산(⋯ rect 기준·뷰포트 클램프·바깥클릭/Esc 닫힘) — Task 6 Channels `openMenu`/useEffect로 그대로 이전.
- 마크다운/차트 렌더러는 DOM 빌더 verbatim(재작성 안 함), 자동 스레드·초안·"생각 중" 180s·재연결 백오프+재동기화·i18n·테마·모드탭·폴더 empty state 전부 태스크 있음.

**11b 경계 확인**: `Message.actions`/`ActionButtons`/승인 confirm/3영역(Team/Ask/Code) 재편은 이 플랜에 **없음**(spec §1 분할대로 11b). 11a는 현행 Chat/Code 모드탭을 그대로 옮긴다.

## Execution Handoff

플랜 저장: `docs/superpowers/plans/2026-07-06-phase11a-client-foundation.md`.

**두 실행 옵션:**

**1. Subagent-Driven(권장)** — 태스크별 신규 서브에이전트 + 태스크 사이 2단 리뷰. Task 3(스캐폴딩)은 `npm install`이 필요하니 첫 실행 시 네트워크 확인.

**2. Inline Execution** — 이 세션에서 executing-plans로 배치 실행 + 체크포인트.

어느 쪽으로 갈까요?
