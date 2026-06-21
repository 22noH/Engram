import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PathResolver } from '../../pal/path-resolver';
import { WikiEngine } from './wiki-engine';
import { WikiGit } from './wiki-git';

const tmpDirs: string[] = [];

async function setup(): Promise<{ engine: WikiEngine; git: WikiGit }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-git-'));
  tmpDirs.push(dir);
  const paths = new PathResolver(dir);
  const git = new WikiGit(paths);
  await git.ensureRepo();
  const engine = new WikiEngine(paths, git);
  return { engine, git };
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
  });
});

afterAll(async () => {
  for (const d of tmpDirs) {
    await fs.rm(d, { recursive: true, force: true });
  }
});
