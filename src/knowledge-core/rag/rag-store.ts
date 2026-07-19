import { Inject, Injectable, Optional } from '@nestjs/common';
import * as lancedb from '@lancedb/lancedb';
import * as fs from 'fs/promises';
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from 'apache-arrow';
import { PathResolver, DEFAULT_USER } from '../../pal/path-resolver';
import { PinoLogger } from '../../pal/logger';
import { EMBEDDER, IEmbedder } from './embedder.port';
import { chunkBody } from './chunker';
import { IndexablePage, PageIndexer, SearchResult } from './rag.types';

const TABLE = 'chunks';

// LanceDB는 다른 프로세스(앱 상주 vs 헤드리스 MCP가 같은 데이터 폴더 공유)와 커밋이 경합하면
// "Retryable commit conflict … Please retry"를 던진다 — in-process 큐로는 못 막으므로 재시도가 정답.
// (2026-07-19 실사고: 승인 중 CreateIndex 경합 → 제안 좀비화)
// "Panic in async function"도 같은 부류로 취급한다 — open() 단계에서 앱 부팅과 헤드리스 MCP가
// 동시에 같은 rag 폴더를 열 때 나는 크로스 프로세스 경합이며, 보통 일시적이다(2026-07-19 실사고 2:
// 헤드리스가 먼저 core 모드로 폴더를 열고 있으면 뒤이은 앱 부팅의 KnowledgeCoreModule.onModuleInit이
// 이 에러로 죽어 크래시루프를 탔다 → 부트 경로도 재시도로 흡수, knowledge-core.module.ts 참조).
const LANCE_RETRYABLE = /retryable commit conflict|please retry|panic in async function/i;

export function isLanceRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return LANCE_RETRYABLE.test(msg);
}

export async function withLanceRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 200): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !isLanceRetryable(e)) throw e;
      await new Promise((r) => setTimeout(r, baseDelayMs * i));
    }
  }
}

// 부트 경로 전용 재시도(withLanceRetry와 별도) — 앱 부팅이 헤드리스 MCP보다 우선권을 갖도록
// 더 오래·지수 백오프로 기다린다(기본 5회, 2s→4s→8s→8s… maxDelayMs로 상한, 총 ~30s 내외).
// onRetry로 재시도마다 콜백을 받아 호출자(KnowledgeCoreModule)가 warn 로깅하게 한다.
export interface BootRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, err: Error, delayMs: number) => void;
}

export async function withBootRetry<T>(fn: () => Promise<T>, opts: BootRetryOptions = {}): Promise<T> {
  const { attempts = 5, baseDelayMs = 2000, maxDelayMs = 8000, onRetry } = opts;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (i >= attempts || !isLanceRetryable(err)) throw err;
      const delayMs = Math.min(baseDelayMs * 2 ** (i - 1), maxDelayMs);
      onRetry?.(i, err, delayMs);
      await new Promise((r) => setTimeout(r, delayMs));
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
  // init()이 끝까지 성공해야 true — 부트 자가치유(근본픽스 2026-07-20)가 격리 후 재생성마저
  // 실패하면 false로 남아 모든 소비 메서드가 안전하게 no-op/빈 결과로 디그레이드한다(크래시 방지).
  private ready = false;

  constructor(
    private readonly paths: PathResolver,
    @Inject(EMBEDDER) private readonly embedder: IEmbedder,
    @Optional() private readonly logger?: PinoLogger,
  ) {}

  async init(): Promise<void> {
    this.ready = false;
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
    this.ready = true;
  }

  // 부트 자가치유(근본픽스 2026-07-20): withBootRetry가 소진된 뒤(패닉·부분생성 잔해로 open도
  // create도 실패하는 등 "Table 'chunks' was not found ... _versions" 부류 전부 포함) 호출된다.
  // 손상된 rag 폴더를 통째로 격리(rename)하고 빈 폴더에 새로 init()한다 — RAG는 wiki에서 파생되는
  // disposable 저장소라 데이터 손실 없이 안전하다(위키 원본은 wiki/*.md에 그대로 남는다).
  // rename 자체가 실패하면(EBUSY/EPERM 등 다른 프로세스가 아직 핸들을 쥐고 있는 경우) 짧은 대기를
  // 두고 몇 차례 재시도하고, 그래도 실패하면 예외를 던져 호출자가 오늘과 동일한 디그레이드로
  // 폴백하게 한다(더 강하게 크래시루프를 타지 않는다 — 이 메서드 자체는 절대 무한 대기하지 않음).
  async quarantineAndReinit(opts: { attempts?: number; delayMs?: number } = {}): Promise<void> {
    const { attempts = 3, delayMs = 300 } = opts;
    const dir = this.paths.getRagDir();
    const dest = `${dir}.corrupt-${this.timestamp()}`;
    let lastErr: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        await this.renameDir(dir, dest);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    if (lastErr) {
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }
    this.logger?.warn(`손상 rag 폴더 격리 완료 → ${dest} — 빈 폴더에 재생성`, 'RagStore');
    await this.init(); // 격리된 빈 폴더 위에 새 스토어 생성(오픈 경로가 createEmptyTable로 진입).
  }

  // rename 자체를 오버라이드 가능한 메서드로 분리 — 테스트가 rename 실패(EBUSY 등)를 결정적으로
  // 주입할 수 있는 시임(fs 모듈 네임스페이스 스파이는 esModuleInterop 하에서 신뢰할 수 없다).
  protected async renameDir(src: string, dest: string): Promise<void> {
    await fs.rename(src, dest);
  }

  // 격리 폴더명용 타임스탬프(yyyymmdd-HHmmss, 로컬시간).
  private timestamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
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
    // 디그레이드 상태(init 실패·격리 재생성도 실패) — 색인 no-op. 소비자(WikiEngine 등)를
    // 크래시시키지 않는 게 목적(근본픽스 2026-07-20, "smallest seam" — 프록시 대신 자체 가드).
    if (!this.ready) {
      this.logger?.warn(`RAG 디그레이드 상태 — 색인 스킵: ${page.slug}`, 'RagStore');
      return;
    }
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
    if (!this.ready) {
      this.logger?.warn(`RAG 디그레이드 상태 — 삭제 스킵: ${slug}`, 'RagStore');
      return;
    }
    await this.enqueue(() => withLanceRetry(async () => {
      // userId 범위 한정 삭제: 타 유저 동명 페이지를 건드리지 않는다.
      await this.table.delete(`userId = ${sql(userId)} AND slug = ${sql(slug)}`);
      // 삭제 후 optimize: tombstone 정비. startup reindexAll이 페이지마다 호출하므로
      // 코퍼스 수백+ 시 배치/주기 인덱스로 승격 여부를 측정 후 결정(현재 YAGNI).
      await this.table.optimize();
    }));
  }

  async reindexAll(pages: IndexablePage[]): Promise<void> {
    if (!this.ready) {
      this.logger?.warn(`RAG 디그레이드 상태 — 전체 재색인 스킵(${pages.length}건)`, 'RagStore');
      return;
    }
    for (const p of pages) await this.indexPage(p);
  }

  async search(query: string, limit = 5, userId: string = DEFAULT_USER): Promise<SearchResult[]> {
    // 디그레이드 상태 — 빈 결과로 폴백(검색 UI가 "결과 없음"으로 안전 처리, 크래시 없음).
    if (!this.ready) return [];
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
