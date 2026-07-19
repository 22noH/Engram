import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Test, TestingModule } from '@nestjs/testing';
import { KnowledgeCoreModule, BOOT_RETRY_OPTIONS } from './knowledge-core.module';
import { WikiEngine } from './wiki/wiki-engine';
import { RagStore } from './rag/rag-store';
import { EMBEDDER } from './rag/embedder.port';
import { FakeEmbedder } from './rag/fake-embedder';
import { CachingEmbedder } from './rag/caching-embedder';
import { PathResolver } from '../pal/path-resolver';
import { PinoLogger } from '../pal/logger';

describe('KnowledgeCoreModule (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-kc-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // EMBEDDER override 없이 compile()만 — .init() 미호출이라 onModuleInit·실모델 로드가 일어나지 않음.
  it('EMBEDDER는 CachingEmbedder로 래핑된다', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [KnowledgeCoreModule] })
      .overrideProvider(PathResolver).useValue(new PathResolver(dir))
      .compile(); // .init() 호출 안 함 → onModuleInit 미실행 → 실모델 로드 없음
    const embedder = moduleRef.get(EMBEDDER);
    expect(embedder).toBeInstanceOf(CachingEmbedder);
    await moduleRef.close();
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

  // ★2026-07-19 실사고: 앱 부팅과 헤드리스 MCP가 같은 rag 폴더를 동시에 열면 RagStore.init()이
  // "Panic in async function"으로 죽었다 — 앱 부팅이 재시도로 우선권을 갖는지 검증.
  // BOOT_RETRY_OPTIONS를 작은 값으로 override해 실시간 대기 없이 재시도 경로를 확인한다.
  describe('onModuleInit — RAG 부트 재시도(부트 우선권)', () => {
    function fakeRagStore(init: jest.Mock): RagStore {
      return {
        init,
        reindexAll: jest.fn().mockResolvedValue(undefined),
        search: jest.fn(),
        indexPage: jest.fn(),
        removePage: jest.fn(),
      } as unknown as RagStore;
    }

    it('N번 실패 후 성공하면 init이 성공하고 재시도마다 warn 로그를 남긴다', async () => {
      let n = 0;
      const init = jest.fn(async () => {
        if (++n < 3) throw new Error('Error: Panic in async function');
      });
      const rag = fakeRagStore(init);
      const moduleRef = await Test.createTestingModule({ imports: [KnowledgeCoreModule] })
        .overrideProvider(PathResolver).useValue(new PathResolver(dir))
        .overrideProvider(EMBEDDER).useClass(FakeEmbedder)
        .overrideProvider(RagStore).useValue(rag)
        .overrideProvider(BOOT_RETRY_OPTIONS).useValue({ attempts: 5, baseDelayMs: 1, maxDelayMs: 2 })
        .compile();

      const logger = moduleRef.get(PinoLogger);
      const warnSpy = jest.spyOn(logger, 'warn');

      await moduleRef.init();

      expect(init).toHaveBeenCalledTimes(3);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(String(warnSpy.mock.calls[0][0])).toContain('재시도');

      await moduleRef.close();
    });

    it('영구 실패 시 재시도를 소진한 뒤 오늘과 동일하게 실패 로그 후 throw(디그레이드, 무한 대기 없음)', async () => {
      const init = jest.fn(async () => { throw new Error('Error: Panic in async function'); });
      const rag = fakeRagStore(init);
      const moduleRef = await Test.createTestingModule({ imports: [KnowledgeCoreModule] })
        .overrideProvider(PathResolver).useValue(new PathResolver(dir))
        .overrideProvider(EMBEDDER).useClass(FakeEmbedder)
        .overrideProvider(RagStore).useValue(rag)
        .overrideProvider(BOOT_RETRY_OPTIONS).useValue({ attempts: 3, baseDelayMs: 1, maxDelayMs: 2 })
        .compile();

      const logger = moduleRef.get(PinoLogger);
      const errorSpy = jest.spyOn(logger, 'error');

      await expect(moduleRef.init()).rejects.toThrow('Panic in async function');
      expect(init).toHaveBeenCalledTimes(3);
      expect(errorSpy).toHaveBeenCalledWith('KnowledgeCore 초기화 실패', expect.stringContaining('Panic in async function'), 'KnowledgeCoreModule');
    });

    it('재시도 없이도 재시도 불가능한 에러는 즉시 실패한다(retry 낭비 없음)', async () => {
      const init = jest.fn(async () => { throw new Error('ENOENT: no such file'); });
      const rag = fakeRagStore(init);
      const moduleRef = await Test.createTestingModule({ imports: [KnowledgeCoreModule] })
        .overrideProvider(PathResolver).useValue(new PathResolver(dir))
        .overrideProvider(EMBEDDER).useClass(FakeEmbedder)
        .overrideProvider(RagStore).useValue(rag)
        .overrideProvider(BOOT_RETRY_OPTIONS).useValue({ attempts: 5, baseDelayMs: 1, maxDelayMs: 2 })
        .compile();

      await expect(moduleRef.init()).rejects.toThrow('ENOENT');
      expect(init).toHaveBeenCalledTimes(1);
    });
  });
});
