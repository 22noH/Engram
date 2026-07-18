import { Inject, Injectable } from '@nestjs/common';
import * as lancedb from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from 'apache-arrow';
import { PathResolver, DEFAULT_USER } from '../../pal/path-resolver';
import { EMBEDDER, IEmbedder } from './embedder.port';
import { chunkBody } from './chunker';
import { IndexablePage, PageIndexer, SearchResult } from './rag.types';

const TABLE = 'chunks';

// LanceDB는 다른 프로세스(앱 상주 vs 헤드리스 MCP가 같은 데이터 폴더 공유)와 커밋이 경합하면
// "Retryable commit conflict … Please retry"를 던진다 — in-process 큐로는 못 막으므로 재시도가 정답.
// (2026-07-19 실사고: 승인 중 CreateIndex 경합 → 제안 좀비화)
const LANCE_RETRYABLE = /retryable commit conflict|please retry/i;

export async function withLanceRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 200): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (i >= attempts || !LANCE_RETRYABLE.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, baseDelayMs * i));
    }
  }
}

// SQL 술어용 문자열 이스케이프(작은따옴표 이중화).
const sql = (s: string): string => `'${s.replace(/'/g, "''")}'`;

// 위키 published 페이지를 LanceDB에 멱등 색인하고 하이브리드 검색을 제공한다(설계 §5.2).
// Phase 0 Part 3: userId 컬럼 추가로 멀티유저 격리 + 쓰기마다 optimize()로 FTS 인덱스 최신화.
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
      // 멀티유저 마이그레이션: userId 컬럼이 없는 구 스키마면 drop+recreate.
      // RAG는 wiki에서 파생·시작 시 reindex되므로 데이터 손실이 없다(disposable store).
      const fields = (await this.table.schema()).fields;
      if (!fields.some((f) => f.name === 'userId')) {
        await this.db.dropTable(TABLE);
        this.table = await this.db.createEmptyTable(TABLE, this.schema());
      }
    } else {
      this.table = await this.db.createEmptyTable(TABLE, this.schema());
    }
    this.reranker = await lancedb.rerankers.RRFReranker.create();
  }

  private schema(): Schema {
    return new Schema([
      // userId를 맨 앞에 배치: WHERE 프리필터 핵심 컬럼(설계 §15 멀티유저 격리).
      new Field('userId', new Utf8()),
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
    const userId = page.userId ?? DEFAULT_USER;
    // 본문 전체를 재시도 단위로 — delete/add/인덱스가 모두 멱등이라 통째 재실행이 안전하다.
    return this.enqueue(() => withLanceRetry(async () => {
      // 멱등: 같은 (userId, slug)의 기존 청크 제거 — userId 범위 한정으로 타 유저 데이터 보호.
      await this.table.delete(`userId = ${sql(userId)} AND slug = ${sql(page.slug)}`);
      const chunks = chunkBody(page.body);
      if (chunks.length === 0) return;
      const vectors = await this.embedder.embed(chunks);
      const now = new Date().toISOString();
      const rows = chunks.map((text, i) => ({
        userId,
        id: `${userId}/${page.slug}#${i}`,
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
      // 쓰기마다 optimize()로 FTS 인덱스·tombstone 정비(정확성보단 성능, 누락 방지 목적).
      await this.table.optimize();
    }));
  }

  async removePage(slug: string, userId: string = DEFAULT_USER): Promise<void> {
    await this.enqueue(() => withLanceRetry(async () => {
      // userId 범위 한정 삭제: 타 유저 동명 페이지를 건드리지 않는다.
      await this.table.delete(`userId = ${sql(userId)} AND slug = ${sql(slug)}`);
      // 삭제 후 optimize: tombstone 정비. startup reindexAll이 페이지마다 호출하므로
      // 코퍼스 수백+ 시 배치/주기 인덱스로 승격 여부를 측정 후 결정(현재 YAGNI).
      await this.table.optimize();
    }));
  }

  async reindexAll(pages: IndexablePage[]): Promise<void> {
    for (const p of pages) await this.indexPage(p);
  }

  async search(query: string, limit = 5, userId: string = DEFAULT_USER): Promise<SearchResult[]> {
    // FTS 인덱스가 없으면(아직 indexPage가 한 번도 호출되지 않은 상태) 빈 결과 반환.
    const indices = await this.table.listIndices();
    if (!indices.some((idx) => idx.columns.includes('text'))) return [];
    const [qvec] = await this.embedder.embed([query]);
    // userId WHERE 프리필터: 벡터+FTS 양쪽 leg에 격리 조건 적용(설계 §15).
    // select 없이 모든 필드를 반환 — _score(FTS)와 _distance(벡터) 모두 포함.
    // 0.30에서 select에 점수 필드를 빠뜨리면 deprecated 경고 발생하므로, select 자체를 생략한다.
    const rows = (await this.table
      .query()
      .where(`userId = ${sql(userId)}`) // 사용자 격리 프리필터
      .nearestTo(qvec)
      .fullTextSearch(query)
      .rerank(this.reranker)
      .limit(limit)
      .toArray()) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      userId: String(r.userId),
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
