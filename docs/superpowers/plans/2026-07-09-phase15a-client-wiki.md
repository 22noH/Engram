# Phase 15a — 클라이언트 위키 (읽기 + 승인함) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 클라이언트에 Wiki 영역을 열어, 선택된 두뇌의 위키를 읽고(아티팩트 스타일), 그 두뇌의 지식 제안을 승인함에서 승인/거부한다.

**Architecture:** 서버(`self.adapter.ts`)가 기존 `WikiEngine`·`ProposalStore`·`ProposalApplier`(전부 무변경)를 ws 프레임으로 노출한다. 렌더러는 `mode`에 `'wiki'`를 더해 최상위 탭을 하나 늘리고, 그 모드에서 `#main`에 `WikiArea`(페이지 읽기 + 승인함)를 렌더한다. 위키는 선택된 두뇌(`defaultConnId`) 하나로 스코프하고, 승인/거부 시 브로드캐스트로 다른 접속자도 갱신된다.

**Tech Stack:** NestJS + TypeScript + `ws`(백엔드, Jest) / React 19 + Vite + TypeScript(렌더러, Vitest + Testing Library).

## Global Constraints

- **두뇌 코어·오케스트레이터·WikiEngine·ProposalStore·ProposalApplier 로직 무변경** — 기존 메서드만 ws로 노출. 신규 백엔드 메서드 없음.
- **파괴 불가**: 15a는 추가만(승인=위키 반영, 거부=제안 버림). 하드 삭제·게시된 페이지 제거·수동 편집 없음.
- **인증 게이트**: 모든 wiki/proposal 프레임은 인증 소켓만 처리(Phase 13 auth 게이트가 이미 auth 외 프레임을 막음 — 추가 처리 불필요).
- **스코프**: 위키는 선택된 두뇌(`defaultConnId`) 하나. 요청·프레임 처리 모두 그 연결로 한정.
- **네임스페이스**: 공유 위키 하나(`DEFAULT_USER`). 사용자별 분리는 Phase 16.
- **하위호환**: 위키 의존성 미주입 시 wiki/proposal 프레임 no-op. Ask/Team/Code 무변경.
- **UI 문구 영어 기본 / ko 로케일 한국어**(`i18n.ts`의 `ko` 삼항).
- 백엔드 테스트: `npx jest <path>` · 백엔드 빌드: `npm run build`
- 렌더러 테스트: `cd renderer ; npx vitest run <path>` · 렌더러 빌드: `npm run renderer:build`

## File Structure

| 파일 | 책임 | 변경 |
|------|------|------|
| `shared/protocol.ts` | ws 프레임 계약 | wiki/proposal 프레임 + `WikiPageMeta`/`WikiPageDto`/`ProposalDto` |
| `src/edge/messenger/self.adapter.ts` | ws 서버 | 위키·결재 옵셔널 주입 + 핸들러 + 브로드캐스트 |
| `src/main.ts` | 상주 부트스트랩 | `app.get(...)` → SelfMessenger에 전달 |
| `renderer/src/areas.ts` | 영역 탭 | `wiki` 탭 |
| `renderer/src/multi.ts` | 스코프 헬퍼 | mode 유니온에 `'wiki'` |
| `renderer/src/i18n.ts` | 문구 | `tabWiki` + 승인함 문구 |
| `renderer/src/components/Channels.tsx` | 사이드바 | mode 유니온 확장 + wiki 모드 채널목록 숨김 |
| `renderer/src/components/WikiArea.tsx` | (신규) 위키 화면 | 페이지 읽기 + 승인함 |
| `renderer/src/App.tsx` | 배선 | wiki 상태·프레임·요청·WikiArea 마운트 |
| `README.md` | 문서 | Wiki 영역·승인함 |

---

## Task 1: 서버 — 위키·승인함 ws 노출

**Files:**
- Modify: `shared/protocol.ts`
- Modify: `src/edge/messenger/self.adapter.ts`
- Modify: `src/main.ts`
- Test: `src/edge/messenger/self.adapter.spec.ts`

**Interfaces:**
- Produces (와이어):
  - C→S: `wikiList` / `wikiGet{slug}` / `proposalsList` / `proposalApprove{id}` / `proposalReject{id}`
  - S→C: `wikiPages{list:WikiPageMeta[]}` / `wikiPage{page:WikiPageDto}` / `proposals{list:ProposalDto[]}` / `wikiChanged` / `proposalsChanged`
- Consumes: 기존 `WikiEngine.listPages/getPage`, `ProposalStore.listPending/get`, `ProposalApplier.apply/reject`.

- [ ] **Step 1: 프레임·DTO 타입 추가 (`shared/protocol.ts`)**

