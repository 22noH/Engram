import { Inject, Injectable } from '@nestjs/common';
import * as lancedb from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from 'apache-arrow';
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
  private reranker!: lancedb.rerankers.RRFReranker;
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
      // ftsReady 가드 없이 재오픈 경로에서도 ensureFts가 실행되도록 하기 위해
      // 여기서 미리 설정하지 않는다(ensureFts가 listIndices로 직접 확인한다).
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
      // sources는 JSON 직렬화 문자열로 저장(Arrow List 타입 대신 단순 Utf8).
      new Field('sources', new Utf8()),
      new Field('updated', new Utf8()),
    ]);
  }

  // 청크 색인 후 FTS 인덱스를 보장한다.
  // - listIndices()로 실제 인덱스 존재를 확인 후 없으면 생성(idempotent).
  // - 재오픈 경로에서도 ftsReady 가드 없이 항상 실행되므로 stale 인덱스 문제가 없다.
  // - 빈 테이블엔 인덱스를 만들 수 없으므로 데이터가 있는 후(indexPage 내부)에서만 호출한다.
  private async ensureFts(): Promise<void> {
    const indices = await this.table.listIndices();
    const hasFts = indices.some(
      (idx) => idx.columns.includes('text'),
    );
    if (!hasFts) {
      await this.table.createIndex('text', { config: lancedb.Index.fts() });
    }
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
        sources: JSON.stringify(page.sources),
        updated: now,
      }));
      await this.table.add(rows);
      await this.ensureFts();
    });
  }

  async removePage(slug: string): Promise<void> {
    await this.enqueue(() => this.table.delete(`slug = ${sql(slug)}`));
  }

  async reindexAll(pages: IndexablePage[]): Promise<void> {
    for (const p of pages) await this.indexPage(p);
  }

  async search(query: string, limit = 5): Promise<SearchResult[]> {
    // FTS 인덱스가 없으면(아직 indexPage가 한 번도 호출되지 않은 상태) 빈 결과 반환.
    const indices = await this.table.listIndices();
    const hasFts = indices.some((idx) => idx.columns.includes('text'));
    if (!hasFts) return [];
    const [qvec] = await this.embedder.embed([query]);
    // select 없이 모든 필드를 반환 — _score(FTS)와 _distance(벡터) 모두 포함.
    // 0.30에서 select에 점수 필드를 빠뜨리면 deprecated 경고 발생하므로, select 자체를 생략한다.
    const rows = (await this.table
      .query()
      .nearestTo(qvec)
      .fullTextSearch(query)
      .rerank(this.reranker)
      .limit(limit)
      .toArray()) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      slug: String(r.slug),
      title: String(r.title),
      text: String(r.text),
      // RRFReranker는 _relevance_score(높을수록 관련)를 출력한다.
      // _distance(낮을수록 유사)는 rerank 후 undefined가 되므로 사용하지 않는다.
      // 만약 _relevance_score도 없으면(벡터 단독 경로) 1/(1+_distance)로 변환해 "높을수록 관련"을 보장한다.
      score:
        r._relevance_score != null
          ? Number(r._relevance_score)
          : r._distance != null
            ? 1 / (1 + Number(r._distance))
            : 0,
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
