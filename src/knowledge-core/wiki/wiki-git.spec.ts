import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import { PathResolver } from '../../pal/path-resolver';
import { WikiEngine } from './wiki-engine';
import { WikiGit } from './wiki-git';
import { KeyedLock } from '../keyed-lock';

const tmpDirs: string[] = [];

async function setup(): Promise<{ engine: WikiEngine; git: WikiGit; paths: PathResolver }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-git-'));
  tmpDirs.push(dir);
  const paths = new PathResolver(dir);
  const git = new WikiGit(paths);
  await git.ensureRepo();
  // KeyedLock을 주입해 생성자 계약을 충족한다.
  const engine = new WikiEngine(paths, git, new KeyedLock());
  return { engine, git, paths };
}

describe('WikiGit 이력', () => {
  it('페이지 생성이 git 커밋으로 남는다', async () => {
    const { engine, git } = await setup();
    await engine.createPage({
      slug: 'hello', title: '안녕', category: 'c', body: 'x', sources: ['conv:1'],
    });
    const msgs = await git.recentMessages();
    expect(msgs[0]).toContain('hello');
  });

  it('생성과 수정이 각각 별도 커밋이 된다', async () => {
    const { engine, git } = await setup();
    await engine.createPage({ slug: 'p', title: 'T', category: 'c', body: 'old' });
    await engine.updatePage('p', { body: 'new' });
    const msgs = await git.recentMessages();
    expect(msgs.length).toBeGreaterThanOrEqual(2);
  }, 30_000); // git spawn 3회 — 윈도우 병렬 부하에서 기본 5s를 넘겨 플레이크(전체 스위트에서만 재현)

  it('relPath를 주면 그 경로만 스테이징한다(동시 변경 혼입 방지)', async () => {
    const { git, paths } = await setup();
    const wikiDir = paths.getWikiDir();
    const pagesDir = path.join(wikiDir, 'pages', 'default');
    await fs.mkdir(pagesDir, { recursive: true });
    await fs.writeFile(path.join(pagesDir, 'x.md'), 'X');
    await fs.writeFile(path.join(pagesDir, 'y.md'), 'Y');
    await git.commitAll('add x only', path.join('pages', 'default', 'x.md'));
    const tracked = await simpleGit(wikiDir).raw(['ls-files']);
    expect(tracked).toContain('x.md'); // x만 커밋됨
    expect(tracked).not.toContain('y.md'); // y는 미커밋(워킹트리에 남음)
  });

  it('스테이징된 변경이 없으면 커밋하지 않는다', async () => {
    const { git, paths } = await setup();
    const wikiDir = paths.getWikiDir();
    const rel = path.join('pages', 'default', 'z.md');
    await fs.mkdir(path.join(wikiDir, 'pages', 'default'), { recursive: true });
    await fs.writeFile(path.join(wikiDir, rel), 'Z');
    await git.commitAll('add z', rel);
    const before = (await git.recentMessages(50)).length;
    await git.commitAll('noop z', rel); // 변경 없음 → 새 커밋 안 생김
    const after = (await git.recentMessages(50)).length;
    expect(after).toBe(before);
  });
});

afterAll(async () => {
  for (const d of tmpDirs) {
    await fs.rm(d, { recursive: true, force: true });
  }
});
