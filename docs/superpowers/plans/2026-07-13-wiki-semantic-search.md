# 위키 의미검색 앱 노출 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** WikiArea의 필터 박스를 의미검색창으로 승격한다 — 비면 전체 목록 브라우즈, 타이핑하면 서버 RAG 의미검색(순위+스니펫).

**Architecture:** `RagStore.search`(이미 동작)를 `PageIndexer` 포트에 노출하고 `WikiEngine.search`가 위임한다. self.adapter가 `wikiSearch{query}` ws 프레임을 받아 `wiki.search`를 호출하고 `wikiResults{query, list}`로 응답(권한 게이트 없음 — 읽기). WikiArea가 기존 필터 박스를 검색창으로 바꿔 디바운스 300ms로 검색하고 결과를 순위 순서로 렌더한다.

**Tech Stack:** TypeScript, NestJS(백엔드), LanceDB/RagStore, ws, React + Vitest(렌더러), Jest(백엔드).

## Global Constraints

- 백엔드 테스트: `npx jest <경로>`(FOREGROUND, 워치/백그라운드 금지 — 이 머신서 hang). 렌더러 테스트: `renderer/`에서 `npx vitest run <파일>`, 전체는 `npm --prefix renderer test`.
- 기존 스위트 전부 통과가 회귀 기준.
- 방식 A: 검색창이 비면 전체 `pages` 브라우즈, 비어있지 않으면 서버 의미검색. **기존 제목/카테고리 부분일치 필터는 의미검색으로 대체**(사라짐).
- 트리거 = 타이핑 중 자동, 디바운스 300ms.
- **점수(score) 숨김**: 프레임엔 실어 보내되 렌더러는 표시하지 않음. 순위(list 순서) + 스니펫만.
- **검색 = 게시(published) 페이지만**(색인 대상이 그것뿐). 브라우즈(빈 검색창)는 draft 포함 전체.
- 권한 게이트 없음(읽기 — wikiList/wikiGet과 동일). 무인증/brain 통과.
- 스코프 = defaultConnId 중앙 위키(`DEFAULT_USER`).
- `WikiEngine.search` 기본 `limit = 8`. 빈/공백 쿼리 → 빈 배열(indexer 미호출).
- UI 문구 영어 기본 + ko 로케일 한국어. 커밋 메시지 한국어, Co-Authored-By 제외.
- 응답에 `query`를 되돌려 담아 늦은 응답이 최신 검색어 결과를 덮어쓰지 않게 함(에코 대조).

---

### Task 1: PageIndexer.search 포트 + WikiEngine.search

**Files:**
- Modify: `src/knowledge-core/rag/rag.types.ts:25-29` (PageIndexer에 search 추가)
- Modify: `src/knowledge-core/wiki/wiki-engine.ts` (search 위임 메서드 — deletePage 뒤 append)
- Test: `src/knowledge-core/wiki/wiki-engine.spec.ts` (SpyIndexer.search 스텁 + WikiEngine.search 테스트)

**Interfaces:**
- Consumes: `RagStore.search(query, limit?, userId?): Promise<SearchResult[]>`(이미 구현), `SearchResult = { userId?: string; slug: string; title: string; text: string; score: number }`(rag.types).
- Produces:
  - `PageIndexer.search(query: string, limit?: number, userId?: string): Promise<SearchResult[]>` (포트 메서드).
  - `WikiEngine.search(query: string, limit = 8, userId = DEFAULT_USER): Promise<SearchResult[]>` — 빈/공백 → `[]`(indexer 미호출), indexer 미주입 → `[]`. Task 2가 `wiki.search(query)`로 호출.

- [ ] **Step 1: 포트에 search 추가**

`src/knowledge-core/rag/rag.types.ts`의 `PageIndexer` 인터페이스(현재 indexPage/removePage/reindexAll)에 한 줄 추가:

```ts
export interface PageIndexer {
  indexPage(page: IndexablePage): Promise<void>;
  removePage(slug: string, userId?: string): Promise<void>;
  reindexAll(pages: IndexablePage[]): Promise<void>;
  search(query: string, limit?: number, userId?: string): Promise<SearchResult[]>;
}
```

