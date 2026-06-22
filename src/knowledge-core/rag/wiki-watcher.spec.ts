import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { WikiWatcher } from './wiki-watcher';
import { PathResolver } from '../../pal/path-resolver';
import { RagStore } from './rag-store';
import { FakeEmbedder } from './fake-embedder';
import { WikiGit } from '../wiki/wiki-git';
import { WikiEngine } from '../wiki/wiki-engine';

describe('WikiWatcher.handleChange', () => {
  let dir: string;
  let watcher: WikiWatcher;
  let store: RagStore;
  let engine: WikiEngine;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-watch-'));
    const paths = new PathResolver(dir);
    const git = new WikiGit(paths);
    await git.ensureRepo();
    store = new RagStore(paths, new FakeEmbedder());
    await store.init();
    engine = new WikiEngine(paths, git, store);
    watcher = new WikiWatcher(paths, store, engine);
  });
  afterEach(async () => {
    await watcher.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('published 페이지 변경은 재색인된다', async () => {
    await engine.createPage({ slug: 'w1', title: 'W1', category: 'c', body: '워처 본문', status: 'published' });
    await watcher.handleChange('w1', 'change');
    const results = await store.search('워처 본문', 50);
    expect(results.map((r) => r.slug)).toContain('w1');
  });

  it('파일 삭제는 색인에서 제거된다', async () => {
    await engine.createPage({ slug: 'w2', title: 'W2', category: 'c', body: '지울 것', status: 'published' });
    await watcher.handleChange('w2', 'unlink');
    const results = await store.search('지울 것', 50);
    expect(results.map((r) => r.slug)).not.toContain('w2');
  });
});