기존 `ClientFrame`/`ServerFrame` 유니온에 추가하고, DTO 인터페이스를 파일에 정의:

```ts
export interface WikiPageMeta { slug: string; title: string; category: string; status: 'draft' | 'published'; updated: string }
export interface WikiPageDto extends WikiPageMeta { body: string }
export interface ProposalDto {
  id: string;
  op: 'create' | 'append' | 'supersede';
  targetSlug: string;
  title: string;
  category: string;
  payload: string;
  sources: string[];
  importance: number;
  confidence: number;
  reason: string;
  conflictSlugs?: string[];
}
```

`ClientFrame`에 추가:
```ts
  | { t: 'wikiList' }
  | { t: 'wikiGet'; slug: string }
  | { t: 'proposalsList' }
  | { t: 'proposalApprove'; id: string }
  | { t: 'proposalReject'; id: string }
```

`ServerFrame`에 추가:
```ts
  | { t: 'wikiPages'; list: WikiPageMeta[] }
  | { t: 'wikiPage'; page: WikiPageDto }
  | { t: 'proposals'; list: ProposalDto[] }
  | { t: 'wikiChanged' }
  | { t: 'proposalsChanged' }
```

- [ ] **Step 2: 실패 테스트 작성 (`self.adapter.spec.ts`)**

파일 상단에 fake 의존성 헬퍼를 추가하고 새 describe를 붙인다. `SelfMessenger` 4번째 인자로 fake를 주입한다. (파일 상단의 `fs/os/path/WebSocket/SelfMessenger/ChatStore/noLog/once/nextFrame` 재사용.)

```ts
import type { WikiPage } from '../../knowledge-core/wiki/page.types';
import type { Proposal } from '../../knowledge-core/proposal-store';

function fakePage(slug: string, status: 'draft' | 'published' = 'published'): WikiPage {
  return { slug, frontmatter: { title: `T-${slug}`, category: 'cat', status, sources: [], created: '2026-01-01T00:00:00Z', updated: '2026-01-02T00:00:00Z' }, body: `body-${slug}` };
}
function fakeProposal(id: string, status: Proposal['status'] = 'pending'): Proposal {
  return { id, userId: 'default', createdTs: '2026-01-01T00:00:00Z', op: 'create', targetSlug: `s-${id}`, title: `t-${id}`, category: 'cat', payload: `payload-${id}`, sources: ['src1'], importance: 3, verdict: { confidence: 0.8, reason: `why-${id}` }, status };
}

describe('SelfMessenger 위키·승인함', () => {
  let dir: string; let store: ChatStore; let sm: SelfMessenger; let client: WebSocket;
  let pages: WikiPage[]; let proposals: Proposal[]; let applied: string[]; let rejected: string[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-wiki-'));
    store = new ChatStore(dir); store.listChannels();
    pages = [fakePage('alpha'), fakePage('beta', 'draft')];
    proposals = [fakeProposal('p1'), fakeProposal('p2')];
    applied = []; rejected = [];
    const wikiDeps = {
      wiki: {
        listPages: async () => pages,
        getPage: async (slug: string) => pages.find((p) => p.slug === slug) ?? null,
      },
      proposals: {
        listPending: async () => proposals.filter((p) => p.status === 'pending'),
        get: async (id: string) => proposals.find((p) => p.id === id) ?? null,
      },
      applier: {
        apply: async (p: Proposal) => { applied.push(p.id); },
        reject: async (p: Proposal) => { rejected.push(p.id); },
      },
    };
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1' }, store, { logger: noLog }, wikiDeps as any);
    await sm.start();
    client = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(client, 'open');
  });
  afterEach(async () => { client.terminate(); await sm.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('wikiList → 페이지 메타 목록', async () => {
    client.send(JSON.stringify({ t: 'wikiList' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('wikiPages');
    expect(f.list).toEqual([
      { slug: 'alpha', title: 'T-alpha', category: 'cat', status: 'published', updated: '2026-01-02T00:00:00Z' },
      { slug: 'beta', title: 'T-beta', category: 'cat', status: 'draft', updated: '2026-01-02T00:00:00Z' },
    ]);
  });

  it('wikiGet → 페이지 전체(body 포함), 없으면 error', async () => {
    client.send(JSON.stringify({ t: 'wikiGet', slug: 'alpha' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('wikiPage');
    expect(f.page).toMatchObject({ slug: 'alpha', body: 'body-alpha', status: 'published' });
    client.send(JSON.stringify({ t: 'wikiGet', slug: 'nope' }));
    const e = await nextFrame(client);
    expect(e.t).toBe('error');
  });

  it('proposalsList → pending 제안 DTO', async () => {
    client.send(JSON.stringify({ t: 'proposalsList' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('proposals');
    expect(f.list).toHaveLength(2);
    expect(f.list[0]).toMatchObject({ id: 'p1', op: 'create', targetSlug: 's-p1', payload: 'payload-p1', confidence: 0.8, reason: 'why-p1', importance: 3 });
  });

  it('proposalApprove → applier.apply + wikiChanged·proposalsChanged 브로드캐스트', async () => {
    client.send(JSON.stringify({ t: 'proposalApprove', id: 'p1' }));
    const f1 = await nextFrame(client);
    const f2 = await nextFrame(client);
    expect(applied).toEqual(['p1']);
    expect([f1.t, f2.t].sort()).toEqual(['proposalsChanged', 'wikiChanged']);
  });

  it('proposalReject → applier.reject + proposalsChanged', async () => {
    client.send(JSON.stringify({ t: 'proposalReject', id: 'p2' }));
    const f = await nextFrame(client);
    expect(rejected).toEqual(['p2']);
    expect(f.t).toBe('proposalsChanged');
  });

  it('없는/처리된 제안 승인은 조용히 무시(applier 미호출)', async () => {
    proposals.push(fakeProposal('done', 'approved'));
    client.send(JSON.stringify({ t: 'proposalApprove', id: 'done' }));
    client.send(JSON.stringify({ t: 'wikiList' })); // 뒤에 온 프레임이 처리되면 앞은 무시된 것
    const f = await nextFrame(client);
    expect(f.t).toBe('wikiPages');
    expect(applied).toEqual([]);
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: FAIL — 4번째 생성자 인자·wiki 핸들러 없음.

- [ ] **Step 4: 구현 (`self.adapter.ts`)**

(a) 파일 상단에 type-only import + DTO 매퍼(파일 하단 또는 상단 헬퍼로):
```ts
import { DEFAULT_USER } from '../../pal/path-resolver';
import type { WikiEngine } from '../../knowledge-core/wiki/wiki-engine';
import type { WikiPage } from '../../knowledge-core/wiki/page.types';
import type { ProposalStore, Proposal } from '../../knowledge-core/proposal-store';
import type { ProposalApplier } from '../proposal-applier';
import type { WikiPageMeta, WikiPageDto, ProposalDto } from '../../../shared/protocol';