`SearchResult`는 이미 이 파일에 정의돼 있다(같은 파일 상단). `RagStore`는 이미 `search`를 구현하므로 구현 무변경.

- [ ] **Step 2: SpyIndexer에 search 스텁 추가 + 실패 테스트 작성**

`src/knowledge-core/wiki/wiki-engine.spec.ts`의 import 라인 `import { PageIndexer, IndexablePage } from '../rag/rag.types';`(파일 하단, 현재 line 203 부근)을 다음으로 교체(SearchResult 추가):

```ts
import { PageIndexer, IndexablePage, SearchResult } from '../rag/rag.types';
```

같은 파일의 `class SpyIndexer implements PageIndexer { … }`(현재 line 205 부근)에 검색 스텁 추가(닫는 `}` 앞):

```ts
class SpyIndexer implements PageIndexer {
  indexed: IndexablePage[] = [];
  removed: Array<{ slug: string; userId?: string }> = [];
  searchQueries: Array<{ query: string; limit?: number; userId?: string }> = [];
  searchReturn: SearchResult[] = [];
  async indexPage(p: IndexablePage) { this.indexed.push(p); }
  async removePage(slug: string, userId?: string) { this.removed.push({ slug, userId }); }
  async reindexAll(pages: IndexablePage[]) { for (const p of pages) this.indexed.push(p); }
  async search(query: string, limit?: number, userId?: string) { this.searchQueries.push({ query, limit, userId }); return this.searchReturn; }
}
```

그리고 `describe('WikiEngine + PAGE_INDEXER', …)`(spy·engine이 준비된 describe) 안, 마지막 `it` 뒤에 테스트 3개 추가:

```ts
  it('search: indexer에 위임하고 결과를 그대로 반환(limit=8·DEFAULT_USER)', async () => {
    spy.searchReturn = [{ slug: 'a', title: 'A', text: 'snip', score: 0.9 }];
    const res = await engine.search('coffee');
    expect(res).toEqual([{ slug: 'a', title: 'A', text: 'snip', score: 0.9 }]);
    expect(spy.searchQueries).toEqual([{ query: 'coffee', limit: 8, userId: DEFAULT_USER }]);
  });

  it('search: 빈/공백 쿼리는 indexer 미호출·빈 배열', async () => {
    expect(await engine.search('   ')).toEqual([]);
    expect(spy.searchQueries).toEqual([]);
  });
```

그리고 `describe('WikiEngine 파괴적 행위', …)`(makeEngine 사용, indexer 없음) 안 마지막 `it` 뒤에:

```ts
  it('search: indexer 미주입 시 빈 배열', async () => {
    const engine = await makeEngine(); // 인덱서 없음
    expect(await engine.search('coffee')).toEqual([]);
  });
```

- [ ] **Step 3: 실패 확인**

Run: `npx jest src/knowledge-core/wiki/wiki-engine.spec.ts -t "search"`
Expected: FAIL — `engine.search is not a function`.

- [ ] **Step 4: WikiEngine.search 구현**

`src/knowledge-core/wiki/wiki-engine.ts`의 `deletePage` 메서드 닫는 `}` 뒤(클래스 닫는 `}` 앞)에 append:

```ts

  // 위키 의미검색(읽기 전용 — 락·파일·커밋 없음). indexer(RagStore)에 위임.
  // 빈/공백 쿼리는 서버 왕복 없이 빈 배열. indexer 미주입(RAG 미탑재) 시에도 빈 배열.
  async search(query: string, limit = 8, userId: string = DEFAULT_USER): Promise<SearchResult[]> {
    const q = query.trim();
    if (!q) return [];
    return (await this.indexer?.search(q, limit, userId)) ?? [];
  }
```

`SearchResult` 타입 import가 필요하다. `wiki-engine.ts` 상단의 `import { IndexablePage, PageIndexer, PAGE_INDEXER } from '../rag/rag.types';`를 다음으로 교체:

```ts
import { IndexablePage, PageIndexer, PAGE_INDEXER, SearchResult } from '../rag/rag.types';
```

- [ ] **Step 5: 통과 확인**

