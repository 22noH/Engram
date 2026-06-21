import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PathResolver } from '../../pal/path-resolver';
import { WikiEngine } from './wiki-engine';

// 각 테스트는 임시 디렉토리에서 독립 실행한다.
async function makeEngine(): Promise<WikiEngine> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-wiki-'));
  return new WikiEngine(new PathResolver(dir));
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
