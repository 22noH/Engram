# Phase 0 Part 2 — RagStore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 위키 published 페이지를 로컬 임베딩으로 색인해 BM25+벡터 하이브리드 검색을 제공하고, 위키 쓰기와 RAG 재색인을 묶는다.

**Architecture:** `IEmbedder` 포트 뒤에 transformers.js(bge-m3)를 숨기고, LanceDB(`runtime/rag/`)에 청크를 멱등 색인한다. 하이브리드 검색은 LanceDB 네이티브(FTS BM25 + 벡터, RRF). 동기화는 WikiEngine이 선택적 `PAGE_INDEXER` 포트를 동기 호출(주경로) + chokidar 워처(보조).

**Tech Stack:** Node 22+, TypeScript, NestJS 11, `@lancedb/lancedb`, `@huggingface/transformers`, `chokidar`, `apache-arrow`, Jest.

**설계 기준선:** `docs/superpowers/specs/2026-06-22-phase0-ragstore-design.md`

## Global Constraints

- 런타임: Node.js 22+, TypeScript, NestJS 11 (기존 `package.json` 유지).
- 셸은 **PowerShell** 사용 — 이 머신은 Bash 도구가 rtk 훅으로 깨짐. 명령의 `&&` 체이닝은 `;` 또는 `if ($?) { }`로.
- 코드 주석은 **한국어** (Part 1 관행 계승).
- 색인 대상은 **published 페이지만** (설계 §6 진실원 원칙).
- 색인은 **멱등 upsert** (페이지의 기존 청크 삭제 후 재삽입) — 주경로·워처가 겹쳐도 안전.
- 임베딩 모델은 **`IEmbedder` 포트 뒤에 격리** — 테스트는 `FakeEmbedder`, 운영은 `TransformersEmbedder`.
- 모든 spec은 임시 디렉토리를 만들고 `afterAll`/`afterEach`로 정리 (Part 1 관행).
- LanceDB는 단일 라이터 — RagStore 내부 **직렬 큐**로 쓰기 직렬화. 진짜 락은 Part 3 이월.
- 외부 API(LanceDB/transformers.js)의 정확한 호출 형태는 각 태스크에서 **실제 실행으로 검증** 후 확정 (context7로 현행 확인).

**파일 구조 (생성):**

```
src/knowledge-core/rag/
 ├ embedder.port.ts          # IEmbedder 포트 + EMBEDDER 토큰
 ├ fake-embedder.ts          # 결정론적 테스트 어댑터
 ├ transformers-embedder.ts  # bge-m3 운영 어댑터
 ├ chunker.ts                # 본문 → 청크[]
 ├ rag.types.ts              # IndexablePage, SearchResult, PageIndexer 포트
 ├ rag-store.ts              # LanceDB: init/index/remove/reindex/search
 ├ wiki-watcher.ts           # chokidar 보조 재색인
 └ *.spec.ts                 # 각 단위테스트
```

**파일 구조 (수정):**
- `src/pal/path-resolver.ts` — `getRagDir()` 추가
- `src/knowledge-core/wiki/wiki-engine.ts` — 선택적 `PAGE_INDEXER` 주입 + published 시 색인 호출
- `src/knowledge-core/knowledge-core.module.ts` — RAG provider 와이어링 + onModuleInit 전체 재색인·워처 시작

---

## Task 1: RAG 데이터 경로 + 의존성 설치

**Files:**
- Modify: `src/pal/path-resolver.ts`
- Test: `src/pal/path-resolver.spec.ts`

**Interfaces:**
- Produces: `PathResolver.getRagDir(): string` → `<dataDir>/rag`

- [ ] **Step 1: 의존성 설치**

PowerShell에서:
```
npm install @lancedb/lancedb @huggingface/transformers chokidar apache-arrow
```
설치 후 `package.json` dependencies에 4개가 추가됐는지 확인. (`apache-arrow` 버전은 `@lancedb/lancedb`가 요구하는 것과 일치해야 함 — peer 경고가 나오면 lancedb가 명시한 버전으로 맞춘다.)

- [ ] **Step 2: 실패하는 테스트 작성**

`src/pal/path-resolver.spec.ts`의 기존 describe에 추가:
```ts
it('getRagDir는 dataDir 아래 rag 경로를 반환한다', () => {
  const paths = new PathResolver(path.join('C:', 'tmp', 'engram-test'));
  expect(paths.getRagDir()).toBe(path.join('C:', 'tmp', 'engram-test', 'rag'));
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx jest src/pal/path-resolver.spec.ts -t "getRagDir"`
Expected: FAIL — `getRagDir is not a function`

- [ ] **Step 4: 구현**

`src/pal/path-resolver.ts`에 `getWikiDir` 옆에 추가:
```ts
  // RAG 벡터 저장소(LanceDB) 루트.
  getRagDir(): string {
    return path.join(this.dataDir, 'rag');
  }
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx jest src/pal/path-resolver.spec.ts`
Expected: PASS (기존 테스트 포함 전부)

- [ ] **Step 6: 커밋**