Run: `npx jest src/knowledge-core/wiki/wiki-engine.spec.ts`
Expected: PASS(신규 3 + 기존 전부). `RagStore`는 이미 search를 구현하므로 rag-store 스위트 회귀 없음.

- [ ] **Step 6: 커밋**

```bash
git add src/knowledge-core/rag/rag.types.ts src/knowledge-core/wiki/wiki-engine.ts src/knowledge-core/wiki/wiki-engine.spec.ts
git commit -m "feat(wiki-search): PageIndexer.search 포트 + WikiEngine.search 위임"
```

---

### Task 2: 프로토콜 프레임 + self.adapter wikiSearch

**Files:**
- Modify: `shared/protocol.ts` (WikiSearchHit 인터페이스 + wikiSearch·wikiResults 프레임)
- Modify: `src/edge/messenger/self.adapter.ts` (case 'wikiSearch' — wikiGet 뒤)
- Test: `src/edge/messenger/self.adapter.spec.ts` (beforeEach 목에 search 추가 + 테스트)

**Interfaces:**
- Consumes: `WikiEngine.search`(Task 1) via `this.wikiDeps.wiki.search`.
- Produces:
  - `WikiSearchHit = { slug: string; title: string; snippet: string; score: number }`.
  - ClientFrame `{ t: 'wikiSearch'; query: string }`, ServerFrame `{ t: 'wikiResults'; query: string; list: WikiSearchHit[] }`.
  - Task 3(렌더러)가 두 프레임과 `WikiSearchHit`을 사용.

- [ ] **Step 1: 프로토콜 추가**

`shared/protocol.ts`에서 위키 관련 DTO들 근처(`WikiPageDto` 정의 뒤)에 `WikiSearchHit` 추가:

```ts
export interface WikiSearchHit { slug: string; title: string; snippet: string; score: number }
```

`ClientFrame` 유니온에 `| { t: 'wikiGet'; slug: string }` 뒤(또는 wiki 프레임 그룹 내)에 추가:

```ts
  | { t: 'wikiSearch'; query: string }
```

`ServerFrame` 유니온에 `| { t: 'wikiPage'; page: WikiPageDto }` 뒤에 추가:

```ts
  | { t: 'wikiResults'; query: string; list: WikiSearchHit[] }
```

- [ ] **Step 2: 실패 테스트 작성**

`src/edge/messenger/self.adapter.spec.ts`의 `describe('SelfMessenger 위키·승인함', …)` `beforeEach` 안 `wikiDeps.wiki` 목(현재 listPages/getPage/unpublishPage/editPage/deletePage)에 `search` 추가:

```ts
      wiki: {
        listPages: async () => pages,
        getPage: async (slug: string) => pages.find((p) => p.slug === slug) ?? null,
        unpublishPage: async (slug: string) => { unpublished.push(slug); return {} as WikiPage; },
        editPage: async (slug: string, body: string) => { edited.push({ slug, body }); return {} as WikiPage; },
        deletePage: async (slug: string) => { deleted.push(slug); return true; },
        search: async (query: string) => (query === 'coffee' ? [{ slug: 'a', title: 'Alpha', text: 'matched snippet', score: 0.9 }] : []),
      },
```

같은 describe 끝(`it('wikiDeps 미주입 …')` 앞)에 테스트 추가:

```ts
  it('wikiSearch → wikiResults(query 에코 + text→snippet 매핑)', async () => {
    client.send(JSON.stringify({ t: 'wikiSearch', query: 'coffee' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('wikiResults');
    expect(f.query).toBe('coffee');
    expect(f.list).toEqual([{ slug: 'a', title: 'Alpha', snippet: 'matched snippet', score: 0.9 }]);
  });

  it('wikiSearch 결과 없음 → 빈 list', async () => {
    client.send(JSON.stringify({ t: 'wikiSearch', query: 'nope' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('wikiResults');
    expect(f.list).toEqual([]);
  });
```