interface WikiDeps { wiki: WikiEngine; proposals: ProposalStore; applier: ProposalApplier }

function toPageMeta(p: WikiPage): WikiPageMeta {
  return { slug: p.slug, title: p.frontmatter.title, category: p.frontmatter.category, status: p.frontmatter.status, updated: p.frontmatter.updated };
}
function toPageDto(p: WikiPage): WikiPageDto {
  return { ...toPageMeta(p), body: p.body };
}
function toProposalDto(p: Proposal): ProposalDto {
  return { id: p.id, op: p.op, targetSlug: p.targetSlug, title: p.title, category: p.category, payload: p.payload, sources: p.sources, importance: p.importance, confidence: p.verdict.confidence, reason: p.verdict.reason, ...(p.verdict.conflictSlugs ? { conflictSlugs: p.verdict.conflictSlugs } : {}) };
}
```

(b) 생성자에 옵셔널 4번째 인자:
```ts
  constructor(
    private readonly cfg: ChatConfig,
    private readonly store: ChatStore,
    private readonly opts: { engramName?: string; logger: { warn(msg: string, ctx?: string): void } },
    private readonly wikiDeps?: WikiDeps,
  ) {}
```

(c) `handleFrame`의 `switch` 안(기존 case들과 `default` 사이)에 wiki 케이스 추가:
```ts
        case 'wikiList': {
          if (!this.wikiDeps) return;
          const list = (await this.wikiDeps.wiki.listPages()).map(toPageMeta);
          this.sendTo(ws, { t: 'wikiPages', list });
          return;
        }
        case 'wikiGet': {
          if (!this.wikiDeps || typeof f.slug !== 'string') return;
          const page = await this.wikiDeps.wiki.getPage(f.slug);
          if (!page) { this.sendTo(ws, { t: 'error', text: 'unknown page' }); return; }
          this.sendTo(ws, { t: 'wikiPage', page: toPageDto(page) });
          return;
        }
        case 'proposalsList': {
          if (!this.wikiDeps) return;
          const list = (await this.wikiDeps.proposals.listPending(DEFAULT_USER)).map(toProposalDto);
          this.sendTo(ws, { t: 'proposals', list });
          return;
        }
        case 'proposalApprove': {
          if (!this.wikiDeps || typeof f.id !== 'string') return;
          const p = await this.wikiDeps.proposals.get(f.id);
          if (!p || p.status !== 'pending') return; // 없거나 이미 처리 — 조용히 무시
          await this.wikiDeps.applier.apply(p);
          this.broadcast({ t: 'wikiChanged' });
          this.broadcast({ t: 'proposalsChanged' });
          return;
        }
        case 'proposalReject': {
          if (!this.wikiDeps || typeof f.id !== 'string') return;
          const p = await this.wikiDeps.proposals.get(f.id);
          if (!p || p.status !== 'pending') return;
          await this.wikiDeps.applier.reject(p);
          this.broadcast({ t: 'proposalsChanged' });
          return;
        }
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: PASS (신규 6건 + 기존 코어·인증 전부).

