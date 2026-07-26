import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { RagStore, withLanceRetry, withBootRetry, isLanceRetryable, isLanceNativePanic, FTS_REBUILD_LIMIT } from './rag-store';
import { FakeEmbedder } from './fake-embedder';
import { PathResolver, DEFAULT_USER } from '../../pal/path-resolver';
import { IndexablePage } from './rag.types';

function page(slug: string, body: string, title = slug): IndexablePage {
  return { slug, title, category: 'test', sources: ['대화'], body };
}

describe('withLanceRetry', () => {
  it('retryable 커밋 충돌은 재시도해 성공한다', async () => {
    let n = 0;
    const fn = jest.fn(async () => {
      if (++n < 3) throw new Error('Retryable commit conflict for version 36: CreateIndex preempted. Please retry.');
      return 'ok';
    });
    await expect(withLanceRetry(fn, 3, 1)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it('retryable이 아닌 에러는 즉시 던진다', async () => {
    const fn = jest.fn(async () => { throw new Error('EEXIST: file already exists'); });
    await expect(withLanceRetry(fn, 3, 1)).rejects.toThrow('EEXIST');
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('시도 횟수를 소진하면 마지막 에러를 던진다', async () => {
    const fn = jest.fn(async () => { throw new Error('Please retry.'); });
    await expect(withLanceRetry(fn, 2, 1)).rejects.toThrow('Please retry');
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('"Panic in async function"도 재시도 대상으로 분류한다(2026-07-19 부트 경합 실사고)', async () => {
    let n = 0;
    const fn = jest.fn(async () => {
      if (++n < 2) throw new Error('Error: Panic in async function');
      return 'ok';
    });
    await expect(withLanceRetry(fn, 3, 1)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('isLanceRetryable', () => {
  it('커밋 충돌·panic 메시지는 retryable', () => {
    expect(isLanceRetryable(new Error('Retryable commit conflict. Please retry.'))).toBe(true);
    expect(isLanceRetryable(new Error('Error: Panic in async function'))).toBe(true);
  });
  it('무관한 에러는 retryable이 아니다', () => {
    expect(isLanceRetryable(new Error('ENOENT: no such file or directory'))).toBe(false);
  });
});

// 계측 보강(2026-07-25): 네이티브 패닉은 JS에 `Panic in async function` 한 줄로만 도달한다.
// 그 시그니처를 분류할 수 있어야 로그에 "네이티브 패닉"이라고 못박아 다음 사고를 즉시 알아본다.
describe('isLanceNativePanic', () => {
  it('napi가 넘겨주는 패닉 메시지를 네이티브 패닉으로 분류한다', () => {
    expect(isLanceNativePanic(new Error('Error: Panic in async function'))).toBe(true);
    expect(isLanceNativePanic("thread 'tokio-rt-worker' panicked at builder.rs:856:57")).toBe(true);
  });
  it('일반 에러는 네이티브 패닉이 아니다', () => {
    expect(isLanceNativePanic(new Error('Retryable commit conflict. Please retry.'))).toBe(false);
    expect(isLanceNativePanic(new Error('ENOENT: no such file'))).toBe(false);
  });
});

describe('withBootRetry', () => {
  it('panic 에러로 N번 실패 후 성공 — 재시도마다 onRetry(warn 로깅용) 호출', async () => {
    let n = 0;
    const fn = jest.fn(async () => {
      if (++n < 3) throw new Error('Error: Panic in async function');
      return 'ok';
    });
    const onRetry = jest.fn();
    await expect(
      withBootRetry(fn, { attempts: 5, baseDelayMs: 1, maxDelayMs: 4, onRetry }),
    ).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toBe(1); // 1회차 재시도
    expect(onRetry.mock.calls[1][0]).toBe(2); // 2회차 재시도
  });

  it('지수 백오프가 maxDelayMs로 상한된다', async () => {
    let n = 0;
    const fn = jest.fn(async () => {
      if (++n < 4) throw new Error('Panic in async function');
      return 'ok';
    });
    const delays: number[] = [];
    await withBootRetry(fn, {
      attempts: 5,
      baseDelayMs: 1,
      maxDelayMs: 3,
      onRetry: (_a, _e, delayMs) => delays.push(delayMs),
    });
    // baseDelayMs=1: 1, 2, 4→상한 3 이렇게 증가하다 maxDelayMs(3)에서 멈춘다.
    expect(delays).toEqual([1, 2, 3]);
  });

  it('재시도를 소진할 때까지 계속 실패하면 마지막 에러를 던진다(오늘과 동일한 degraded 동작)', async () => {
    const fn = jest.fn(async () => { throw new Error('Panic in async function'); });
    await expect(
      withBootRetry(fn, { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 }),
    ).rejects.toThrow('Panic in async function');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('재시도 불가능한 에러는 즉시 던진다(retry 낭비 없음, retryAll 미지정 시 기존 시맨틱 유지)', async () => {
    const fn = jest.fn(async () => { throw new Error('ENOENT: no such file'); });
    await expect(
      withBootRetry(fn, { attempts: 5, baseDelayMs: 1 }),
    ).rejects.toThrow('ENOENT');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // 리뷰 후속(오탐 격리 방지): 부트는 retryAll:true로 Lance 패턴이 아닌 에러도 전체 스케줄로
  // 재시도해야 한다 — 그래야 AV/OneDrive의 일시적 파일 락 같은 무관한 에러 1회차에 즉시
  // quarantineAndReinit으로 떨어지는(건강한 스토어 오탐 격리) 일이 없다.
  it('retryAll:true면 Lance 패턴이 아닌 에러도 재시도해 성공한다(①오탐 격리 방지)', async () => {
    let n = 0;
    const fn = jest.fn(async () => {
      if (++n < 3) throw new Error('EBUSY: resource busy or locked'); // Lance 패턴이 아님
      return 'ok';
    });
    await expect(
      withBootRetry(fn, { attempts: 5, baseDelayMs: 1, maxDelayMs: 2, retryAll: true }),
    ).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3); // 3회차에 성공 — 격리로 떨어지지 않는다
  });

  it('retryAll:true여도 계속 실패하면 전체 스케줄을 소진한 뒤에야 던진다(②소진 후 격리 대상)', async () => {
    const fn = jest.fn(async () => { throw new Error('EBUSY: resource busy or locked'); });
    await expect(
      withBootRetry(fn, { attempts: 4, baseDelayMs: 1, maxDelayMs: 2, retryAll: true }),
    ).rejects.toThrow('EBUSY');
    expect(fn).toHaveBeenCalledTimes(4); // 패턴 무관하게 attempts만큼 전부 재시도됐다
  });
});

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

  // 부팅 진행 표시(2026-07-26): 이 구간이 부팅에서 제일 오래 걸려(첫 페이지에서 임베딩 모델 로드)
  // 페이지마다 진행이 올라와야 화면이 "멈춘 것"과 안 헷갈린다.
  it('reindexAll은 페이지마다 진행(완료수/전체)을 알린다', async () => {
    const seen: Array<[number, number]> = [];
    await store.reindexAll([page('r1', '하나'), page('r2', '둘'), page('r3', '셋')], (done, total) => seen.push([done, total]));
    expect(seen).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it('진행 콜백이 던져도 재색인은 계속된다(계측이 본 작업을 못 막게)', async () => {
    await expect(
      store.reindexAll([page('t1', '하나'), page('t2', '둘')], () => { throw new Error('계측 폭발'); }),
    ).resolves.toBeUndefined();
    const slugs = (await store.search('둘', 50)).map((r) => r.slug);
    expect(slugs).toContain('t2');
  });

  // 리뷰 후속(잔여 크래시 경로 봉쇄): 정상 부팅 경로(ok-path)의 reindexAll에서 한 페이지가
  // throw해도 onModuleInit을 뚫고 나가지 않고, 나머지 페이지는 계속 색인되며 요약 로그가 남아야 한다.
  it('reindexAll은 한 페이지가 실패해도 나머지는 색인하고 성공/실패 건수를 요약 로그로 남긴다(③)', async () => {
    const logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn(), verbose: jest.fn() };
    const s = new RagStore(new PathResolver(dir), new FakeEmbedder(), logger as never);
    await s.init();
    const spy = jest.spyOn(s, 'indexPage').mockImplementation(async (p: IndexablePage) => {
      if (p.slug === 'bad') throw new Error('boom: 색인 실패 시뮬레이션');
    });

    await expect(
      s.reindexAll([page('p1', '첫째 글'), page('bad', '실패 대상'), page('p2', '둘째 글')]),
    ).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalledTimes(3); // bad를 포함해 전부 시도됐다
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('bad'), 'RagStore');
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('2/3건'), 'RagStore');
  });

  it('재오픈 후 추가한 페이지도 검색된다(2회 init FTS stale 회귀)', async () => {
    // 첫 번째 인스턴스: pageA 색인
    await store.indexPage(page('reopen-a', 'LanceDB 재오픈 검증 A'));

    // 두 번째 인스턴스: 같은 디렉토리를 재오픈 후 pageB 추가
    const store2 = new RagStore(new PathResolver(dir), new FakeEmbedder());
    await store2.init();
    await store2.indexPage(page('reopen-b', 'LanceDB 재오픈 검증 B'));

    // A·B 모두 검색돼야 한다(특히 재오픈 후 넣은 B가 FTS stale로 누락되지 않아야 함)
    const results = await store2.search('LanceDB 재오픈 검증', 50);
    const slugs = results.map((r) => r.slug);
    expect(slugs).toContain('reopen-a');
    expect(slugs).toContain('reopen-b');
  });

  it('다른 userId의 같은 slug를 격리한다', async () => {
    await store.indexPage({
      userId: 'alice', slug: 'note', title: 'A', category: 'c', sources: [], body: 'apple pie recipe',
    });
    await store.indexPage({
      userId: 'bob', slug: 'note', title: 'B', category: 'c', sources: [], body: 'banana bread recipe',
    });
    const alice = await store.search('recipe', 5, 'alice');
    expect(alice.length).toBeGreaterThan(0);
    expect(alice.every((h) => h.text.includes('apple'))).toBe(true);
    expect(alice.some((h) => h.text.includes('banana'))).toBe(false);
  });

  it('removePage는 userId 범위로만 제거한다', async () => {
    await store.indexPage({
      userId: 'alice', slug: 'k', title: 'A', category: 'c', sources: [], body: 'keepme alpha',
    });
    await store.indexPage({
      userId: 'bob', slug: 'k', title: 'B', category: 'c', sources: [], body: 'keepme beta',
    });
    await store.removePage('k', 'alice');
    const bob = await store.search('keepme', 5, 'bob');
    expect(bob.some((h) => h.text.includes('beta'))).toBe(true);
    const alice = await store.search('keepme', 5, 'alice');
    expect(alice.some((h) => h.text.includes('alpha'))).toBe(false);
  });

  it('userId 미지정 색인·검색은 DEFAULT_USER로 동작한다(하위호환)', async () => {
    await store.indexPage({
      slug: 'legacy', title: 'L', category: 'c', sources: [], body: 'legacy default user content',
    });
    const hits = await store.search('legacy content'); // userId 생략
    expect(hits.length).toBeGreaterThan(0);
  });

  it('검색 score가 유한수이고 내림차순이다', async () => {
    await store.reindexAll([
      page('s1', '머신러닝 모델 학습'),
      page('s2', '벡터 데이터베이스 검색'),
      page('s3', '자연어 처리 파이프라인'),
    ]);
    const results = await store.search('벡터 검색', 10);
    // 결과가 1개 이상이어야 score 순서 검증이 의미 있다.
    expect(results.length).toBeGreaterThan(0);
    // 모든 score가 유한수여야 한다.
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
    }
    // 결과가 2개 이상이면 내림차순(가장 관련 높은 게 먼저)임을 검증한다.
    if (results.length >= 2) {
      expect(results[0].score).toBeGreaterThanOrEqual(results[results.length - 1].score);
    }
  });
});

// 부트 자가치유(근본픽스 2026-07-20): withBootRetry가 소진된 뒤 호출되는 격리(rename)+재생성 경로.
// rename 자체는 protected renameDir()로 시임을 분리해 spyOn으로 결정적으로 실패를 주입한다
// (fs 모듈 네임스페이스 스파이는 esModuleInterop __importStar 하에서 신뢰할 수 없다 — 게터 프로퍼티는
// 보통 configurable:false라 jest.spyOn이 재정의에 실패한다).
describe('RagStore.quarantineAndReinit (부트 자가치유)', () => {
  let dir: string;
  let store: RagStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-rag-quarantine-'));
    store = new RagStore(new PathResolver(dir), new FakeEmbedder());
    await store.init();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('격리(rename) 성공 → 원래 rag 폴더는 rag.corrupt-<timestamp>로 이동하고, 빈 폴더에 재생성돼 즉시 사용 가능하다', async () => {
    await store.indexPage(page('before-heal', '격리 전 색인된 문서'));
    const ragDir = path.join(dir, 'rag');

    await store.quarantineAndReinit({ delayMs: 1 });

    // 원래 위치엔 새 빈 스토어가 새로 생성돼 있다(디렉토리 자체는 다시 존재).
    const ragStat = await fs.stat(ragDir);
    expect(ragStat.isDirectory()).toBe(true);
    // 격리된 폴더가 형제로 남아있다(rag.corrupt-yyyymmdd-HHmmss).
    const siblings = await fs.readdir(dir);
    expect(siblings.some((s) => /^rag\.corrupt-\d{8}-\d{6}$/.test(s))).toBe(true);

    // 재생성된 스토어는 비어 있다 — 격리 전 색인은 새 코퍼스에 없다(disposable, wiki가 원본).
    const afterHeal = await store.search('격리 전 색인된 문서', 50);
    expect(afterHeal.map((r) => r.slug)).not.toContain('before-heal');

    // 새로 색인·검색이 정상 동작한다(진짜로 재생성됐다는 증거).
    await store.indexPage(page('after-heal', '격리 후 새로 색인된 문서'));
    const results = await store.search('격리 후 새로 색인된 문서', 50);
    expect(results.map((r) => r.slug)).toContain('after-heal');
  });

  it('rename이 계속 실패하면(EBUSY 등) 재시도 후 포기하고 예외를 던진다 — 오늘과 동일한 디그레이드로 폴백(더 강하게 크래시하지 않음)', async () => {
    const renameSpy = jest
      .spyOn(store as unknown as { renameDir(src: string, dest: string): Promise<void> }, 'renameDir')
      .mockRejectedValue(new Error('EBUSY: resource busy or locked'));

    await expect(store.quarantineAndReinit({ attempts: 3, delayMs: 1 })).rejects.toThrow('EBUSY');
    expect(renameSpy).toHaveBeenCalledTimes(3); // 몇 차례 재시도 후 포기(무한 대기 없음)

    // 격리도 실패했으니 스토어는 계속 디그레이드 상태 — 크래시 대신 안전한 폴백값을 반환한다.
    expect(await store.search('아무거나')).toEqual([]);
    await expect(store.indexPage(page('x', '아무 본문'))).resolves.toBeUndefined();
  });

  it('rename이 일시 실패 후 재시도로 성공하면 정상 격리·재생성된다', async () => {
    let attempt = 0;
    jest
      .spyOn(store as unknown as { renameDir(src: string, dest: string): Promise<void> }, 'renameDir')
      .mockImplementation(async (src: string, dest: string) => {
        attempt++;
        if (attempt < 2) throw new Error('EBUSY: resource busy or locked');
        await fs.rename(src, dest);
      });

    await expect(store.quarantineAndReinit({ attempts: 3, delayMs: 1 })).resolves.toBeUndefined();
    expect(attempt).toBe(2);

    // 재생성 후 정상 동작 확인.
    await store.indexPage(page('recovered', '재시도 끝에 복구'));
    const results = await store.search('재시도 끝에 복구', 50);
    expect(results.map((r) => r.slug)).toContain('recovered');
  });
});

// ★2026-07-25 실사고(프로젝트 최대 미제 "크래시 폭주"의 진범): LanceDB 0.30(lance-index 7.0.0)의
// FTS(inverted) 인덱스 빌더가 `index out of bounds` 로 네이티브 패닉했다. 실측한 도달 경로는
// "tokio 워커 패닉 → napi가 일반 rejected promise로 변환 → `Error: Panic in async function` 한 줄"이며,
// 프로세스는 죽지 않고(사용자 로그: 패닉 수십 회를 안고 9.5시간 생존) uncaughtException/unhandledRejection
// 에도 안 걸린다. 진짜 피해는 (1) 우리가 그 메시지를 retryable로 분류해 매 쓰기마다 3회 재시도했고
// (실측: 재시도는 100% 다시 패닉), (2) 인덱스 정비 실패가 indexPage 전체를 실패시켜 RAG 색인이
// 통째로 멈춘 것이다(사용자 rag 폴더가 7/20 이후 갱신 정지). 아래 테스트가 그 seam을 못박는다.
describe('RagStore — 네이티브 인덱스 패닉 격리(2026-07-25)', () => {
  let dir: string;
  let store: RagStore;
  const logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn(), verbose: jest.fn() };

  // optimize/createIndex 시임(renameDir과 같은 관례) — 네이티브 패닉을 결정적으로 주입한다.
  type Seam = { optimizeTable(): Promise<void>; createFtsIndex(replace?: boolean): Promise<void> };
  const panic = (): never => { throw new Error('Error: Panic in async function'); };

  beforeEach(async () => {
    jest.clearAllMocks();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-rag-panic-'));
    store = new RagStore(new PathResolver(dir), new FakeEmbedder(), logger as never);
    await store.init();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('인덱스 정비(optimize)가 패닉해도 indexPage는 성공하고 색인된 내용은 검색된다(RAG만 디그레이드)', async () => {
    const spy = jest.spyOn(store as unknown as Seam, 'optimizeTable').mockImplementation(panic);

    // reindexAll은 끝에서 optimize를 강제한다 — 그 정비가 패닉해도 재색인은 성공으로 끝나야 한다.
    await expect(store.reindexAll([page('panic-1', '패닉 중에도 저장돼야 하는 본문')])).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();

    // 데이터 쓰기(delete/add)는 정비 이전에 이미 커밋됐다 — 검색으로 찾을 수 있어야 한다.
    const hits = await store.search('패닉 중에도 저장돼야 하는 본문', 50);
    expect(hits.map((h) => h.slug)).toContain('panic-1');
    // 정비 실패는 예외가 아니라 경고 로그로만 표면화된다.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('인덱스 정비'), 'RagStore');
    spy.mockRestore();
  });

  it('정비 패닉을 재시도로 증폭하지 않는다 — 쓰기 1회당 optimize 호출도 1회뿐', async () => {
    const spy = jest.spyOn(store as unknown as Seam, 'optimizeTable').mockImplementation(panic);
    // 강제 정비(force) 경로를 태우기 위해 reindexAll 사용 — 끝에서 1회 optimize.
    await store.reindexAll([page('r1', '본문 하나')]);
    expect(spy).toHaveBeenCalledTimes(1); // withLanceRetry의 3회 재시도에 휘말리지 않는다
    spy.mockRestore();
  });

  it('정비가 계속 패닉하면 상한 안에서 FTS 인덱스만 재생성하고, 상한을 넘으면 정비를 영구 중단한다(무한 루프 없음)', async () => {
    const optSpy = jest.spyOn(store as unknown as Seam, 'optimizeTable').mockImplementation(panic);
    const idxSpy = jest.spyOn(store as unknown as Seam, 'createFtsIndex').mockImplementation(panic);

    // 정비 실패 3회마다 재생성(replace) 1회, 재생성 상한 2회 → 총 6회 실패 후 영구 디그레이드.
    for (let i = 0; i < 20; i++) await store.reindexAll([page(`x${i}`, `본문 ${i}`)]);

    // 재생성(replace: true) 호출은 상한(2회)을 넘지 않는다.
    expect(idxSpy.mock.calls.filter((c) => c[0] === true)).toHaveLength(FTS_REBUILD_LIMIT);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('FTS'),
      expect.anything(),
      'RagStore',
    );

    // ★무한 루프 없음의 진짜 증거: 디그레이드 이후엔 네이티브 호출이 단 한 번도 늘지 않는다.
    const idxCalls = idxSpy.mock.calls.length;
    const optCalls = optSpy.mock.calls.length;
    for (let i = 0; i < 20; i++) await store.reindexAll([page(`y${i}`, `본문 ${i}`)]);
    expect(idxSpy.mock.calls.length).toBe(idxCalls);
    expect(optSpy.mock.calls.length).toBe(optCalls);

    // ★핵심: 그래도 색인·검색은 계속 동작한다(채팅·위키는 애초에 무관).
    optSpy.mockRestore();
    idxSpy.mockRestore();
    await expect(store.indexPage(page('after-degrade', '디그레이드 후에도 저장'))).resolves.toBeUndefined();
    const hits = await store.search('디그레이드 후에도 저장', 50);
    expect(hits.map((h) => h.slug)).toContain('after-degrade');
  });

  it('FTS 인덱스가 아예 없어도 검색은 빈 배열이 아니라 벡터 단독 결과로 디그레이드한다', async () => {
    // createIndex를 계속 실패시켜 FTS 인덱스가 한 번도 안 만들어진 상태를 만든다.
    jest.spyOn(store as unknown as Seam, 'createFtsIndex').mockImplementation(panic);
    jest.spyOn(store as unknown as Seam, 'optimizeTable').mockImplementation(panic);

    await store.indexPage(page('vec-only', '벡터 단독 폴백 검증 본문'));

    const hits = await store.search('벡터 단독 폴백 검증 본문', 50);
    expect(hits.map((h) => h.slug)).toContain('vec-only'); // 검색 블랙아웃(빈 배열)이 아니다
    expect(hits.every((h) => Number.isFinite(h.score))).toBe(true);
  });

  // 4번(부하 완화)의 근거 테스트: 쓰기마다 optimize()를 부르지 않아도 검색 누락이 없다.
  // (실측 근거: LanceDB는 FTS 질의 시 아직 색인되지 않은 fragment도 함께 스캔한다.)
  it('쓰기마다 optimize하지 않아도 방금 쓴 페이지가 즉시 검색된다(검색 누락 없음)', async () => {
    const spy = jest.spyOn(store as unknown as Seam, 'optimizeTable');
    await store.indexPage(page('fresh-a', '갓 쓴 문서 알파 고유단어끄트머리'));
    await store.indexPage(page('fresh-b', '갓 쓴 문서 베타 고유단어끄트머리'));

    // 이 시점까지 optimize는 한 번도 호출되지 않았다(주기 정비 임계값 미달).
    expect(spy).not.toHaveBeenCalled();

    const hits = await store.search('고유단어끄트머리', 50);
    const slugs = hits.map((h) => h.slug);
    expect(slugs).toContain('fresh-a');
    expect(slugs).toContain('fresh-b');
    spy.mockRestore();
  });
});

// init()이 한 번도 성공하지 못한(혹은 격리·재생성도 실패한) 디그레이드 상태 — 모든 소비 메서드가
// 예외 없이 안전한 폴백값을 반환해야 한다(WikiEngine 등 소비자가 옵셔널 체이닝만으로는 막지
// 못하는 지점 — RagStore 자체가 "smallest seam"으로 가드한다).
describe('RagStore — init 미완료(디그레이드) 상태의 안전한 폴백', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-rag-degraded-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('init()을 호출하지 않은 스토어는 검색·색인·삭제·전체재색인 모두 예외 없이 안전하게 no-op/빈 값을 반환한다', async () => {
    const store = new RagStore(new PathResolver(dir), new FakeEmbedder());

    await expect(store.search('아무거나')).resolves.toEqual([]);
    await expect(store.indexPage(page('a', '본문'))).resolves.toBeUndefined();
    await expect(store.removePage('a')).resolves.toBeUndefined();
    await expect(store.reindexAll([page('a', '본문')])).resolves.toBeUndefined();
  });
});
