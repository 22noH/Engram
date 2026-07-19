import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { RagStore, withLanceRetry, withBootRetry, isLanceRetryable } from './rag-store';
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

  it('재시도 불가능한 에러는 즉시 던진다(retry 낭비 없음)', async () => {
    const fn = jest.fn(async () => { throw new Error('ENOENT: no such file'); });
    await expect(
      withBootRetry(fn, { attempts: 5, baseDelayMs: 1 }),
    ).rejects.toThrow('ENOENT');
    expect(fn).toHaveBeenCalledTimes(1);
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
