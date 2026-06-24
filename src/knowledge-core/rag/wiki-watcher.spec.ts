import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { WikiWatcher } from './wiki-watcher';
import { PathResolver } from '../../pal/path-resolver';
import { RagStore } from './rag-store';
import { FakeEmbedder } from './fake-embedder';
import { WikiGit } from '../wiki/wiki-git';
import { WikiEngine } from '../wiki/wiki-engine';
import { KeyedLock } from '../keyed-lock';
import { PinoLogger } from '../../pal/logger';
import { DEFAULT_USER } from '../../pal/path-resolver';

// 폴링 헬퍼: 조건이 참이 될 때까지 intervalMs 간격으로 최대 timeoutMs 동안 대기한다.
async function pollUntil(
  condition: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil: 조건이 ${timeoutMs}ms 내에 참이 되지 않았습니다`);
}

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
    // engine과 watcher가 같은 KeyedLock 인스턴스를 공유해 락 조율이 가능하다.
    const lock = new KeyedLock();
    engine = new WikiEngine(paths, git, lock, store);
    watcher = new WikiWatcher(paths, store, engine, lock, new PinoLogger(paths));
  });
  afterEach(async () => {
    await watcher.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('published 페이지 변경은 재색인된다', async () => {
    await engine.createPage({ slug: 'w1', title: 'W1', category: 'c', body: '워처 본문', status: 'published' });
    await watcher.handleChange(DEFAULT_USER, 'w1', 'change');
    const results = await store.search('워처 본문', 50);
    expect(results.map((r) => r.slug)).toContain('w1');
  });

  it('파일 삭제는 색인에서 제거된다', async () => {
    await engine.createPage({ slug: 'w2', title: 'W2', category: 'c', body: '지울 것', status: 'published' });
    await watcher.handleChange(DEFAULT_USER, 'w2', 'unlink');
    const results = await store.search('지울 것', 50);
    expect(results.map((r) => r.slug)).not.toContain('w2');
  });

  it('파일 경로에서 userId와 slug를 파싱한다', () => {
    // parseFile은 private이지만 구조 검증을 위해 타입 우회로 접근한다.
    const file = path.join(dir, 'wiki', 'pages', 'alice', 'note.md');
    expect((watcher as unknown as { parseFile(f: string): unknown }).parseFile(file)).toEqual({
      userId: 'alice', slug: 'note',
    });
  });

  it('handleChange는 userId 범위로 색인한다', async () => {
    // alice 사용자 페이지를 생성하고 색인 후 alice/bob 격리를 검증한다.
    await engine.createPage(
      { slug: 'note', title: 'A', category: 'c', body: 'alice content here', status: 'published' },
      'alice',
    );
    await watcher.handleChange('alice', 'note', 'change');
    const alice = await store.search('alice content', 50, 'alice');
    expect(alice.map((r) => r.slug)).toContain('note');
    const bob = await store.search('alice content', 50, 'bob');
    expect(bob.map((r) => r.slug)).not.toContain('note');
  });

  it('handleChange(unlink)는 userId 범위로 제거한다', async () => {
    // alice 사용자 페이지를 제거 후 alice 범위에서 사라지는지 검증한다.
    await engine.createPage(
      { slug: 'gone', title: 'G', category: 'c', body: 'remove me alpha', status: 'published' },
      'alice',
    );
    await watcher.handleChange('alice', 'gone', 'unlink');
    const alice = await store.search('remove me', 50, 'alice');
    expect(alice.map((r) => r.slug)).not.toContain('gone');
  });
});

// start() 통합 테스트: chokidar v4 디렉토리 감시가 실제 .md 파일 변경을 잡는지 검증한다.
// 플레이키 억제를 위해 폴링 헬퍼로 최대 5초 대기한다.
describe('WikiWatcher.start() 통합', () => {
  let dir: string;
  let watcher: WikiWatcher;
  let store: RagStore;
  let engine: WikiEngine;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-watchstart-'));
    const paths = new PathResolver(dir);
    const git = new WikiGit(paths);
    await git.ensureRepo();
    store = new RagStore(paths, new FakeEmbedder());
    await store.init();
    // engine과 watcher가 같은 KeyedLock 인스턴스를 공유해 락 조율이 가능하다.
    const lock = new KeyedLock();
    engine = new WikiEngine(paths, git, lock, store);
    watcher = new WikiWatcher(paths, store, engine, lock, new PinoLogger(paths));
  });
  afterEach(async () => {
    await watcher.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it(
    'start() 후 .md 파일이 생성되면 debounce + chokidar 지연 후 자동 색인된다',
    async () => {
      await watcher.start();

      // published 페이지를 WikiEngine으로 생성 → wiki/pages/default/ 하위에 .md 파일이 쓰인다.
      await engine.createPage({
        slug: 'watch-start-test',
        title: 'Watch Start Test',
        category: 'integration',
        body: 'chokidar v4 start 통합 검증 본문',
        status: 'published',
      });

      // debounce(300ms) + chokidar 지연을 감안해 최대 5초 폴링
      await pollUntil(async () => {
        const results = await store.search('start 통합 검증', 50);
        return results.some((r) => r.slug === 'watch-start-test');
      }, 5000, 100);

      const results = await store.search('start 통합 검증', 50);
      expect(results.map((r) => r.slug)).toContain('watch-start-test');
    },
    10_000, // jest 타임아웃 10초
  );
});
