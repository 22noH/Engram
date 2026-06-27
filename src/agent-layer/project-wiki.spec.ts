import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PathResolver } from '../pal/path-resolver';
import { WikiEngine } from '../knowledge-core/wiki/wiki-engine';
import { WikiGit } from '../knowledge-core/wiki/wiki-git';
import { KeyedLock } from '../knowledge-core/keyed-lock';
import { ProjectWiki } from './project-wiki';

describe('ProjectWiki', () => {
  let dir: string;
  let pw: ProjectWiki;
  let wiki: WikiEngine;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'engram-pw-'));
    const paths = new PathResolver(dir);
    const git = new WikiGit(paths);
    await git.ensureRepo();
    wiki = new WikiEngine(paths, git, new KeyedLock()); // indexer 생략(optional)
    pw = new ProjectWiki(wiki);
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('record는 projects/{id} 네임스페이스에 페이지를 생성한다', async () => {
    await pw.record('proj_a', 'auth-notes', '인증 노트', '토큰은 JWT');
    const page = await wiki.getPage('auth-notes', 'projects/proj_a');
    expect(page!.body).toContain('토큰은 JWT');
  });

  it('같은 slug 재호출은 append(보존)한다', async () => {
    await pw.record('proj_a', 'auth-notes', '인증 노트', '첫 사실');
    await pw.record('proj_a', 'auth-notes', '인증 노트', '둘째 사실');
    const page = await wiki.getPage('auth-notes', 'projects/proj_a');
    expect(page!.body).toContain('첫 사실');
    expect(page!.body).toContain('둘째 사실');
  });

  it('같은 slug 동시 record는 직렬화되어 둘 다 보존', async () => {
    await Promise.all([
      pw.record('proj_a', 'notes', '노트', '사실 A'),
      pw.record('proj_a', 'notes', '노트', '사실 B'),
    ]);
    const page = await wiki.getPage('notes', 'projects/proj_a');
    expect(page!.body).toContain('사실 A');
    expect(page!.body).toContain('사실 B');
  });
});