- [ ] **Step 6: main.ts 실제 주입**

`src/main.ts` — import 추가 + 생성자 4번째 인자:
```ts
import { WikiEngine } from './knowledge-core/wiki/wiki-engine';
import { ProposalStore } from './knowledge-core/proposal-store';
import { ProposalApplier } from './edge/proposal-applier';
```
```ts
    self = new SelfMessenger(chatCfg, chatStore, { logger }, {
      wiki: app.get(WikiEngine),
      proposals: app.get(ProposalStore),
      applier: app.get(ProposalApplier),
    });
```
(`ProposalApplier`가 AppModule provider인지 확인 — CLI gateway가 주입받으므로 provider임. `app.get`으로 해소된다.)

- [ ] **Step 7: 백엔드 빌드**

Run: `npm run build`
Expected: nest build exit 0(main.ts·adapter 타입 정합).

- [ ] **Step 8: 커밋**

```bash
git add shared/protocol.ts src/edge/messenger/self.adapter.ts src/edge/messenger/self.adapter.spec.ts src/main.ts
git commit -m "feat(phase15a): 위키·승인함 ws 노출 — wikiList/Get·proposalsList/Approve/Reject + 브로드캐스트"
```

---

## Task 2: 클라 — Wiki 영역 탭

**Files:**
- Modify: `renderer/src/areas.ts`
- Modify: `renderer/src/multi.ts`
- Modify: `renderer/src/i18n.ts`
- Modify: `renderer/src/components/Channels.tsx`
- Test: `renderer/src/areas.test.ts`

**Interfaces:**
- Produces: `areaTabs`가 `wiki` 포함; `mode` 유니온에 `'wiki'`; Channels가 wiki 모드에서 채널목록/새채널 숨김.

- [ ] **Step 1: 실패 테스트 작성 (`areas.test.ts`)**

기존 테스트를 아래로 교체(wiki 포함):
```ts
import { areaTabs } from './areas';

it('flag off면 Ask·Code·Wiki, on이면 Ask·Team·Code·Wiki', () => {
  expect(areaTabs(false)).toEqual(['chat', 'code', 'wiki']);
  expect(areaTabs(true)).toEqual(['chat', 'team', 'code', 'wiki']);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd renderer && npx vitest run src/areas.test.ts`
Expected: FAIL — wiki 미포함.

- [ ] **Step 3: 구현**

`renderer/src/areas.ts`:
```ts
// 3영역 + Wiki 네비 탭. Team은 flag on일 때만. Wiki는 항상.
export function areaTabs(teamChat: boolean): ('chat' | 'code' | 'team' | 'wiki')[] {
  return teamChat ? ['chat', 'team', 'code', 'wiki'] : ['chat', 'code', 'wiki'];
}
```

`renderer/src/multi.ts` — 두 헬퍼의 `mode` 유니온에 `'wiki'` 추가(동작은 non-team과 동일, wiki는 이 헬퍼를 안 쓰지만 App이 mode를 넘기므로 타입 정합 필요):
```ts
export function scopedConnections<C extends { id: string }>(
  connections: C[], mode: 'chat' | 'code' | 'team' | 'wiki', defaultConnId: string,
): C[] {
  return mode === 'team' ? connections.filter((c) => c.id === defaultConnId) : connections;
}
export function scopedChannels(
  channelsByConn: Record<string, Channel[]>, mode: 'chat' | 'code' | 'team' | 'wiki', defaultConnId: string,
): Record<string, Channel[]> {
  return mode === 'team' ? { [defaultConnId]: channelsByConn[defaultConnId] ?? [] } : channelsByConn;
}
```

`renderer/src/i18n.ts` — `T`에 추가:
```ts
  tabWiki: ko ? '위키' : 'Wiki',
```

