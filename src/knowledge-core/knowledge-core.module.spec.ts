import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Test, TestingModule } from '@nestjs/testing';
import { KnowledgeCoreModule } from './knowledge-core.module';
import { WikiEngine } from './wiki/wiki-engine';
import { RagStore } from './rag/rag-store';
import { EMBEDDER } from './rag/embedder.port';
import { FakeEmbedder } from './rag/fake-embedder';
import { PathResolver } from '../pal/path-resolver';

describe('KnowledgeCoreModule (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-kc-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('publish한 페이지를 RagStore에서 검색할 수 있다', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [KnowledgeCoreModule] })
      .overrideProvider(PathResolver).useValue(new PathResolver(dir))
      .overrideProvider(EMBEDDER).useClass(FakeEmbedder)
      .compile();
    // init()이 onModuleInit(ensureRepo → rag.init → reindexAll → watcher.start)을 실행한다.
    await moduleRef.init();

    const wiki = moduleRef.get(WikiEngine);
    const rag = moduleRef.get(RagStore);
    await wiki.createPage({ slug: 'kc', title: 'KC', category: 'c', body: '모듈 통합 본문', status: 'published' });

    const results = await rag.search('모듈 통합', 50);
    expect(results.map((r) => r.slug)).toContain('kc');
    // close()가 WikiWatcher.onModuleDestroy→stop을 호출해 hang을 방지한다.
    await moduleRef.close();
  });
});