```
git add package.json package-lock.json src/pal/path-resolver.ts src/pal/path-resolver.spec.ts
git commit -m "feat(rag): add getRagDir and RAG dependencies"
```

---

## Task 2: IEmbedder 포트 + FakeEmbedder

**Files:**
- Create: `src/knowledge-core/rag/embedder.port.ts`
- Create: `src/knowledge-core/rag/fake-embedder.ts`
- Test: `src/knowledge-core/rag/fake-embedder.spec.ts`

**Interfaces:**
- Produces:
  - `EMBEDDER: symbol` (DI 토큰)
  - `interface IEmbedder { readonly dimensions: number; embed(texts: string[]): Promise<number[][]> }`
  - `class FakeEmbedder implements IEmbedder` (`dimensions = 64`)

- [ ] **Step 1: 포트 정의**

`src/knowledge-core/rag/embedder.port.ts`:
```ts
// 임베딩 어댑터 포트(설계 §7.6). 운영=transformers.js, 테스트=FakeEmbedder.
export const EMBEDDER = Symbol('EMBEDDER');

export interface IEmbedder {
  // 임베딩 벡터 차원. LanceDB 스키마의 vector 필드 크기를 결정한다.
  readonly dimensions: number;
  // 텍스트 배열을 같은 순서의 벡터 배열로 변환한다.
  embed(texts: string[]): Promise<number[][]>;
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`src/knowledge-core/rag/fake-embedder.spec.ts`:
```ts
import { FakeEmbedder } from './fake-embedder';

