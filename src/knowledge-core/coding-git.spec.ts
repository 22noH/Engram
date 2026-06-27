import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import { CodingGit } from './coding-git';

describe('CodingGit', () => {
  let repo: string;
  let cg: CodingGit;
  beforeEach(async () => {
    repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'engram-cg-'));
    const g = simpleGit(repo);
    await g.init();
    await g.addConfig('user.name', 'T');
    await g.addConfig('user.email', 't@t');
    await fs.promises.writeFile(path.join(repo, 'a.txt'), 'hello');
    await g.add('.');
    await g.commit('init');
    cg = new CodingGit();
  });
  afterEach(async () => {
    await fs.promises.rm(repo, { recursive: true, force: true });
  });

  it('ensureBranch는 격리 브랜치로 전환', async () => {
    await cg.ensureBranch(repo, 'engram/x');
    expect(await cg.currentBranch(repo)).toBe('engram/x');
  });

  it('변경 없으면 hasChanges=false, 커밋 생략', async () => {
    await cg.ensureBranch(repo, 'engram/x');
    expect(await cg.hasChanges(repo)).toBe(false);
    await cg.commitAll(repo, 'noop');
  });

  it('변경 있으면 커밋', async () => {
    await cg.ensureBranch(repo, 'engram/x');
    await fs.promises.writeFile(path.join(repo, 'b.txt'), 'new');
    expect(await cg.hasChanges(repo)).toBe(true);
    await cg.commitAll(repo, 'add b');
    const log = await simpleGit(repo).log({ maxCount: 1 });
    expect(log.latest!.message).toBe('add b');
  });
});
