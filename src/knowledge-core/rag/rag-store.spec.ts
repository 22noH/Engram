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