describe('FakeEmbedder', () => {
  const embedder = new FakeEmbedder();

  it('같은 텍스트는 같은 벡터를 낸다(결정론적)', async () => {
    const [a] = await embedder.embed(['엔그램']);
    const [b] = await embedder.embed(['엔그램']);
    expect(a).toEqual(b);
  });

  it('다른 텍스트는 다른 벡터를 낸다', async () => {
    const [a] = await embedder.embed(['엔그램']);
    const [b] = await embedder.embed(['위키']);
    expect(a).not.toEqual(b);
  });

  it('차원이 dimensions와 일치하고 L2 정규화된다', async () => {
    const [v] = await embedder.embed(['hello world']);
    expect(v).toHaveLength(embedder.dimensions);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx jest src/knowledge-core/rag/fake-embedder.spec.ts`
Expected: FAIL — cannot find `./fake-embedder`

- [ ] **Step 4: 구현**

`src/knowledge-core/rag/fake-embedder.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { IEmbedder } from './embedder.port';

// 결정론적 가짜 임베더. 네트워크·모델 다운로드 없이 단위테스트에 쓴다.
// 문자 코드로 버킷을 채운 뒤 L2 정규화 — 실제 임베더(normalize:true)의 단위벡터를 모방.
@Injectable()
export class FakeEmbedder implements IEmbedder {
  readonly dimensions = 64;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vectorize(t));
  }

  private vectorize(text: string): number[] {
    const v = new Array(this.dimensions).fill(0);
    for (let i = 0; i < text.length; i++) {
      v[text.charCodeAt(i) % this.dimensions] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx jest src/knowledge-core/rag/fake-embedder.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: 커밋**

```
git add src/knowledge-core/rag/embedder.port.ts src/knowledge-core/rag/fake-embedder.ts src/knowledge-core/rag/fake-embedder.spec.ts
git commit -m "feat(rag): add IEmbedder port and FakeEmbedder"
```

---

## Task 3: Chunker

**Files:**
- Create: `src/knowledge-core/rag/chunker.ts`
- Test: `src/knowledge-core/rag/chunker.spec.ts`

**Interfaces:**
- Produces: `chunkBody(body: string, maxChars?: number): string[]`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/knowledge-core/rag/chunker.spec.ts`:
```ts
import { chunkBody } from './chunker';

describe('chunkBody', () => {
  it('빈 본문은 빈 배열', () => {
    expect(chunkBody('   \n  ')).toEqual([]);
  });

  it('짧은 본문은 1청크', () => {
    expect(chunkBody('한 문단입니다.')).toEqual(['한 문단입니다.']);
  });

  it('문단(빈 줄)을 maxChars 한도로 누적해 나눈다', () => {
    const p = 'x'.repeat(80);
    const body = [p, p, p].join('\n\n'); // 3문단 × 80자
    const chunks = chunkBody(body, 100); // 한도 100 → 문단당 1청크 근처
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 100 || !c.includes('\n\n'))).toBe(true);
  });

  it('여러 짧은 문단은 한 청크로 합쳐진다', () => {
    const chunks = chunkBody('가\n\n나\n\n다', 100);
    expect(chunks).toEqual(['가\n\n나\n\n다']);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/knowledge-core/rag/chunker.spec.ts`
Expected: FAIL — cannot find `./chunker`

- [ ] **Step 3: 구현**

`src/knowledge-core/rag/chunker.ts`:
```ts
// 위키 본문을 검색 단위(청크)로 나눈다.
// 문단(빈 줄) 경계를 유지하며 maxChars 한도까지 누적한다.
// 마크다운 헤딩도 보통 빈 줄로 구분되므로 별도 헤딩 파싱은 하지 않는다(YAGNI).
const DEFAULT_MAX_CHARS = 1200;

export function chunkBody(body: string, maxChars = DEFAULT_MAX_CHARS): string[] {
  const trimmed = body.trim();
  if (!trimmed) return [];

  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';
  for (const p of paragraphs) {
    if (current && current.length + p.length + 2 > maxChars) {
      chunks.push(current);
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/knowledge-core/rag/chunker.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```
git add src/knowledge-core/rag/chunker.ts src/knowledge-core/rag/chunker.spec.ts
git commit -m "feat(rag): add paragraph-based chunker"
```

---

## Task 4: rag.types.ts — 공유 타입과 포트

**Files:**
- Create: `src/knowledge-core/rag/rag.types.ts`

**Interfaces:**
- Produces:
  - `interface IndexablePage { slug; title; category; sources: string[]; body }`
  - `interface SearchResult { slug; title; text; score }`
  - `PAGE_INDEXER: symbol`
  - `interface PageIndexer { indexPage(page: IndexablePage): Promise<void>; removePage(slug: string): Promise<void> }`

- [ ] **Step 1: 타입 정의 (타입 전용이라 별도 테스트 없음 — Task 5에서 소비하며 검증)**

`src/knowledge-core/rag/rag.types.ts`:
```ts
// RagStore와 소비자(WikiEngine, 워처) 사이의 공유 계약.
// WikiPage 전체에 의존하지 않도록 색인에 필요한 필드만 추린 평탄 타입을 쓴다(결합 약화).

export interface IndexablePage {
  slug: string;
  title: string;
  category: string;
  sources: string[];
  body: string;
}

export interface SearchResult {
  slug: string;
  title: string;
  text: string; // 매칭된 청크 본문
  score: number; // RRF 융합 점수
}

// WikiEngine → RagStore 단방향 결합을 약화시키는 포트.
// WikiEngine은 이 토큰을 @Optional로 주입받아, 없으면 색인을 건너뛴다(Part 1 호환).
export const PAGE_INDEXER = Symbol('PAGE_INDEXER');

export interface PageIndexer {
  indexPage(page: IndexablePage): Promise<void>;
  removePage(slug: string): Promise<void>;
}
```

- [ ] **Step 2: 컴파일 확인**

Run: `npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 3: 커밋**

```
git add src/knowledge-core/rag/rag.types.ts
git commit -m "feat(rag): add shared rag types and PageIndexer port"
```

---

## Task 5: RagStore — LanceDB 색인·검색 (핵심)

**Files:**
- Create: `src/knowledge-core/rag/rag-store.ts`
- Test: `src/knowledge-core/rag/rag-store.spec.ts`

**Interfaces:**
- Consumes: `IEmbedder`/`EMBEDDER` (Task 2), `chunkBody` (Task 3), `IndexablePage`/`SearchResult`/`PageIndexer` (Task 4), `PathResolver.getRagDir` (Task 1)
- Produces: `class RagStore implements PageIndexer` with
  - `init(): Promise<void>`
  - `indexPage(page: IndexablePage): Promise<void>`
  - `removePage(slug: string): Promise<void>`
  - `reindexAll(pages: IndexablePage[]): Promise<void>`
  - `search(query: string, limit?: number): Promise<SearchResult[]>`

> **구현 주의 (실행으로 확정):** ① FTS 인덱스를 빈 테이블에 생성할 수 있는지 — 안 되면 첫 `add` 직후 1회 생성(`ftsReady` 플래그)으로 옮긴다. ② 하이브리드 결과의 점수 필드명(`_relevance_score` 또는 `_distance`/`_score`) — 실제 행을 `console.log`로 한 번 찍어 확정. ③ `delete` 술어 문자열 형식. 모두 context7 `/lancedb/lancedb`로 현행 확인.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/knowledge-core/rag/rag-store.spec.ts`:
```ts
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { RagStore } from './rag-store';
import { FakeEmbedder } from './fake-embedder';
import { PathResolver } from '../../pal/path-resolver';
import { IndexablePage } from './rag.types';

function page(slug: string, body: string, title = slug): IndexablePage {
  return { slug, title, category: 'test', sources: ['대화'], body };
}

describe('RagStore', () => {
  let dir: string;
  let store: RagStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-rag-'));
    store = new RagStore(new PathResolver(dir), new FakeEmbedder());
    await store.init();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('색인한 페이지를 검색으로 찾는다', async () => {
    await store.indexPage(page('alpha', 'LanceDB 하이브리드 검색 노트'));
    const results = await store.search('하이브리드 검색');
    expect(results.map((r) => r.slug)).toContain('alpha');
  });

  it('같은 페이지를 두 번 색인해도 청크가 중복되지 않는다(멱등)', async () => {
    await store.indexPage(page('beta', '문단 하나'));
    await store.indexPage(page('beta', '문단 하나'));
    const results = await store.search('문단', 50);
    expect(results.filter((r) => r.slug === 'beta')).toHaveLength(1);
  });

  it('removePage 후에는 검색되지 않는다', async () => {
    await store.indexPage(page('gamma', '지울 내용'));
    await store.removePage('gamma');
    const results = await store.search('지울 내용', 50);
    expect(results.map((r) => r.slug)).not.toContain('gamma');
  });

  it('reindexAll로 여러 페이지를 한 번에 색인한다', async () => {
    await store.reindexAll([page('p1', '첫째 글'), page('p2', '둘째 글')]);
    const results = await store.search('글', 50);
    const slugs = results.map((r) => r.slug);
    expect(slugs).toEqual(expect.arrayContaining(['p1', 'p2']));
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/knowledge-core/rag/rag-store.spec.ts`
Expected: FAIL — cannot find `./rag-store`

- [ ] **Step 3: 구현**

`src/knowledge-core/rag/rag-store.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import * as lancedb from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Int32, List, Schema, Utf8 } from 'apache-arrow';
import { PathResolver } from '../../pal/path-resolver';
import { EMBEDDER, IEmbedder } from './embedder.port';
import { chunkBody } from './chunker';
import { IndexablePage, PageIndexer, SearchResult } from './rag.types';

const TABLE = 'chunks';

// SQL 술어용 문자열 이스케이프(작은따옴표 이중화).
const sql = (s: string): string => `'${s.replace(/'/g, "''")}'`;

// 위키 published 페이지를 LanceDB에 멱등 색인하고 하이브리드 검색을 제공한다(설계 §5.2).
@Injectable()
export class RagStore implements PageIndexer {
  private db!: lancedb.Connection;
  private table!: lancedb.Table;
  private reranker!: Awaited<ReturnType<typeof lancedb.rerankers.RRFReranker.create>>;
  private ftsReady = false;
  // LanceDB 단일 라이터 — 쓰기를 직렬화한다(진짜 락은 Part 3).
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly paths: PathResolver,
    @Inject(EMBEDDER) private readonly embedder: IEmbedder,
  ) {}

  async init(): Promise<void> {
    this.db = await lancedb.connect(this.paths.getRagDir());
    const names = await this.db.tableNames();
    if (names.includes(TABLE)) {
      this.table = await this.db.openTable(TABLE);
      this.ftsReady = true; // 기존 테이블엔 인덱스가 있다고 가정
    } else {
      this.table = await this.db.createEmptyTable(TABLE, this.schema());
    }
    this.reranker = await lancedb.rerankers.RRFReranker.create();
  }

  private schema(): Schema {
    return new Schema([
      new Field('id', new Utf8()),
      new Field('slug', new Utf8()),
      new Field('chunkIndex', new Int32()),
      new Field('title', new Utf8()),
      new Field('category', new Utf8()),
      new Field('text', new Utf8()),
      new Field(
        'vector',
        new FixedSizeList(this.embedder.dimensions, new Field('item', new Float32(), true)),
      ),
      new Field('sources', new List(new Field('item', new Utf8(), true))),
      new Field('updated', new Utf8()),
    ]);
  }

  // 청크 색인 후 FTS 인덱스 1회 보장(빈 테이블엔 인덱스를 못 만들 수 있어 첫 데이터 후로 미룸).
  private async ensureFts(): Promise<void> {
    if (this.ftsReady) return;
    await this.table.createIndex('text', { config: lancedb.Index.fts() });
    this.ftsReady = true;
  }

  async indexPage(page: IndexablePage): Promise<void> {
    return this.enqueue(async () => {
      await this.table.delete(`slug = ${sql(page.slug)}`); // 멱등: 기존 청크 제거
      const chunks = chunkBody(page.body);
      if (chunks.length === 0) return;
      const vectors = await this.embedder.embed(chunks);
      const now = new Date().toISOString();
      const rows = chunks.map((text, i) => ({
        id: `${page.slug}#${i}`,
        slug: page.slug,
        chunkIndex: i,
        title: page.title,
        category: page.category,
        text,
        vector: vectors[i],
        sources: page.sources,
        updated: now,
      }));
      await this.table.add(rows);
      await this.ensureFts();
    });
  }

  async removePage(slug: string): Promise<void> {
    return this.enqueue(() => this.table.delete(`slug = ${sql(slug)}`));
  }

  async reindexAll(pages: IndexablePage[]): Promise<void> {
    for (const p of pages) await this.indexPage(p);
  }

  async search(query: string, limit = 5): Promise<SearchResult[]> {
    if (!this.ftsReady) return []; // 아직 색인된 게 없으면 빈 결과
    const [qvec] = await this.embedder.embed([query]);
    const rows = (await this.table
      .query()
      .nearestTo(qvec)
      .fullTextSearch(query)
      .rerank(this.reranker)
      .select(['slug', 'title', 'text'])
      .limit(limit)
      .toArray()) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      slug: String(r.slug),
      title: String(r.title),
      text: String(r.text),
      score: Number(r._relevance_score ?? r._score ?? 0),
    }));
  }

  // 쓰기 작업을 순차 실행(앞 작업 성패와 무관하게 다음 진행).
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
```

- [ ] **Step 4: 테스트 통과 확인 (실패 시 위 "구현 주의" 3개를 실행 로그로 확정해 조정)**

Run: `npx jest src/knowledge-core/rag/rag-store.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```
git add src/knowledge-core/rag/rag-store.ts src/knowledge-core/rag/rag-store.spec.ts
git commit -m "feat(rag): add RagStore with LanceDB hybrid index and search"
```

---

## Task 6: TransformersEmbedder — bge-m3 운영 어댑터

**Files:**
- Create: `src/knowledge-core/rag/transformers-embedder.ts`
- Test: `src/knowledge-core/rag/transformers-embedder.spec.ts`

**Interfaces:**
- Consumes: `IEmbedder` (Task 2)
- Produces: `class TransformersEmbedder implements IEmbedder` (`dimensions = 1024`)

> **ESM 주의:** `@huggingface/transformers`는 순수 ESM이라 CommonJS(NestJS 기본)에서 정적 import가 깨진다. 동적 `import()`를 쓰되, tsconfig가 `module:"commonjs"`면 TS가 이를 `require`로 다운레벨해 다시 깨질 수 있다. 회피책은 컴파일러가 건드리지 못하는 간접 import: `const dynamicImport = new Function('m', 'return import(m)'); const { pipeline } = await dynamicImport('@huggingface/transformers');`

- [ ] **Step 1: 실패하는 통합 테스트 작성 (opt-in)**

`src/knowledge-core/rag/transformers-embedder.spec.ts`:
```ts
import { TransformersEmbedder } from './transformers-embedder';

// 실제 모델 다운로드가 필요해 기본 skip. 수동/CI에서 ENGRAM_RAG_INTEGRATION=1로 켠다.
const run = process.env.ENGRAM_RAG_INTEGRATION === '1' ? describe : describe.skip;

run('TransformersEmbedder (integration)', () => {
  const embedder = new TransformersEmbedder();

  it('차원 1024의 정규화된 벡터를 낸다', async () => {
    const [v] = await embedder.embed(['하이브리드 검색']);
    expect(v).toHaveLength(embedder.dimensions);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 2);
  }, 120_000);

  it('한국어와 영어가 의미적으로 가깝다', async () => {
    const [ko, en, off] = await embedder.embed(['고양이', 'cat', '주식 시장 금리']);
    const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
    expect(dot(ko, en)).toBeGreaterThan(dot(ko, off));
  }, 120_000);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/knowledge-core/rag/transformers-embedder.spec.ts`
Expected: FAIL — cannot find `./transformers-embedder` (skip 모드면 0 ran — 먼저 구현으로 진행)

- [ ] **Step 3: 구현**

`src/knowledge-core/rag/transformers-embedder.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { IEmbedder } from './embedder.port';

// CommonJS에서 ESM 패키지를 안전하게 가져오기 위한 간접 import(컴파일러가 require로 바꾸지 못하게).
const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;

// 로컬 다국어 임베더(설계 §5.2). 기본 bge-m3(1024차원), 환경변수로 교체 가능.
// 첫 호출 시 모델을 1회 다운로드·캐시한다.
@Injectable()
export class TransformersEmbedder implements IEmbedder {
  readonly dimensions = 1024; // bge-m3 / multilingual-e5-large 공통
  private readonly modelId = process.env.ENGRAM_EMBED_MODEL ?? 'Xenova/bge-m3';
  private extractor?: (texts: string[], opts: object) => Promise<{ tolist(): number[][] }>;

  private async pipe() {
    if (!this.extractor) {
      const { pipeline } = await dynamicImport('@huggingface/transformers');
      this.extractor = await pipeline('feature-extraction', this.modelId);
    }
    return this.extractor;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const extractor = await this.pipe();
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    return output.tolist();
  }
}
```

- [ ] **Step 4: 통합 테스트 통과 확인 (opt-in)**

Run: `$env:ENGRAM_RAG_INTEGRATION=1; npx jest src/knowledge-core/rag/transformers-embedder.spec.ts; $env:ENGRAM_RAG_INTEGRATION=$null`
Expected: PASS (2 tests). 모델 ID가 안 맞거나 로딩 실패 시 → `ENGRAM_EMBED_MODEL=Xenova/multilingual-e5-large`로 재시도하고, 안정적인 쪽을 기본값으로 확정.

- [ ] **Step 5: 커밋**

```
git add src/knowledge-core/rag/transformers-embedder.ts src/knowledge-core/rag/transformers-embedder.spec.ts
git commit -m "feat(rag): add TransformersEmbedder (bge-m3) with ESM-safe import"
```

---

## Task 7: WikiEngine 연동 — 동기 색인 주경로

**Files:**
- Modify: `src/knowledge-core/wiki/wiki-engine.ts`
- Test: `src/knowledge-core/wiki/wiki-engine.spec.ts`

**Interfaces:**
- Consumes: `PAGE_INDEXER`/`PageIndexer`/`IndexablePage` (Task 4)
- Produces: WikiEngine이 published 결과를 낼 때 `indexer.indexPage`를 동기 호출. indexer 없으면 무동작.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/knowledge-core/wiki/wiki-engine.spec.ts`에 새 describe 추가 (기존 import에 맞춰 조정):
```ts
import { PageIndexer, IndexablePage } from '../rag/rag.types';

class SpyIndexer implements PageIndexer {
  indexed: IndexablePage[] = [];
  removed: string[] = [];
  async indexPage(p: IndexablePage) { this.indexed.push(p); }
  async removePage(slug: string) { this.removed.push(slug); }
}

describe('WikiEngine + PAGE_INDEXER', () => {
  let dir: string;
  let engine: WikiEngine;
  let spy: SpyIndexer;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-wiki-idx-'));
    const paths = new PathResolver(dir);
    const git = new WikiGit(paths);
    await git.ensureRepo();
    spy = new SpyIndexer();
    engine = new WikiEngine(paths, git, spy);
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('publishPage는 indexer.indexPage를 부른다', async () => {
    await engine.createPage({ slug: 'a', title: 'A', category: 'c', body: '본문' });
    await engine.publishPage('a');
    expect(spy.indexed.map((p) => p.slug)).toContain('a');
  });

  it('draft 생성은 색인하지 않는다', async () => {
    await engine.createPage({ slug: 'b', title: 'B', category: 'c', body: '본문' });
    expect(spy.indexed).toHaveLength(0);
  });

  it('published로 직접 생성하면 색인한다', async () => {
    await engine.createPage({ slug: 'c', title: 'C', category: 'c', body: '본문', status: 'published' });
    expect(spy.indexed.map((p) => p.slug)).toContain('c');
  });
});
```

> 기존 WikiEngine 테스트는 indexer 인자 없이 `new WikiEngine(paths, git)`로 생성 — 그대로 통과해야 한다(회귀 금지).

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/knowledge-core/wiki/wiki-engine.spec.ts -t "PAGE_INDEXER"`
Expected: FAIL — WikiEngine 생성자는 3번째 인자를 받지 않음 / indexed 비어 있음

- [ ] **Step 3: 구현**

`src/knowledge-core/wiki/wiki-engine.ts` 수정:

import 추가:
```ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import { IndexablePage, PageIndexer, PAGE_INDEXER } from '../rag/rag.types';
```

생성자에 선택적 indexer 추가:
```ts
  constructor(
    private readonly paths: PathResolver,
    private readonly git: WikiGit,
    @Optional() @Inject(PAGE_INDEXER) private readonly indexer?: PageIndexer,
  ) {}

  // WikiPage → 색인용 평탄 타입. (RagStore가 WikiPage 전체에 의존하지 않게.)
  private toIndexable(page: WikiPage): IndexablePage {
    return {
      slug: page.slug,
      title: page.frontmatter.title,
      category: page.frontmatter.category,
      sources: page.frontmatter.sources,
      body: page.body,
    };
  }
```

`createPage` return 직전:
```ts
    await this.git.commitAll(`create ${input.slug}`);
    if (page.frontmatter.status === 'published') {
      await this.indexer?.indexPage(this.toIndexable(page));
    }
    return page;
```

`updatePage` return 직전:
```ts
    await this.git.commitAll(`update ${slug}`);
    if (updated.frontmatter.status === 'published') {
      await this.indexer?.indexPage(this.toIndexable(updated));
    }
    return updated;
```

`publishPage` return 직전:
```ts
    await this.git.commitAll(`publish ${slug}`);
    await this.indexer?.indexPage(this.toIndexable(published));
    return published;
```

- [ ] **Step 4: 테스트 통과 확인 (신규 + 기존 회귀 없음)**

Run: `npx jest src/knowledge-core/wiki/wiki-engine.spec.ts`
Expected: PASS (기존 + 신규 3개 전부)

- [ ] **Step 5: 커밋**

```
git add src/knowledge-core/wiki/wiki-engine.ts src/knowledge-core/wiki/wiki-engine.spec.ts
git commit -m "feat(wiki): index published pages via optional PAGE_INDEXER port"
```

---

## Task 8: WikiWatcher — chokidar 보조 재색인

**Files:**
- Create: `src/knowledge-core/rag/wiki-watcher.ts`
- Test: `src/knowledge-core/rag/wiki-watcher.spec.ts`

**Interfaces:**
- Consumes: `PathResolver` (Task 1), `RagStore` (Task 5), `WikiEngine` (Task 7)
- Produces: `class WikiWatcher` with `start(): Promise<void>`, `stop(): Promise<void>`, and an internal `handleChange(slug, event)` that is unit-tested directly (chokidar 이벤트는 느리고 플레이키하므로 핸들러를 분리해 검증).

> **설계 노트:** 워처는 `runtime/wiki/pages/**/*.md`만 본다(`.git`·잠금파일 제외). 변경 감지 → slug별 디바운스 → 현재 위키 상태 조회: published면 `ragStore.indexPage`, 그 외(삭제·draft 전환)면 `ragStore.removePage`. 색인이 멱등이라 주경로와 겹쳐도 안전.

- [ ] **Step 1: 실패하는 테스트 작성 (핸들러 단위테스트)**

`src/knowledge-core/rag/wiki-watcher.spec.ts`:
```ts
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { WikiWatcher } from './wiki-watcher';
import { PathResolver } from '../../pal/path-resolver';
import { RagStore } from './rag-store';
import { FakeEmbedder } from './fake-embedder';
import { WikiGit } from '../wiki/wiki-git';
import { WikiEngine } from '../wiki/wiki-engine';

describe('WikiWatcher.handleChange', () => {
  let dir: string;
  let watcher: WikiWatcher;
  let store: RagStore;
  let engine: WikiEngine;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-watch-'));
    const paths = new PathResolver(dir);
    const git = new WikiGit(paths);
    await git.ensureRepo();
    store = new RagStore(paths, new FakeEmbedder());
    await store.init();
    engine = new WikiEngine(paths, git, store);
    watcher = new WikiWatcher(paths, store, engine);
  });
  afterEach(async () => {
    await watcher.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('published 페이지 변경은 재색인된다', async () => {
    await engine.createPage({ slug: 'w1', title: 'W1', category: 'c', body: '워처 본문', status: 'published' });
    await watcher.handleChange('w1', 'change');
    const results = await store.search('워처 본문', 50);
    expect(results.map((r) => r.slug)).toContain('w1');
  });

  it('파일 삭제는 색인에서 제거된다', async () => {
    await engine.createPage({ slug: 'w2', title: 'W2', category: 'c', body: '지울 것', status: 'published' });
    await watcher.handleChange('w2', 'unlink');
    const results = await store.search('지울 것', 50);
    expect(results.map((r) => r.slug)).not.toContain('w2');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/knowledge-core/rag/wiki-watcher.spec.ts`
Expected: FAIL — cannot find `./wiki-watcher`

- [ ] **Step 3: 구현**

`src/knowledge-core/rag/wiki-watcher.ts`:
```ts
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import chokidar, { FSWatcher } from 'chokidar';
import * as path from 'path';
import { PathResolver } from '../../pal/path-resolver';
import { RagStore } from './rag-store';
import { WikiEngine } from '../wiki/wiki-engine';

const DEBOUNCE_MS = 300; // 윈도우 파일 잠금·연속 쓰기 흡수

// 위키 .md 변경을 감지해 RAG를 보조 재색인한다(주경로가 놓친 외부 편집 보정).
@Injectable()
export class WikiWatcher implements OnModuleDestroy {
  private watcher?: FSWatcher;
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly paths: PathResolver,
    private readonly rag: RagStore,
    private readonly wiki: WikiEngine,
  ) {}

  async start(): Promise<void> {
    const glob = path.join(this.paths.getWikiPagesDir(), '*.md');
    this.watcher = chokidar.watch(glob, { ignoreInitial: true });
    this.watcher
      .on('add', (f) => this.debounce(this.slugOf(f), 'change'))
      .on('change', (f) => this.debounce(this.slugOf(f), 'change'))
      .on('unlink', (f) => this.debounce(this.slugOf(f), 'unlink'));
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await this.watcher?.close();
  }

  // 모듈 파괴 시 워처를 정리한다(jest 핸들 누수·좀비 워처 방지). NestJS app.close() 시 호출됨.
  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  private slugOf(file: string): string {
    return path.basename(file, '.md');
  }

  private debounce(slug: string, event: 'change' | 'unlink'): void {
    const prev = this.timers.get(slug);
    if (prev) clearTimeout(prev);
    this.timers.set(
      slug,
      setTimeout(() => {
        this.timers.delete(slug);
        void this.handleChange(slug, event);
      }, DEBOUNCE_MS),
    );
  }

  // 현재 위키 상태를 보고 색인/제거를 결정한다(published만 색인 대상).
  async handleChange(slug: string, event: 'change' | 'unlink'): Promise<void> {
    if (event === 'unlink') {
      await this.rag.removePage(slug);
      return;
    }
    const page = await this.wiki.getPage(slug);
    if (page && page.frontmatter.status === 'published') {
      await this.rag.indexPage({
        slug: page.slug,
        title: page.frontmatter.title,
        category: page.frontmatter.category,
        sources: page.frontmatter.sources,
        body: page.body,
      });
    } else {
      await this.rag.removePage(slug); // draft로 내려갔거나 사라짐 → 색인에서 빼기
    }
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/knowledge-core/rag/wiki-watcher.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: 커밋**

```
git add src/knowledge-core/rag/wiki-watcher.ts src/knowledge-core/rag/wiki-watcher.spec.ts
git commit -m "feat(rag): add WikiWatcher for secondary reindex"
```

---

## Task 9: 모듈 와이어링 + 시작 시 전체 재색인

**Files:**
- Modify: `src/knowledge-core/knowledge-core.module.ts`
- Test: `src/knowledge-core/knowledge-core.module.spec.ts` (신규)

**Interfaces:**
- Consumes: 전 태스크 산출물 전부
- Produces: 부팅 시 `RagStore.init()` → published 페이지 `reindexAll` → 워처 `start()`. `EMBEDDER`=`TransformersEmbedder`(운영), `PAGE_INDEXER`=`RagStore`.

- [ ] **Step 1: 실패하는 테스트 작성 (FakeEmbedder로 모듈 통합)**

`src/knowledge-core/knowledge-core.module.spec.ts`:
```ts
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Test } from '@nestjs/testing';
import { KnowledgeCoreModule } from './knowledge-core.module';
import { WikiEngine } from './wiki/wiki-engine';
import { RagStore } from './rag/rag-store';
import { EMBEDDER } from './rag/embedder.port';
import { FakeEmbedder } from './rag/fake-embedder';
import { PathResolver } from '../pal/path-resolver';

describe('KnowledgeCoreModule (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-kc-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('publish한 페이지를 RagStore에서 검색할 수 있다', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [KnowledgeCoreModule] })
      .overrideProvider(PathResolver).useValue(new PathResolver(dir))
      .overrideProvider(EMBEDDER).useClass(FakeEmbedder)
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const wiki = app.get(WikiEngine);
    const rag = app.get(RagStore);
    await wiki.createPage({ slug: 'kc', title: 'KC', category: 'c', body: '모듈 통합 본문', status: 'published' });

    const results = await rag.search('모듈 통합', 50);
    expect(results.map((r) => r.slug)).toContain('kc');
    await app.close();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/knowledge-core/knowledge-core.module.spec.ts`
Expected: FAIL — RagStore provider 없음 / EMBEDDER 토큰 미등록

- [ ] **Step 3: 구현**

`src/knowledge-core/knowledge-core.module.ts` 전체 교체:
```ts
import { Module, OnModuleInit } from '@nestjs/common';
import { PathResolver } from '../pal/path-resolver';
import { WikiEngine } from './wiki/wiki-engine';
import { WikiGit } from './wiki/wiki-git';
import { EMBEDDER } from './rag/embedder.port';
import { TransformersEmbedder } from './rag/transformers-embedder';
import { RagStore } from './rag/rag-store';
import { WikiWatcher } from './rag/wiki-watcher';
import { PAGE_INDEXER } from './rag/rag.types';

// KnowledgeCore: 단일 진실원(설계 §5). 시작 시 위키 git + RAG 색인을 보장한다.
@Module({
  providers: [
    { provide: PathResolver, useFactory: () => new PathResolver() },
    WikiGit,
    { provide: EMBEDDER, useClass: TransformersEmbedder },
    RagStore,
    { provide: PAGE_INDEXER, useExisting: RagStore },
    WikiWatcher,
    WikiEngine,
  ],
  exports: [WikiEngine, RagStore],
})
export class KnowledgeCoreModule implements OnModuleInit {
  constructor(
    private readonly git: WikiGit,
    private readonly wiki: WikiEngine,
    private readonly rag: RagStore,
    private readonly watcher: WikiWatcher,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.git.ensureRepo();
    await this.rag.init();
    // 시작 시 published 페이지 전체 재색인(모듈이 조율 → RagStore가 WikiEngine을 역의존하지 않음).
    const pages = await this.wiki.listPages({ status: 'published' });
    await this.rag.reindexAll(
      pages.map((p) => ({
        slug: p.slug,
        title: p.frontmatter.title,
        category: p.frontmatter.category,
        sources: p.frontmatter.sources,
        body: p.body,
      })),
    );
    await this.watcher.start();
  }
}
```

> **확인:** `WikiEngine`은 `@Optional() @Inject(PAGE_INDEXER)`로 RagStore를 받는다. `useExisting`이라 동일 인스턴스 — 주경로와 워처가 같은 RagStore(같은 직렬 큐)를 공유한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/knowledge-core/knowledge-core.module.spec.ts`
Expected: PASS (1 test)

- [ ] **Step 5: 전체 스위트 + 빌드 확인**

Run: `npx jest; npx tsc --noEmit; npm run build`
Expected: 전체 PASS, 타입 에러 없음, 빌드 클린. (통합 임베더 테스트는 기본 skip.)

- [ ] **Step 6: 커밋**

```
git add src/knowledge-core/knowledge-core.module.ts src/knowledge-core/knowledge-core.module.spec.ts
git commit -m "feat(rag): wire RagStore into KnowledgeCore with startup reindex and watcher"
```

---

## 최종 검증 (전체 완료 후)

- [ ] `npx jest` — 전체 스위트 green (Part 1 회귀 없음)
- [ ] `$env:ENGRAM_RAG_INTEGRATION=1; npx jest src/knowledge-core/rag/transformers-embedder.spec.ts` — 실제 bge-m3 로딩·한영 의미근접 통과 (모델 1회 다운로드)
- [ ] `npm run build` — 빌드 클린
- [ ] `.superpowers/sdd/progress.md`에 Part 2 원장 기록, Part 3 이월 항목 갱신
- [ ] `finishing-a-development-branch` 스킬로 머지/PR 결정

## Part 3 이월 (이 계획이 남기는 것)

- 단일-라이터 락: 위키 `commitAll` + RAG 쓰기 공통(설계 §10.3/§11)
- 한국어 BM25 토크나이저(lindera/nori 계열)
- 벡터 ANN 인덱스 튜닝(데이터 증가 시)
- 멀티유저 네임스페이싱(`wiki/pages/{userId}/`)
- 워처의 실제 chokidar 이벤트 E2E 스모크(현재는 handleChange 단위테스트로 대체)
