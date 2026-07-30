import { Inject, Injectable, Optional } from '@nestjs/common';
import * as lancedb from '@lancedb/lancedb';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from 'apache-arrow';
import { PathResolver, DEFAULT_USER } from '../../pal/path-resolver';
import { PinoLogger } from '../../pal/logger';
import { EMBEDDER, IEmbedder } from './embedder.port';
import { chunkBody } from './chunker';
import { IndexFingerprints, keyOf } from './index-fingerprint';
import { IndexablePage, PageIndexer, SearchResult } from './rag.types';

const TABLE = 'chunks';

// ★2026-07-25 실사고(프로젝트 최대 미제 "백엔드 크래시/색인 정지"의 진범)
// LanceDB 0.30(lance-index 7.0.0)의 FTS(inverted) 인덱스 빌더가 `index out of bounds`로 네이티브
// 패닉했다(lance #7313 — TokenSet::remap이 next_id를 되돌리지 않아 디스크에 오염된 값이 남고,
// 다음 세그먼트 병합에서 posting_lists 범위를 넘는다. lance-index 8.0.0 = @lancedb/lancedb 0.31.0에서
// 수정 + 읽는 순간 자가 치유). 이 파일의 격리 코드는 그 업그레이드와 별개로 남는다 —
// 네이티브 패닉이 다시 나더라도 RAG만 디그레이드되고 채팅·위키·코딩은 살아 있어야 하기 때문이다.
//
// 실측한 도달 경로(로컬 재현): tokio 워커 패닉 → napi가 일반 rejected promise로 변환 →
// 호출한 자리에서 `Error: Panic in async function` 한 줄만 잡힌다(상세 패닉 텍스트는 stderr로만 간다).
// 프로세스는 죽지 않고(사용자 로그: 패닉 수십 회를 안고 9.5시간 생존) uncaughtException /
// unhandledRejection에도 안 걸린다 — main.ts 계측이 0건이었던 이유가 이것이다.
//
// 인덱스 정비(FTS 생성·optimize) 주기: 쓰기마다 optimize()를 부르던 걸 N회마다로 낮춘다.
// 근거(실측): FTS 질의는 아직 색인되지 않은 fragment도 함께 스캔하므로 방금 쓴 문서가 즉시 검색된다
// (rag-store.spec.ts "쓰기마다 optimize하지 않아도 …" 테스트가 이 근거를 못박는다). 부팅 시
// reindexAll 끝에서 1회 강제 정비해 세션마다 최소 한 번은 통합되게 한다.
const OPTIMIZE_EVERY_WRITES = 20;
// 정비 연속 실패 임계 — 이만큼 실패하면 FTS 인덱스만 통째로 재생성해본다(스토어 격리가 아니다).
const FTS_FAIL_THRESHOLD = 3;
// 재생성 상한 — 무한 재생성 루프 방지. 넘으면 정비를 영구 중단하고 검색만 디그레이드한다.
export const FTS_REBUILD_LIMIT = 2;

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

// 네이티브(Rust) 패닉이 napi를 거쳐 JS에 도달할 때의 유일한 표식. 상세 패닉 텍스트
// (`thread 'tokio-rt-worker' panicked at …`)는 stderr로만 나가고 JS 쪽엔 이 한 줄만 온다 —
// 그래서 로그에 "네이티브 패닉"이라고 못박아 둬야 다음에 같은 부류를 즉시 알아본다(계측 보강).
const LANCE_NATIVE_PANIC = /panic in async function|panicked at/i;

export function isLanceNativePanic(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return LANCE_NATIVE_PANIC.test(msg);
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
// retryAll(리뷰 후속, 오탐 격리 방지): 부트 경로는 Lance 패턴이 아닌 에러(AV/OneDrive의 일시적
// 파일 락 등)까지 전 스케줄로 재시도한다 — 패턴 매칭만으로 즉시 포기하면 아직 건강한 스토어를
// 1회차 실패만으로 격리(재임베드 비용+rag.corrupt-* 누적)해버리는 오탐이 난다. 쓰기 경로 헬퍼
// (withLanceRetry)는 패턴 매칭 시맨틱을 그대로 유지한다 — retryAll은 이 함수에만 있는 boot 전용 옵션.
export interface BootRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryAll?: boolean;
  onRetry?: (attempt: number, err: Error, delayMs: number) => void;
}