`renderer/src/components/Channels.tsx`:
- props의 `mode`·`onSetMode`·`onCreate` 유니온에 `'wiki'` 추가.
- `label` 맵에 wiki 추가:
```ts
  const label: Record<'chat' | 'code' | 'team' | 'wiki', string> = { chat: T.tabAsk, team: T.tabTeam, code: T.tabCode, wiki: T.tabWiki };
```
- wiki 모드에선 채널 목록·새채널을 숨긴다(채널 개념 아님). `#channels`와 `#newch`를 감싼다:
```tsx
      {mode !== 'wiki' && (
        <div id="channels">
          {visible.map((c) => ( /* 기존 그대로 */ ))}
        </div>
      )}
      {/* menu 팝오버 블록은 그대로 (wiki 모드엔 visible이 비어 menu가 안 열림) */}
      {mode !== 'wiki' && (
        <div id="newch"> /* 기존 그대로 */ </div>
      )}
```
(modetabs는 그대로 두어 Wiki 탭이 보이게 한다.)

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd renderer && npx vitest run src/areas.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add renderer/src/areas.ts renderer/src/multi.ts renderer/src/i18n.ts renderer/src/components/Channels.tsx renderer/src/areas.test.ts
git commit -m "feat(phase15a): Wiki 영역 탭 개방(mode 유니온 확장·Channels wiki 모드 가드)"
```

---

## Task 3: 클라 — WikiArea 컴포넌트 (읽기 + 승인함)

**Files:**
- Create: `renderer/src/components/WikiArea.tsx`
- Test: `renderer/src/components/WikiArea.test.tsx`

**Interfaces:**
- Consumes: `WikiPageMeta`/`WikiPageDto`/`ProposalDto`(shared/protocol), `renderMarkdown`(render/markdown).
- Produces: 순수 프레젠테이션 컴포넌트:
```ts
WikiArea(props: {
  pages: WikiPageMeta[];
  openPage: WikiPageDto | null;
  proposals: ProposalDto[];
  onOpenPage: (slug: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
})
```
- 내부 상태: 하위탭(pages|inbox), 필터 문자열. body 렌더는 `renderMarkdown` ref 마운트.

- [ ] **Step 1: 실패 테스트 작성 (`WikiArea.test.tsx`)**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WikiArea } from './WikiArea';
import type { WikiPageMeta, ProposalDto } from '../../../shared/protocol';

const pages: WikiPageMeta[] = [
  { slug: 'alpha', title: 'Alpha', category: 'cat', status: 'published', updated: '2026-01-02T00:00:00Z' },
  { slug: 'beta', title: 'Beta', category: 'cat', status: 'draft', updated: '2026-01-02T00:00:00Z' },
];
const proposals: ProposalDto[] = [
  { id: 'p1', op: 'create', targetSlug: 's1', title: 'Prop One', category: 'cat', payload: 'proposed body', sources: ['src'], importance: 3, confidence: 0.8, reason: 'because' },
];

describe('WikiArea', () => {
  it('페이지 목록 렌더 + 클릭 시 onOpenPage', () => {
    const opened: string[] = [];
    render(<WikiArea pages={pages} openPage={null} proposals={[]} onOpenPage={(s) => opened.push(s)} onApprove={() => {}} onReject={() => {}} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Alpha'));
    expect(opened).toEqual(['alpha']);
  });

  it('필터가 제목으로 목록을 좁힌다', () => {
    render(<WikiArea pages={pages} openPage={null} proposals={[]} onOpenPage={() => {}} onApprove={() => {}} onReject={() => {}} />);
    const filter = screen.getByPlaceholderText(/filter|필터/i);
    fireEvent.change(filter, { target: { value: 'alph' } });
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
  });

  it('승인함 탭: 제안 카드 렌더 + 승인/거부 콜백', () => {
    const approved: string[] = []; const rejected: string[] = [];
    const { container } = render(<WikiArea pages={[]} openPage={null} proposals={proposals} onOpenPage={() => {}} onApprove={(id) => approved.push(id)} onReject={(id) => rejected.push(id)} />);
    // 승인함 하위탭으로 전환
    fireEvent.click(screen.getByText(/inbox|승인함/i));
    expect(screen.getByText('because')).toBeInTheDocument();
    fireEvent.click(screen.getByText(/approve|승인/i));
    expect(approved).toEqual(['p1']);
    fireEvent.click(screen.getByText(/reject|거부/i));
    expect(rejected).toEqual(['p1']);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd renderer && npx vitest run src/components/WikiArea.test.tsx`
Expected: FAIL — 컴포넌트 없음.

- [ ] **Step 3: 구현 (`WikiArea.tsx`)**

```tsx
import { useEffect, useRef, useState } from 'react';
import type { WikiPageMeta, WikiPageDto, ProposalDto } from '../../../shared/protocol';
import { renderMarkdown } from '../render/markdown';
import { T } from '../i18n';

// 위키 영역: ① 페이지 읽기(아티팩트 스타일) ② 승인함(두뇌 제안 승인/거부). 순수 프레젠테이션.
export function WikiArea(props: {
  pages: WikiPageMeta[];
  openPage: WikiPageDto | null;
  proposals: ProposalDto[];
  onOpenPage: (slug: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const [tab, setTab] = useState<'pages' | 'inbox'>('pages');
  const [filter, setFilter] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.replaceChildren(props.openPage ? renderMarkdown(props.openPage.body) : document.createDocumentFragment());
  }, [props.openPage]);

  const q = filter.trim().toLowerCase();
  const shown = q ? props.pages.filter((p) => p.title.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)) : props.pages;

  return (
    <div id="wikiArea">
      <div id="wikiTabs">
        <div className={'wtab' + (tab === 'pages' ? ' sel' : '')} onClick={() => setTab('pages')}>{T.wikiPages}</div>
        <div className={'wtab' + (tab === 'inbox' ? ' sel' : '')} onClick={() => setTab('inbox')}>
          {T.wikiInbox}{props.proposals.length > 0 ? ` (${props.proposals.length})` : ''}
        </div>
      </div>

      {tab === 'pages' ? (
        <div id="wikiPagesView">
          <div id="wikiList">
            <input type="text" placeholder={T.wikiFilterPh} value={filter} onChange={(e) => setFilter(e.target.value)} />
            {shown.map((p) => (
              <div key={p.slug} className={'wikiRow' + (props.openPage?.slug === p.slug ? ' sel' : '')} onClick={() => props.onOpenPage(p.slug)}>
                <span className="title">{p.title}</span>
                <span className={'badge ' + p.status}>{p.status}</span>
                <span className="cat">{p.category}</span>
              </div>
            ))}
          </div>
          <div id="wikiDoc">
            {props.openPage && <div className="docHead"><h1>{props.openPage.title}</h1><span className="cat">{props.openPage.category}</span></div>}
            <div className="docBody" ref={bodyRef} />
          </div>
        </div>
      ) : (
        <div id="wikiInbox">
          {props.proposals.length === 0 && <div className="empty">{T.wikiInboxEmpty}</div>}
          {props.proposals.map((p) => (
            <div key={p.id} className="propCard">
              <div className="propHead">
                <span className={'opBadge ' + p.op}>{p.op}</span>
                <span className="target">{p.title} · {p.targetSlug}</span>
              </div>
              <div className="propWhy">{p.reason} · {Math.round(p.confidence * 100)}%{p.conflictSlugs?.length ? ` · ⚠ ${p.conflictSlugs.join(', ')}` : ''}</div>
              <PropBody markdown={p.payload} />
              <div className="propActions">
                <button type="button" onClick={() => props.onApprove(p.id)}>{T.wikiApprove}</button>
                <button type="button" className="danger" onClick={() => props.onReject(p.id)}>{T.wikiReject}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 제안 본문 미리보기 — 검증된 마크다운 빌더 재사용(XSS 안전).
function PropBody({ markdown }: { markdown: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.replaceChildren(renderMarkdown(markdown)); }, [markdown]);
  return <div className="propBody" ref={ref} />;
}
```

`renderer/src/i18n.ts`에 문구 추가:
```ts
  wikiPages: ko ? '페이지' : 'Pages',
  wikiInbox: ko ? '승인함' : 'Inbox',
  wikiInboxEmpty: ko ? '대기 중인 제안이 없습니다' : 'No pending proposals',
  wikiFilterPh: ko ? '필터…' : 'Filter…',
  wikiApprove: ko ? '승인' : 'Approve',
  wikiReject: ko ? '거부' : 'Reject',
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd renderer && npx vitest run src/components/WikiArea.test.tsx`
Expected: PASS (신규 3건).

- [ ] **Step 5: 커밋**

```bash
git add renderer/src/components/WikiArea.tsx renderer/src/components/WikiArea.test.tsx renderer/src/i18n.ts
git commit -m "feat(phase15a): WikiArea 컴포넌트 — 페이지 읽기(아티팩트) + 승인함 카드"
```

---

## Task 4: 클라 — App 위키 배선

**Files:**
- Modify: `renderer/src/App.tsx`
- Test: `renderer/src/App.multi.test.tsx` (또는 새 `App.wiki.test.tsx`)

**Interfaces:**
- Consumes: `WikiArea`(Task 3), wiki/proposal 프레임(Task 1), `areaTabs`/mode 'wiki'(Task 2).
- Produces: wiki 모드에서 `#main`에 WikiArea 렌더; 진입 시 `wikiList`+`proposalsList` 요청(defaultConnId); open/approve/reject 프레임 전송; `wikiChanged`/`proposalsChanged` 수신 시 재요청. 전부 `defaultConnId`로 스코프.

- [ ] **Step 1: 실패 테스트 작성 (`App.multi.test.tsx`에 추가)**

기존 harness(`seedTwoConnections`/`FakeWS`/`T`) 재사용:
```ts
it('Wiki 탭 진입 시 기본 연결로 wikiList·proposalsList 요청', async () => {
  seedTwoConnections();
  render(<App />);
  const [homeWS] = FakeWS.instances;
  act(() => { homeWS.open(); });
  fireEvent.click(screen.getByText(T.tabWiki));
  await waitFor(() => {
    expect(homeWS.sent.some((s) => s.includes('"wikiList"'))).toBe(true);
    expect(homeWS.sent.some((s) => s.includes('"proposalsList"'))).toBe(true);
  });
});

it('승인함 제안 승인 시 proposalApprove 전송', async () => {
  seedTwoConnections();
  render(<App />);
  const [homeWS] = FakeWS.instances;
  act(() => { homeWS.open(); });
  fireEvent.click(screen.getByText(T.tabWiki));
  act(() => {
    homeWS.msg({ t: 'proposals', list: [{ id: 'p1', op: 'create', targetSlug: 's1', title: 'P1', category: 'c', payload: 'body', sources: [], importance: 2, confidence: 0.5, reason: 'r' }] });
  });
  fireEvent.click(screen.getByText(/inbox|승인함/i));
  fireEvent.click(screen.getByText(/approve|승인/i));
  await waitFor(() => expect(homeWS.sent.some((s) => s.includes('"proposalApprove"') && s.includes('"id":"p1"'))).toBe(true));
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd renderer && npx vitest run src/App.multi.test.tsx`
Expected: FAIL — wiki 미배선.

- [ ] **Step 3: 구현 (`App.tsx`)**

(a) import:
```ts
import { WikiArea } from './components/WikiArea';
import type { WikiPageMeta, WikiPageDto, ProposalDto } from '../../shared/protocol';
```

(b) wiki 상태(다른 useState 근처):
```ts
const [wikiPages, setWikiPages] = useState<WikiPageMeta[]>([]);
const [wikiOpen, setWikiOpen] = useState<WikiPageDto | null>(null);
const [proposals, setProposals] = useState<ProposalDto[]>([]);
```

(c) `onFrame(connId, f)`에 wiki 프레임 처리 추가(기본 연결만 — 위키는 스코프됨). `onFrame` 안, 기존 분기 뒤에:
```ts
    else if (connId === connState.defaultConnId) {
      if (f.t === 'wikiPages') setWikiPages(f.list);
      else if (f.t === 'wikiPage') setWikiOpen(f.page);
      else if (f.t === 'proposals') setProposals(f.list);
      else if (f.t === 'wikiChanged') {
        send(connState.defaultConnId, { t: 'wikiList' });
        setWikiOpen((cur) => { if (cur) send(connState.defaultConnId, { t: 'wikiGet', slug: cur.slug }); return cur; });
      }
      else if (f.t === 'proposalsChanged') send(connState.defaultConnId, { t: 'proposalsList' });
    }
```
(주의: `onFrame`이 `connState`/`send`를 클로저로 참조 — 기존 코드가 이미 그렇게 함. `send`는 `useConnections` 반환값. 위 분기를 기존 `if/else if` 사슬 끝에 붙인다. `f.t` 유니온이 넓어졌으므로 타입 정합.)

(d) wiki 모드 진입 시 요청 — mode 변경 효과에 추가하거나 별도 useEffect:
```ts
useEffect(() => {
  if (mode !== 'wiki') return;
  const id = connState.defaultConnId;
  if (!statusById[id]) return;
  send(id, { t: 'wikiList' });
  send(id, { t: 'proposalsList' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [mode, connState.defaultConnId, statusById[connState.defaultConnId]]);
```

(e) `#main` 렌더에서 wiki 모드 분기 — 기존 `currentName && mode==='code' ...` 블록 근처, 메시지/컴포저 영역을 감싸는 곳에서 wiki를 우선 처리:
```tsx
        <div id="main">
          {mode === 'wiki' ? (
            <WikiArea
              pages={wikiPages}
              openPage={wikiOpen}
              proposals={proposals}
              onOpenPage={(slug) => send(connState.defaultConnId, { t: 'wikiGet', slug })}
              onApprove={(id) => send(connState.defaultConnId, { t: 'proposalApprove', id })}
              onReject={(id) => send(connState.defaultConnId, { t: 'proposalReject', id })}
            />
          ) : (
            <>
              {/* 기존 code 헤더 / FolderEmpty / msgs / inputbar 전체를 이 안으로 */}
            </>
          )}
        </div>
```
(기존 `#main` 내부 전체[chhdr·FolderEmpty·msgs·inputbar]를 `mode !== 'wiki'` 쪽으로 옮긴다. wiki 모드에선 채널 개념이 없으므로 그 UI를 렌더하지 않는다.)

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd renderer && npx vitest run src/App.multi.test.tsx`
Expected: PASS (신규 2건).

- [ ] **Step 5: 전체 렌더러 스위트 + 빌드**

Run: `cd renderer && npx vitest run`
Expected: PASS (전체 — Ask/Team/Code 회귀 0).
Run: `npm run renderer:build`
Expected: `tsc -b` exit 0 + vite build 성공.

- [ ] **Step 6: 커밋**

```bash
git add renderer/src/App.tsx renderer/src/App.multi.test.tsx
git commit -m "feat(phase15a): App 위키 배선 — 진입 요청·프레임 수신·WikiArea 마운트·브로드캐스트 갱신"
```

---

## Task 5: 문서(README)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Wiki 안내 추가**

`README.md`의 "팀채팅 (Phase 14)" 절 뒤에 추가:

```markdown
### 위키 · 승인함 (Phase 15a)

`Wiki` 탭 = 그 서버 두뇌의 **공용 지식 위키 + 승인함**.

- **페이지**: 쌓인 지식을 목록·필터·문서로 읽는다(선택된 두뇌의 위키).
- **승인함**: 두뇌가 대화에서 뽑아 올린 지식 **제안**이 여기 뜬다. 무엇을(신규/추가/교체)·
  왜(이유·신뢰도·출처)를 보고 **승인**하면 위키에 반영, **거부**하면 버린다.
  (`engram review` CLI와 같은 결재를 클라이언트에서.)
- 실시간: 누가 승인/거부하면 그 두뇌에 접속한 다른 사람 화면도 갱신된다.
- **추가만 가능 — 파괴 불가**: 하드 삭제·게시된 페이지 제거·수동 편집은 15a에 없다
  (되돌릴 수 없는 손실 방지). 수동 편집·소유권 권한은 이후 단계.
```

- [ ] **Step 2: 커밋**

```bash
git add README.md
git commit -m "docs(phase15a): 위키·승인함 사용법"
```

---

## 완료 검증(전 태스크 후)

- [ ] 백엔드 전체: `npm test` → 녹색
- [ ] 렌더러 전체: `cd renderer && npx vitest run` → 녹색
- [ ] 빌드: `npm run build` && `npm run renderer:build` → exit 0
- [ ] 수동 스모크(선택): `npm run desktop:dev` → Wiki 탭 → 페이지 목록·문서 읽기; `engram digest`로 제안 만든 뒤 승인함에서 승인 → 위키에 반영·목록 갱신 확인.

---

## Self-Review 결과

- **스펙 커버리지**: §3.1 의존성 배선=Task1(main.ts) / §3.2 프레임=Task1 / §3.3 핸들러·브로드캐스트=Task1 / §4.1 wiki 탭·스코프=Task2+Task4 / §4.2 레이아웃(페이지+승인함)=Task3 / §4.3 데이터흐름=Task4 / §4.4 필터=Task3 / §5 README=Task5 / §6 테스트=각 태스크 TDD. 갭 없음.
- **타입 정합**: DTO(`WikiPageMeta`/`WikiPageDto`/`ProposalDto`, Task1)를 Task3·4가 소비 · 프레임 유니온(Task1)을 Task4 onFrame이 소비 · `WikiArea` props(Task3)를 Task4가 전달 · mode 'wiki'(Task2)를 Channels·App·multi가 공유. 시그니처 일치.
- **하위호환**: wiki 의존성 미주입 시 서버 no-op(Task1 테스트). 렌더러는 mode!=='wiki'에서 기존 경로 무변경(Task4 전체 스위트 회귀 확인). areaTabs만 wiki 추가(기존 Ask/Team/Code 순서·동작 유지).
- **파괴 불가**: 삭제·수동편집 프레임 없음(승인=추가, 거부=제안 버림). 스펙 §2 준수.
- **필터 주의**: `wikiList`는 메타(body 없음)라 클라 필터는 제목·카테고리 기준(스펙의 "본문 부분일치"는 body 미포함이라 제목/카테고리로 축소 — Task3에 반영, self-review로 확정).
