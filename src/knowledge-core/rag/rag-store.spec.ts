import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { RagStore } from './rag-store';
import { FakeEmbedder } from './fake-embedder';
import { PathResolver, DEFAULT_USER } from '../../pal/path-resolver';
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