- [ ] **Step 3: 실패 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts -t "wikiSearch"`
Expected: FAIL — 프레임 미처리(default로 빠져 무응답 → nextFrame 타임아웃/불일치).

- [ ] **Step 4: self.adapter에 case 추가**

`src/edge/messenger/self.adapter.ts`의 `case 'wikiGet': { … }` 블록 닫는 `}` 뒤에 append(권한 게이트 없음 — 읽기):

```ts
        case 'wikiSearch': {
          if (!this.wikiDeps || typeof f.query !== 'string') return;
          const hits = await this.wikiDeps.wiki.search(f.query);
          const list = hits.map((h) => ({ slug: h.slug, title: h.title, snippet: h.text, score: h.score }));
          this.sendTo(ws, { t: 'wikiResults', query: f.query, list });
          return;
        }
```

- [ ] **Step 5: 통과 확인**

Run: `npx jest src/edge/messenger/self.adapter.spec.ts`
Expected: PASS(신규 2 + 기존 전부).

- [ ] **Step 6: 커밋**

```bash
git add shared/protocol.ts src/edge/messenger/self.adapter.ts src/edge/messenger/self.adapter.spec.ts
git commit -m "feat(wiki-search): ws wikiSearch·wikiResults 프레임(게이트 없음·query 에코)"
```

---

### Task 3: 렌더러 — WikiArea 검색창 + App 배선 + i18n

**Files:**
- Modify: `renderer/src/i18n.ts` (wikiSearchPh·wikiNoResults)
- Modify: `renderer/src/components/WikiArea.tsx` (필터 박스를 검색창으로 승격)
- Modify: `renderer/src/App.tsx` (wikiResults 상태·프레임·에코 대조·onSearch 배선)
- Test: `renderer/src/components/WikiArea.test.tsx`

**Interfaces:**
- Consumes: `WikiSearchHit`(Task 2), 프레임 `wikiSearch`/`wikiResults`, `send`/`allow`(기존).
- Produces: WikiArea props += `searchResults: WikiSearchHit[]`, `onSearch: (query: string) => void`.

- [ ] **Step 1: i18n 문구 추가**

`renderer/src/i18n.ts`의 `wikiFilterPh: …`(현재 line 42) 뒤에 append:

```ts
  wikiSearchPh: ko ? '위키 검색…' : 'Search wiki…',
  wikiNoResults: ko ? '결과 없음' : 'No results',
```

- [ ] **Step 2: 실패 테스트 작성/수정**

`renderer/src/components/WikiArea.test.tsx`를 세 곳 수정한다.

**(a)** `noActions` 상수(현재 line 14)에 새 필수 props 2개 추가:

```ts
const noActions = { canUnpublish: false, canEdit: false, canDelete: false, onUnpublish: () => {}, onEdit: () => {}, onDelete: () => {}, searchResults: [], onSearch: () => {} };
```

**(b)** `renderDoc` 헬퍼(현재 line 62-72)의 기본 props에도 추가 — `onUnpublish={noop} onEdit={noop} onDelete={noop}` 줄 뒤에 한 줄:

```tsx
        onUnpublish={noop} onEdit={noop} onDelete={noop}
        searchResults={[]} onSearch={noop}
