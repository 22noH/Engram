import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PathResolver, DEFAULT_USER } from '../../pal/path-resolver';
import { WikiEngine } from './wiki-engine';
import { WikiGit } from './wiki-git';
import { KeyedLock } from '../keyed-lock';

const tmpDirs: string[] = [];

// 각 테스트는 임시 디렉토리에서 독립 실행한다.
async function makeEngine(): Promise<WikiEngine> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-wiki-'));
  tmpDirs.push(dir);
  const paths = new PathResolver(dir);
  const git = new WikiGit(paths);
  await git.ensureRepo();
  // KeyedLock을 주입해 페이지별 쓰기 직렬화를 활성화한다.
  return new WikiEngine(paths, git, new KeyedLock());
}

describe('WikiEngine CRUD', () => {
  it('페이지를 생성하고 다시 읽으면 같은 내용이다', async () => {
    const engine = await makeEngine();
    const created = await engine.createPage({
      slug: 'hello', title: '안녕', category: 'general', body: '첫 글',
    });
    expect(created.frontmatter.status).toBe('draft');

    const read = await engine.getPage('hello');
    expect(read?.body).toBe('첫 글');
    expect(read?.frontmatter.title).toBe('안녕');
  });

  it('없는 페이지는 null을 반환한다', async () => {
    const engine = await makeEngine();
    expect(await engine.getPage('nope')).toBeNull();
  });

  it('중복 slug 생성은 에러를 던진다', async () => {
    const engine = await makeEngine();
    await engine.createPage({ slug: 'dup', title: 'T', category: 'c', body: 'x' });
    await expect(
      engine.createPage({ slug: 'dup', title: 'T2', category: 'c', body: 'y' }),
    ).rejects.toThrow();
  });

  it('업데이트는 본문을 바꾸고 created를 보존한다', async () => {
    const engine = await makeEngine();
    const a = await engine.createPage({ slug: 'p', title: 'T', category: 'c', body: 'old' });
    const b = await engine.updatePage('p', { body: 'new' });
    expect(b.body).toBe('new');
    expect(b.frontmatter.created).toBe(a.frontmatter.created);
  });

  it('listPages는 생성된 모든 페이지를 반환한다', async () => {
    const engine = await makeEngine();
    await engine.createPage({ slug: 'a', title: 'A', category: 'c', body: 'x' });
    await engine.createPage({ slug: 'b', title: 'B', category: 'c', body: 'y' });
    const all = await engine.listPages();
    expect(all.map((p) => p.slug).sort()).toEqual(['a', 'b']);
  });

  it('다른 userId의 같은 slug를 파일로 격리한다', async () => {
    const engine = await makeEngine();
    await engine.createPage({ slug: 'note', title: 'A', category: 'c', body: 'alice body' }, 'alice');
    await engine.createPage({ slug: 'note', title: 'B', category: 'c', body: 'bob body' }, 'bob');
    expect((await engine.getPage('note', 'alice'))?.body).toBe('alice body');
    expect((await engine.getPage('note', 'bob'))?.body).toBe('bob body');
  });

  it('userId 미지정은 DEFAULT_USER로 동작한다(하위호환)', async () => {
    const engine = await makeEngine();
    await engine.createPage({ slug: 'legacy', title: 'L', category: 'c', body: 'x' });
    expect((await engine.getPage('legacy', DEFAULT_USER))?.slug).toBe('legacy');
  });

  it('같은 (userId,slug) 동시 update는 직렬화되어 lost-update가 없다', async () => {
    const engine = await makeEngine();
    await engine.createPage({ slug: 'race', title: 'R', category: 'c', body: 'start' });
    // 서로 다른 필드를 동시에 patch. 락이 read-modify-write를 직렬화하면 두 갱신이 모두 보존된다.
    // (락 없으면 둘 다 'start'/'R'를 읽어 마지막 writer가 다른 쪽 갱신을 덮어씀 = lost-update.)
    await Promise.all([
      engine.updatePage('race', { body: 'first' }),
      engine.updatePage('race', { title: 'Second' }),
    ]);
    const page = await engine.getPage('race');
    expect(page!.body).toBe('first'); // 두 갱신이 모두 살아남음(실행 순서 무관)
    expect(page!.frontmatter.title).toBe('Second');
  });
});

describe('WikiEngine 상태(draft/published)', () => {
  it('publishPage는 상태를 published로 바꾼다', async () => {
    const engine = await makeEngine();
    await engine.createPage({ slug: 'p', title: 'T', category: 'c', body: 'x' });
    const pub = await engine.publishPage('p');
    expect(pub.frontmatter.status).toBe('published');

    const read = await engine.getPage('p');
    expect(read?.frontmatter.status).toBe('published');
  });

  it('publishPage는 없는 페이지에 에러를 던진다', async () => {
    const engine = await makeEngine();
    await expect(engine.publishPage('nope')).rejects.toThrow();
  });

  it('listPages({status}) 는 상태로 필터링한다', async () => {
    const engine = await makeEngine();
    await engine.createPage({ slug: 'd', title: 'D', category: 'c', body: 'x' }); // draft
    await engine.createPage({ slug: 'p', title: 'P', category: 'c', body: 'y' });
    await engine.publishPage('p');

    const published = await engine.listPages({ status: 'published' });
    expect(published.map((x) => x.slug)).toEqual(['p']);

    const all = await engine.listPages();
    expect(all.length).toBe(2);
  });
});

afterAll(async () => {
  for (const d of tmpDirs) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

import { PageIndexer, IndexablePage } from '../rag/rag.types';

class SpyIndexer implements PageIndexer {
  indexed: IndexablePage[] = [];
  removed: Array<{ slug: string; userId?: string }> = [];
  async indexPage(p: IndexablePage) { this.indexed.push(p); }
  async removePage(slug: string, userId?: string) { this.removed.push({ slug, userId }); }
  async reindexAll(pages: IndexablePage[]) { for (const p of pages) this.indexed.push(p); }
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
    // KeyedLock을 세 번째 인자로, PageIndexer(spy)를 네 번째 인자로 전달한다.
    engine = new WikiEngine(paths, git, new KeyedLock(), spy);
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

  it('unpublishPage는 published를 draft로 내리고 색인에서 제거한다', async () => {
    await engine.createPage({ slug: 'u', title: 'U', category: 'c', body: 'b', status: 'published' });
    const result = await engine.unpublishPage('u');
    expect(result.frontmatter.status).toBe('draft');
    expect(spy.removed).toContainEqual({ slug: 'u', userId: DEFAULT_USER });
  });

  it('unpublishPage는 이미 draft면 멱등 no-op(제거 호출 안 함)', async () => {
    await engine.createPage({ slug: 'd2', title: 'D', category: 'c', body: 'b' }); // draft
    const result = await engine.unpublishPage('d2');
    expect(result.frontmatter.status).toBe('draft');
    expect(spy.removed).toHaveLength(0);
  });
});