export async function withBootRetry<T>(fn: () => Promise<T>, opts: BootRetryOptions = {}): Promise<T> {
  const { attempts = 5, baseDelayMs = 2000, maxDelayMs = 8000, retryAll = false, onRetry } = opts;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (i >= attempts || (!retryAll && !isLanceRetryable(err))) throw err;
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
  // 인덱스 정비 상태(2026-07-25 패닉 격리). 데이터 쓰기와 분리된 축이다 — 정비가 죽어도 색인·검색은 산다.
  private writesSinceOptimize = 0;
  private ftsFailures = 0; // 연속 실패 수(성공하면 0으로 복귀)
  private ftsRebuilds = 0; // FTS 인덱스 재생성 시도 수(상한 FTS_REBUILD_LIMIT)
  private ftsDegraded = false; // true면 정비를 아예 시도하지 않는다(검색은 계속 동작)

  constructor(
    private readonly paths: PathResolver,
    @Inject(EMBEDDER) private readonly embedder: IEmbedder,
    @Optional() private readonly logger?: PinoLogger,
  ) {}

  // 지문 파일은 rag 폴더 옆(state)에 둔다 — 격리(rename)로 rag 폴더가 통째로 옮겨져도 같이 끌려가지
  // 않아야, 격리 후 clear()로 명시적으로 버리는 흐름이 성립한다.
  private fingerprints(): IndexFingerprints {
    return new IndexFingerprints(path.join(this.paths.getStateDir(), 'rag-index.json'));
  }

  async init(): Promise<void> {
    this.ready = false;
    // 주기 정비 카운터만 초기화한다. 재생성 상한(ftsRebuilds)·영구 디그레이드(ftsDegraded)는
    // 일부러 초기화하지 않는다 — init()을 다시 타는 경로(quarantineAndReinit)로 상한이 리셋되면
    // "재생성 → 실패 → 재init → 재생성 …" 루프가 살아나기 때문(무한 루프 방지가 우선).
    this.writesSinceOptimize = 0;
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
    // 색인이 통째로 사라졌으니 지문도 버린다 — 안 버리면 "이미 색인됨"으로 오판해 빈 스토어를
    // 그대로 두게 된다(검색이 조용히 아무것도 못 찾는 상태).
    this.fingerprints().clear();
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

  // 네이티브 호출 시임(renameDir과 같은 관례) — 테스트가 spyOn으로 패닉을 결정적으로 주입한다.
  // 이 두 메서드만이 lance의 인덱스 빌더(=2026-07-25 패닉의 진앙)를 건드리는 지점이다.
  protected async createFtsIndex(replace = false): Promise<void> {
    await this.table.createIndex('text', { config: lancedb.Index.fts(), replace });
  }
  protected async optimizeTable(): Promise<void> {
    await this.table.optimize();
  }

  private async hasFtsIndex(): Promise<boolean> {
    const indices = await this.table.listIndices();
    return indices.some((idx) => idx.columns.includes('text'));
  }

  // 인덱스 정비(FTS 생성 + 주기적 optimize). ★절대 호출자에게 예외를 전파하지 않는다★ —
  // 여기가 2026-07-25 패닉이 indexPage 전체를 실패시켜 RAG 색인을 통째로 멈춰버린 seam이다.
  // 데이터 쓰기(delete/add)는 이 호출 이전에 이미 커밋돼 있으므로, 정비 실패는 "검색 품질 저하"일
  // 뿐 데이터 손실이 아니다. force=true면 주기와 무관하게 즉시 optimize(부팅 재색인 끝 등).
  private async maintainIndex(force = false): Promise<void> {
    if (this.ftsDegraded) return; // 상한 소진 — 더 시도하지 않는다(무한 루프 방지)
    try {
      if (!(await this.hasFtsIndex())) await this.createFtsIndex();
      this.writesSinceOptimize++;
      if (force || this.writesSinceOptimize >= OPTIMIZE_EVERY_WRITES) {
        await this.optimizeTable();
        this.writesSinceOptimize = 0;
      }
      this.ftsFailures = 0; // 한 번이라도 성공하면 연속 실패 카운터 복귀
    } catch (err) {
      await this.onMaintenanceFailure(err);
    }
  }

  // 정비 실패 처리(상한 있는 자가치유). 연속 FTS_FAIL_THRESHOLD회 실패마다 FTS 인덱스"만" 통째로
  // 재생성한다 — rag 폴더 전체 격리(quarantineAndReinit)를 쓰지 않는 이유는 실측 결과 이 패닉이
  // 스토어를 손상시키지 않기 때문이다(행 수·스키마·검색 모두 정상, 재오픈도 정상). 전체 격리는
  // 건강한 스토어를 오탐 폐기하고 전 코퍼스 재임베딩 비용을 무는 과잉 대응이다.
  // 재생성도 FTS_REBUILD_LIMIT회까지만 — 넘으면 정비를 영구 중단(ftsDegraded)하고 검색은 계속한다.
  private async onMaintenanceFailure(err: unknown): Promise<void> {
    this.ftsFailures++;
    const msg = err instanceof Error ? err.message : String(err);
    // 네이티브 패닉은 JS에 `Panic in async function` 한 줄로만 온다 — 계측을 위해 그 사실을 명시한다.
    const native = isLanceNativePanic(err) ? ' [네이티브 패닉 — 상세 스택은 stderr 참조]' : '';
    this.logger?.warn(
      `RAG 인덱스 정비 실패(${this.ftsFailures}회 연속, 색인 데이터는 이미 커밋됨)${native}: ${msg}`,
      'RagStore',
    );
    if (this.ftsFailures < FTS_FAIL_THRESHOLD) return;
    if (this.ftsRebuilds >= FTS_REBUILD_LIMIT) {
      this.ftsDegraded = true;
      this.logger?.error(
        `RAG FTS 인덱스 재생성 상한(${FTS_REBUILD_LIMIT}회) 소진 — 인덱스 정비를 중단한다. ` +
          '검색은 벡터+미색인 스캔으로 계속 동작하고, 색인·채팅·위키·코딩은 영향 없다.',
        msg,
        'RagStore',
      );
      return;
    }
    this.ftsRebuilds++;
    this.ftsFailures = 0;
    try {
      await this.createFtsIndex(true); // replace: 오염된 인덱스를 버리고 처음부터 다시 만든다
      this.writesSinceOptimize = 0;
      this.logger?.warn(
        `RAG FTS 인덱스 재생성 성공(${this.ftsRebuilds}/${FTS_REBUILD_LIMIT}회차) — 정비 재개`,
        'RagStore',
      );
    } catch (rebuildErr) {
      const rmsg = rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr);
      this.logger?.warn(
        `RAG FTS 인덱스 재생성 실패(${this.ftsRebuilds}/${FTS_REBUILD_LIMIT}회차): ${rmsg}`,
        'RagStore',
      );
      if (this.ftsRebuilds >= FTS_REBUILD_LIMIT) {
        this.ftsDegraded = true;
        this.logger?.error(
          `RAG FTS 인덱스 재생성 상한(${FTS_REBUILD_LIMIT}회) 소진 — 인덱스 정비를 중단한다. ` +
            '검색은 벡터+미색인 스캔으로 계속 동작하고, 색인·채팅·위키·코딩은 영향 없다.',
          rmsg,
          'RagStore',
        );
      }
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
    // 데이터 쓰기만 재시도 단위로 둔다(delete/add는 멱등이라 통째 재실행이 안전).
    // 인덱스 정비는 이 단위 밖 — 정비 실패로 데이터 쓰기를 다시 돌리면(2026-07-25 이전 동작)
    // 패닉 1건이 쓰기 3회로 증폭되고 색인 자체가 통째로 실패한다.
    await this.enqueue(() => withLanceRetry(async () => {
      // 멱등: 같은 (userId, slug)의 기존 청크 제거 — userId 범위 한정으로 타 유저 데이터 보호.
      await this.table.delete(`userId = ${sql(userId)} AND slug = ${sql(page.slug)}`);
      const chunks = chunkBody(page.body);
      if (chunks.length === 0) return false;
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
      return true;
    }).then(
      // 정비는 쓰기 성공 후에만, 그리고 절대 throw하지 않는다(maintainIndex 내부에서 흡수).
      (wrote) => (wrote ? this.maintainIndex() : undefined),
    ));
  }

  async removePage(slug: string, userId: string = DEFAULT_USER): Promise<void> {
    if (!this.ready) {
      this.logger?.warn(`RAG 디그레이드 상태 — 삭제 스킵: ${slug}`, 'RagStore');
      return;
    }
    await this.enqueue(() => withLanceRetry(async () => {
      // userId 범위 한정 삭제: 타 유저 동명 페이지를 건드리지 않는다.
      await this.table.delete(`userId = ${sql(userId)} AND slug = ${sql(slug)}`);
    }).then(
      // tombstone 정비도 주기 정비에 위임한다(즉시 optimize 불필요 — 삭제는 deletion vector로
      // 질의 시점에 반영되므로 "지운 게 검색된다" 회귀가 없다. spec의 removePage 테스트가 근거).
      () => this.maintainIndex(),
    ));
  }

  // 페이지별 try/catch(리뷰 후속): 정상 부팅 경로(ok-path)에서 한 페이지가 파싱·임베딩 실패 등으로
  // throw하면 그대로 onModuleInit의 'ok' 분기를 뚫고 나가 크래시루프 증상이 다른 원인으로 재발한다.
  // KnowledgeCoreModule.runFullReindex(격리 후 백그라운드 경로)가 이미 쓰는 것과 동일한 보호를
  // 여기(정상 경로)에도 적용 — warn+skip, 성공/실패 건수를 요약 로그로 남긴다.
  // onProgress: 부팅 진행 표시용(2026-07-26). 페이지 하나가 끝날 때마다 (완료수, 전체)를 알린다 —
  // 실패해서 건너뛴 페이지도 "지나간 건" 진행이므로 함께 센다(화면이 멈춰 보이면 안 된다).
  // 미지정이면 기존과 완전히 동일(회귀 0).
  async reindexAll(pages: IndexablePage[], onProgress?: (done: number, total: number) => void): Promise<void> {
    if (!this.ready) {
      this.logger?.warn(`RAG 디그레이드 상태 — 전체 재색인 스킵(${pages.length}건)`, 'RagStore');
      return;
    }
    // ★안 바뀐 페이지는 건너뛴다(2026-07-27). 이전엔 부팅마다 전 페이지를 다시 임베딩했다 —
    // 13장에 약 4분, 100장이면 30분, 그동안 백엔드가 응답을 못 한다. 지문이 전부 일치하면
    // embedder.embed를 한 번도 부르지 않으므로 **2.1GB 모델조차 로드되지 않는다**.
    const fp = this.fingerprints();
    fp.load();
    let ok = 0;
    let seen = 0;
    let skipped = 0;
    let changed = false;
    for (const p of pages) {
      // ★지문 계산까지 try 안에 둔다(2026-07-30 실사고). 밖에 있던 fp.matches가 이상한 frontmatter에
      // 던지면 reindexAll 전체가 reject되고 부팅이 영원히 안 끝났다 — 페이지 한 장의 문제가 앱을
      // 못 켜게 만들면 안 된다. 여기서 던지면 그 페이지만 warn하고 넘어간다(색인 실패와 같은 취급).
      try {
        const fpInput = { ...p, userId: p.userId ?? DEFAULT_USER };
        if (fp.matches(fpInput)) {
          skipped++;
        } else {
          await this.indexPage(p);
          fp.set(fpInput);
          changed = true;
          ok++;
        }
      } catch (err) {
        this.logger?.warn(
          `전체 재색인 중 페이지 실패(건너뜀): ${p.slug} — ${err instanceof Error ? err.message : String(err)}`,
          'RagStore',
        );
      }
      seen++;
      try { onProgress?.(seen, pages.length); } catch { /* 계측이 재색인을 막지 않게 */ }
    }
    fp.keepOnly(new Set(pages.map((p) => keyOf({ ...p, userId: p.userId ?? DEFAULT_USER }))));
    fp.save();
    // 쓴 게 하나도 없으면 정비할 것도 없다 — 안 바뀐 부팅에서 통합만 도는 낭비를 막는다.
    if (changed) await this.maintainIndex(true);
    this.logger?.log(`전체 재색인 완료(색인 ${ok}건 · 그대로 ${skipped}건 / 총 ${pages.length}건)`, 'RagStore');
  }

  async search(query: string, limit = 5, userId: string = DEFAULT_USER): Promise<SearchResult[]> {
    // 디그레이드 상태 — 빈 결과로 폴백(검색 UI가 "결과 없음"으로 안전 처리, 크래시 없음).
    if (!this.ready) return [];
    // FTS 인덱스 유무를 확인한다. 없으면(아직 한 번도 색인 전이거나, 인덱스 정비가 디그레이드된
    // 상태) 예전처럼 빈 배열로 블랙아웃하지 않고 ★벡터 단독 검색으로 폴백★한다 —
    // "RAG는 품질만 떨어지고 계속 동작한다"는 이 파일의 디그레이드 관례(2026-07-20)의 연장이다.
    const hasFts = await this.hasFtsIndex();
    const [qvec] = await this.embedder.embed([query]);
    // userId WHERE 프리필터: 벡터+FTS 양쪽 leg에 격리 조건 적용(설계 §15).
    // select 없이 모든 필드를 반환 — _score(FTS)와 _distance(벡터) 모두 포함.
    // 0.30에서 select에 점수 필드를 빠뜨리면 deprecated 경고 발생하므로, select 자체를 생략한다.
    const base = this.table
      .query()
      .where(`userId = ${sql(userId)}`) // 사용자 격리 프리필터
      .nearestTo(qvec)
      .limit(limit);
    const rows = (await (hasFts
      ? base.fullTextSearch(query).rerank(this.reranker)
      : base
    ).toArray()) as Array<Record<string, unknown>>;
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