```

**(c)** 기존 "필터가 제목으로 목록을 좁힌다" 테스트(현재 line 25-31)를 **삭제하고** 아래 검색 테스트들로 교체(방식 A: 클라 부분일치 필터는 사라지고 서버 의미검색이 대신함). `vi`, `act` import가 필요하니 파일 상단 import를 다음으로 교체:

```ts
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
```

교체할 테스트 블록:

```tsx
  it('검색창이 비면 전체 목록을 브라우즈한다', () => {
    render(<WikiArea pages={pages} openPage={null} proposals={[]} canApprove={true} {...noActions} onOpenPage={() => {}} onApprove={() => {}} onReject={() => {}} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('타이핑하면 디바운스(300ms) 후 onSearch(query) 호출', () => {
    vi.useFakeTimers();
    const searched: string[] = [];
    render(<WikiArea pages={pages} openPage={null} proposals={[]} canApprove={true} {...noActions} onOpenPage={() => {}} onApprove={() => {}} onReject={() => {}} onSearch={(q) => searched.push(q)} />);
    fireEvent.change(screen.getByPlaceholderText(/search|검색/i), { target: { value: 'coffee' } });
    expect(searched).toEqual([]); // 아직 디바운스 전
    act(() => { vi.advanceTimersByTime(300); });
    expect(searched).toEqual(['coffee']);
    vi.useRealTimers();
  });

  it('검색어 있으면 searchResults를 결과 행(제목+스니펫, score 미표시)으로 렌더', () => {
    const hits = [{ slug: 'x', title: 'Xanadu', snippet: 'matched snippet text', score: 0.9 }];
    const opened: string[] = [];
    render(<WikiArea pages={pages} openPage={null} proposals={[]} canApprove={true} {...noActions} searchResults={hits} onOpenPage={(s) => opened.push(s)} onApprove={() => {}} onReject={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/search|검색/i), { target: { value: 'coffee' } });
    expect(screen.getByText('Xanadu')).toBeInTheDocument();
    expect(screen.getByText('matched snippet text')).toBeInTheDocument();
    expect(screen.queryByText('0.9')).toBeNull(); // score 미표시
    expect(screen.queryByText('Alpha')).toBeNull(); // 브라우즈 목록 아님
    fireEvent.click(screen.getByText('Xanadu'));
    expect(opened).toEqual(['x']);
  });

  it('검색어 있고 결과 없으면 "결과 없음"', () => {
    render(<WikiArea pages={pages} openPage={null} proposals={[]} canApprove={true} {...noActions} searchResults={[]} onOpenPage={() => {}} onApprove={() => {}} onReject={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/search|검색/i), { target: { value: 'zzz' } });
    expect(screen.getByText(/no results|결과 없음/i)).toBeInTheDocument();
  });
```

- [ ] **Step 3: 실패 확인**

Run(`renderer/`에서): `npx vitest run src/components/WikiArea.test.tsx`
Expected: FAIL — WikiArea에 `searchResults`/`onSearch` props 없음(타입), placeholder 미변경, 검색 렌더 미구현.

- [ ] **Step 4: WikiArea 구현**

`renderer/src/components/WikiArea.tsx` 전체를 교체:

```tsx
import { useEffect, useRef, useState } from 'react';
import type { WikiPageMeta, WikiPageDto, ProposalDto, WikiSearchHit } from '../../../shared/protocol';
import { renderMarkdown } from '../render/markdown';
import { T } from '../i18n';

// 위키 영역: ① 페이지 읽기·의미검색(+게시 페이지 파괴적 행위) ② 승인함(두뇌 제안 승인/거부). 순수 프레젠테이션.
export function WikiArea(props: {
  pages: WikiPageMeta[];
  openPage: WikiPageDto | null;
  proposals: ProposalDto[];
  searchResults: WikiSearchHit[];
  canApprove: boolean;
  canUnpublish: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onOpenPage: (slug: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onUnpublish: (slug: string) => void;
  onEdit: (slug: string, body: string) => void;
  onDelete: (slug: string) => void;
  onSearch: (query: string) => void;
}) {
  const [tab, setTab] = useState<'pages' | 'inbox'>('pages');
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  // onSearch의 최신 참조(App이 매 렌더 새 콜백을 넘겨도 디바운스 effect를 재실행하지 않기 위함 — App의 ref 패턴).
  const onSearchRef = useRef(props.onSearch); onSearchRef.current = props.onSearch;

  // 다른 페이지로 전환하면 편집 모드 해제.
  useEffect(() => { setEditing(false); }, [props.openPage?.slug]);

  useEffect(() => {
    if (editing) return; // 편집 중엔 docBody 미마운트
    const el = bodyRef.current;
    if (el) el.replaceChildren(props.openPage ? renderMarkdown(props.openPage.body) : document.createDocumentFragment());
  }, [props.openPage, editing]);

  // 검색어 디바운스(300ms) → 서버 의미검색. 빈 쿼리면 검색 안 함(브라우즈 모드).
  useEffect(() => {
    const query = filter.trim();
    if (!query) return;
    const id = setTimeout(() => onSearchRef.current(query), 300);
    return () => clearTimeout(id);
  }, [filter]);

  const q = filter.trim();
  const open = props.openPage;
  const canAct = !!open && open.status === 'published'; // 게시 페이지만 대상

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
            <input type="text" placeholder={T.wikiSearchPh} value={filter} onChange={(e) => setFilter(e.target.value)} />
            {q === '' ? (
              props.pages.map((p) => (
                <div key={p.slug} className={'wikiRow' + (open?.slug === p.slug ? ' sel' : '')} onClick={() => props.onOpenPage(p.slug)}>
                  <span className="title">{p.title}</span>
                  <span className={'badge ' + p.status}>{p.status}</span>
                  <span className="cat">{p.category}</span>
                </div>
              ))
            ) : props.searchResults.length === 0 ? (
              <div className="empty">{T.wikiNoResults}</div>
            ) : (
              props.searchResults.map((h) => (
                <div key={h.slug} className={'wikiRow' + (open?.slug === h.slug ? ' sel' : '')} onClick={() => props.onOpenPage(h.slug)}>
                  <span className="title">{h.title}</span>
                  <span className="snippet">{h.snippet}</span>
                </div>
              ))
            )}
          </div>
          <div id="wikiDoc">
            {open && (
              <div className="docHead">
                <h1>{open.title}</h1>
                <span className="cat">{open.category}</span>
                {canAct && !editing && (
                  <span className="docActions">
                    {props.canEdit && <button type="button" onClick={() => { setDraft(open.body); setEditing(true); }}>{T.wikiEdit}</button>}
                    {props.canUnpublish && <button type="button" onClick={() => props.onUnpublish(open.slug)}>{T.wikiUnpublish}</button>}
                    {props.canDelete && <button type="button" className="danger" onClick={() => { if (window.confirm(T.wikiDeleteConfirm)) props.onDelete(open.slug); }}>{T.wikiDelete}</button>}
                  </span>
                )}
              </div>
            )}
            {editing && open ? (
              <div className="docEdit">
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
                <div className="docEditActions">
                  <button type="button" onClick={() => { props.onEdit(open.slug, draft); setEditing(false); }}>{T.wikiSave}</button>
                  <button type="button" onClick={() => setEditing(false)}>{T.wikiCancel}</button>
                </div>
              </div>
            ) : (
              <div className="docBody" ref={bodyRef} />
            )}
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
              <div className="propWhy">
                <span className="reason">{p.reason}</span>
                {` · ${Math.round(p.confidence * 100)}%`}
                {p.conflictSlugs?.length ? ` · ⚠ ${p.conflictSlugs.join(', ')}` : ''}
              </div>
              <PropBody markdown={p.payload} />
              {props.canApprove && (
                <div className="propActions">
                  <button type="button" onClick={() => props.onApprove(p.id)}>{T.wikiApprove}</button>
                  <button type="button" className="danger" onClick={() => props.onReject(p.id)}>{T.wikiReject}</button>
                </div>
              )}
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

- [ ] **Step 5: App 배선**

`renderer/src/App.tsx`를 세 곳 수정.

**(a)** protocol import에 `WikiSearchHit` 추가. 현재 `import type { WikiPageMeta, WikiPageDto, ProposalDto, AdminUserDto, AdminSettings } from '../../shared/protocol';`를:

```ts
import type { WikiPageMeta, WikiPageDto, ProposalDto, WikiSearchHit, AdminUserDto, AdminSettings } from '../../shared/protocol';
```

**(b)** wiki 상태 근처(`const [proposals, setProposals] = …` 뒤)에 상태·ref 추가:

```ts
  const [wikiResults, setWikiResults] = useState<WikiSearchHit[]>([]);
```

그리고 ref 그룹(`const wikiOpenRef = …` 뒤)에:

```ts
  const wikiQueryRef = useRef(''); // 현재 검색어(늦은 wikiResults 응답 에코 대조용)
```

**(c)** 프레임 핸들러의 defaultConnId 블록에서 `else if (f.t === 'wikiPage') setWikiOpen(f.page);` 뒤에:

```ts
      else if (f.t === 'wikiResults') { if (f.query === wikiQueryRef.current) setWikiResults(f.list); }
```

**(d)** `<WikiArea …>` 블록에 두 props 추가(`onOpenPage=…` 근처):

```tsx
              searchResults={wikiResults}
              onSearch={(query) => { wikiQueryRef.current = query; send(connState.defaultConnId, { t: 'wikiSearch', query }); }}
```

- [ ] **Step 6: 통과 확인**

Run(`renderer/`에서): `npx vitest run src/components/WikiArea.test.tsx` 후 전체 `npm --prefix renderer test`
Expected: PASS(신규 검색 테스트 + 기존 WikiArea/AdminArea 등 전부).

- [ ] **Step 7: 렌더러 타입/빌드 확인**

Run(`renderer/`에서): `npx tsc -b`
Expected: `No errors found`(WikiArea·App 새 props 타입 정합).

- [ ] **Step 8: 커밋**

```bash
git add renderer/src/i18n.ts renderer/src/components/WikiArea.tsx renderer/src/App.tsx renderer/src/components/WikiArea.test.tsx
git commit -m "feat(wiki-search): WikiArea 검색창 승격(디바운스 의미검색·스니펫) + App 배선 + i18n"
```

---

### Task 4: 전체 회귀 + 타입/빌드 검증

**Files:** 없음(검증만)

**Interfaces:** Consumes: 전 Task.

- [ ] **Step 1: 백엔드 전체 스위트**

Run: `npm test`
Expected: PASS(기존 + 신규 전부). 실패 시 해당 Task로 복귀.

- [ ] **Step 2: 렌더러 전체 스위트**

Run: `npm --prefix renderer test`
Expected: PASS.

- [ ] **Step 3: 타입/빌드**

Run: `npm run build && npm --prefix renderer run build`
Expected: nest/tsc/vite 모두 에러 0.

---

## Self-Review

**Spec coverage:**
- §2.1 PageIndexer.search 포트 확장 → Task 1 Step 1. ✅
- §2.2 WikiEngine.search(위임·빈쿼리·미주입) → Task 1 Step 4 + 테스트. ✅
- §2.3 프로토콜 WikiSearchHit·wikiSearch·wikiResults·query 에코 → Task 2 Step 1. ✅
- §2.4 self.adapter wikiSearch(게이트 없음·text→snippet) → Task 2 Step 4. ✅
- §3.1 WikiArea 검색창(빈=브라우즈·타이핑=결과·디바운스·score 미표시·자체 게이트) → Task 3 Step 4. ✅
- §3.2 App(wikiResults 상태·에코 대조·onSearch 배선) → Task 3 Step 5. ✅
- §3.3 i18n(wikiSearchPh·wikiNoResults) → Task 3 Step 1. ✅
- §4 하위호환(RAG 미탑재 빈배열·무인증 통과·기존 필터 대체·늦은응답 무시) → Task 1(미주입 []), Task 2(게이트 없음), Task 3(필터 교체·에코). ✅
- §5 테스트 전략 전 항목 → 각 Task 테스트. ✅

**Placeholder scan:** "적절한 처리"류 없음 — 모든 코드 스텝에 완전한 코드·명령·기대. ✅

**Type consistency:**
- `WikiEngine.search(query, limit=8, userId=DEFAULT_USER): Promise<SearchResult[]>` — Task 1 정의, Task 2에서 `wiki.search(f.query)`로 호출(limit 생략=8). ✅
- `SearchResult = {userId?, slug, title, text, score}` — Task 1 위임, Task 2가 `text→snippet` 매핑. ✅
- `WikiSearchHit = {slug, title, snippet, score}` — Task 2 protocol 정의, self.adapter 매핑·WikiArea/App 소비 동일. ✅
- 프레임 `wikiSearch{query}`·`wikiResults{query,list}` — protocol·self.adapter·App 철자 동일. ✅
- WikiArea props `searchResults`/`onSearch` — 컴포넌트·App·테스트(noActions·renderDoc) 동일. ✅

**주의(구현자용):** Task 3에서 기존 "필터가 제목으로 목록을 좁힌다" 테스트는 **삭제 후 교체**한다(방식 A가 클라 부분일치 필터를 제거하므로 이 테스트는 더 이상 유효하지 않음 — 남기면 실패). 그리고 `noActions` 상수와 `renderDoc` 기본 props 양쪽에 `searchResults`/`onSearch`를 추가해야 기존 5개 렌더 호출이 컴파일된다.
