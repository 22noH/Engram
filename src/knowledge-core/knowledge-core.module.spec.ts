import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Test, TestingModule } from '@nestjs/testing';
import { KnowledgeCoreModule, BOOT_RETRY_OPTIONS, REINDEX_DELAY_MS } from './knowledge-core.module';
import { WikiEngine } from './wiki/wiki-engine';
import { RagStore } from './rag/rag-store';
import { EMBEDDER } from './rag/embedder.port';
import { FakeEmbedder } from './rag/fake-embedder';
import { CachingEmbedder } from './rag/caching-embedder';
import { IndexablePage } from './rag/rag.types';
import { serializePage } from './wiki/page-serializer';
import { PathResolver, DEFAULT_USER } from '../pal/path-resolver';
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
    // 실패한 expect가 close()·env 복원을 건너뛰면 chokidar 워처가 열린 채 남아 jest가 영원히
    // 멈춘다(실측) — 반드시 afterEach에서 정리한다.
    let moduleRef: TestingModule | undefined;
    const ORIGINAL_RESIDENT = process.env.ENGRAM_RESIDENT;

    afterEach(async () => {
      if (ORIGINAL_RESIDENT === undefined) delete process.env.ENGRAM_RESIDENT;
      else process.env.ENGRAM_RESIDENT = ORIGINAL_RESIDENT;
      await moduleRef?.close();
      moduleRef = undefined;
    });

    function fakeRagStore(
      init: jest.Mock,
      opts: { quarantineAndReinit?: jest.Mock; indexPage?: jest.Mock } = {},
    ): RagStore {
      return {
        init,
        quarantineAndReinit: opts.quarantineAndReinit ?? jest.fn(),
        reindexAll: jest.fn().mockResolvedValue(undefined),
        search: jest.fn(),
        indexPage: opts.indexPage ?? jest.fn(),
        removePage: jest.fn(),
      } as unknown as RagStore;
    }

    // published 페이지 .md를 WikiEngine(색인 트리거)을 우회해 직접 쓴다 — 백그라운드 재색인
    // 루프만이 이 페이지들을 색인하도록(테스트 격리: indexPage 호출 출처가 명확해진다).
    async function writePublishedPage(baseDir: string, slug: string, body: string): Promise<void> {
      const pagesDir = new PathResolver(baseDir).getWikiPagesDir(DEFAULT_USER);
      await fs.mkdir(pagesDir, { recursive: true });
      const now = new Date().toISOString();
      await fs.writeFile(
        path.join(pagesDir, `${slug}.md`),
        serializePage({
          slug,
          frontmatter: { title: slug, category: 'c', status: 'published', sources: [], created: now, updated: now },
          body,
        }),
      );
    }

    it('N번 실패 후 성공하면 init이 성공하고 재시도마다 warn 로그를 남긴다', async () => {
      let n = 0;
      const init = jest.fn(async () => {
        if (++n < 3) throw new Error('Error: Panic in async function');
      });
      const rag = fakeRagStore(init);
      const ref = await Test.createTestingModule({ imports: [KnowledgeCoreModule] })
        .overrideProvider(PathResolver).useValue(new PathResolver(dir))
        .overrideProvider(EMBEDDER).useClass(FakeEmbedder)
        .overrideProvider(RagStore).useValue(rag)
        .overrideProvider(BOOT_RETRY_OPTIONS).useValue({ attempts: 5, baseDelayMs: 1, maxDelayMs: 2 })
        .compile();
      moduleRef = ref;

      const logger = ref.get(PinoLogger);
      const warnSpy = jest.spyOn(logger, 'warn');

      await ref.init();

      expect(init).toHaveBeenCalledTimes(3);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(String(warnSpy.mock.calls[0][0])).toContain('재시도');
      // 정상 오픈이라 격리는 시도조차 되지 않는다.
      expect(rag.quarantineAndReinit).not.toHaveBeenCalled();
    });

    // ①②④ 부트 자가치유(근본픽스 2026-07-20): withBootRetry 소진 후에도 오늘처럼 throw로
    // 프로세스를 죽이지 않는다 — 손상 격리(rename)+재생성을 시도하고, 결과에 따라 healed/degraded로
    // 갈라진다. 두 경로 모두 moduleRef.init()은 resolve해야 한다(크래시 없음이 핵심 회귀 방지 대상).
    it('① 재시도 소진 후 격리(rename)+재생성 성공 → throw 없이 부팅 완료, 백그라운드 재색인 예약', async () => {
      const init = jest.fn(async () => { throw new Error('Error: Panic in async function'); });
      const quarantineAndReinit = jest.fn().mockResolvedValue(undefined);
      const rag = fakeRagStore(init, { quarantineAndReinit });
      const ref = await Test.createTestingModule({ imports: [KnowledgeCoreModule] })
        .overrideProvider(PathResolver).useValue(new PathResolver(dir))
        .overrideProvider(EMBEDDER).useClass(FakeEmbedder)
        .overrideProvider(RagStore).useValue(rag)
        .overrideProvider(BOOT_RETRY_OPTIONS).useValue({ attempts: 3, baseDelayMs: 1, maxDelayMs: 2 })
        .overrideProvider(REINDEX_DELAY_MS).useValue(5) // 실시간 30초 대기 없이 배경 재색인을 검증
        .compile();
      moduleRef = ref;

      const logger = ref.get(PinoLogger);
      const errorSpy = jest.spyOn(logger, 'error');
      const warnSpy = jest.spyOn(logger, 'warn');

      process.env.ENGRAM_RESIDENT = '1'; // 상주(앱) 부팅 시뮬레이션 — 백그라운드 재색인이 실행되게

      // 정상 부팅된다 — throw하지 않는다(init은 컨텍스트를 resolve한다).
      await expect(ref.init()).resolves.toBeDefined();

      expect(init).toHaveBeenCalledTimes(3); // withBootRetry 소진
      expect(quarantineAndReinit).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('손상 격리'),
        expect.stringContaining('Panic in async function'),
        'KnowledgeCoreModule',
      );
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('격리·재생성 성공'))).toBe(true);

      // 백그라운드 재색인 타이머(5ms) 발화 대기 — indexPage가 아직 호출 안 됐어도 최소한
      // reindexAll(정상 경로 전용)은 호출되지 않아야 한다(격리 경로는 백그라운드 개별 색인을 쓴다).
      await new Promise((r) => setTimeout(r, 50));
      expect(rag.reindexAll).not.toHaveBeenCalled();
    });

    // ②④ 격리(rename)마저 실패하는 최악의 경우 — RagStore.quarantineAndReinit()이 시임에서 이미
    // 몇 차례 재시도 후 포기(rag-store.spec.ts에서 별도 검증)하므로, 여기서는 그 실패가 모듈
    // 부팅을 죽이지 않고 디그레이드로 안전하게 흡수되는지만 확인한다.
    it('② 격리(rename)도 실패 → 디그레이드로 폴백, throw 없음(크래시 없음 — 오늘보다 더 나쁘게 죽지 않는다)', async () => {
      const init = jest.fn(async () => { throw new Error('Error: Panic in async function'); });
      const quarantineAndReinit = jest.fn().mockRejectedValue(new Error('EBUSY: resource busy or locked'));
      const rag = fakeRagStore(init, { quarantineAndReinit });
      const ref = await Test.createTestingModule({ imports: [KnowledgeCoreModule] })
        .overrideProvider(PathResolver).useValue(new PathResolver(dir))
        .overrideProvider(EMBEDDER).useClass(FakeEmbedder)
        .overrideProvider(RagStore).useValue(rag)
        .overrideProvider(BOOT_RETRY_OPTIONS).useValue({ attempts: 3, baseDelayMs: 1, maxDelayMs: 2 })
        .compile();
      moduleRef = ref;

      const logger = ref.get(PinoLogger);
      const errorSpy = jest.spyOn(logger, 'error');

      // ④ 핵심 회귀 방지: init 하드 실패의 최종 상태는 "디그레이드"지 "프로세스 죽음"이 아니다.
      await expect(ref.init()).resolves.toBeDefined();

      expect(quarantineAndReinit).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('디그레이드'),
        expect.stringContaining('EBUSY'),
        'KnowledgeCoreModule',
      );
      // 정상 경로(reindexAll)도, 격리 후 배경 재색인(indexPage)도 호출되지 않는다 — rag 기능 완전 비활성.
      expect(rag.reindexAll).not.toHaveBeenCalled();
      expect(rag.indexPage).not.toHaveBeenCalled();
    });

    // 리뷰 후속(오탐 격리 방지): Lance 패턴이 아닌 에러(AV/OneDrive의 일시적 파일 락 등)라도 부트는
    // 1회차에 즉시 포기하지 않는다 — 전체 재시도 스케줄을 다 소진한 뒤에야 격리(quarantineAndReinit)로
    // 넘어간다. 예전 시맨틱(즉시 포기 후 즉시 격리)은 건강한 스토어를 일시적 에러 1회만으로
    // 오탐 격리(전체 재임베드 비용+rag.corrupt-* 누적)했다.
    it('재시도 불가능한 종류의 에러도 부트에서는 전체 재시도 스케줄을 소진한 뒤에야 격리한다(오탐 격리 방지)', async () => {
      const init = jest.fn(async () => { throw new Error('ENOENT: no such file'); });
      const quarantineAndReinit = jest.fn().mockResolvedValue(undefined);
      const rag = fakeRagStore(init, { quarantineAndReinit });
      const ref = await Test.createTestingModule({ imports: [KnowledgeCoreModule] })
        .overrideProvider(PathResolver).useValue(new PathResolver(dir))
        .overrideProvider(EMBEDDER).useClass(FakeEmbedder)
        .overrideProvider(RagStore).useValue(rag)
        .overrideProvider(BOOT_RETRY_OPTIONS).useValue({ attempts: 5, baseDelayMs: 1, maxDelayMs: 2 })
        .overrideProvider(REINDEX_DELAY_MS).useValue(5)
        .compile();
      moduleRef = ref;

      await expect(ref.init()).resolves.toBeDefined();
      expect(init).toHaveBeenCalledTimes(5); // 패턴 무관하게 attempts(5)를 전부 소진한다
      expect(quarantineAndReinit).toHaveBeenCalledTimes(1); // 소진 후에야 자가치유를 시도한다
    });

    // ①: 비-Lance 패턴 에러라도 스케줄 중간(3회차)에 회복되면 격리 없이 정상 부팅된다.
    it('재시도 불가능한 종류의 에러도 스케줄 중 회복되면 격리 없이 정상 부팅된다(① 오탐 격리 방지)', async () => {
      let n = 0;
      const init = jest.fn(async () => {
        if (++n < 3) throw new Error('EBUSY: resource busy or locked'); // Lance 패턴 아님
      });
      const quarantineAndReinit = jest.fn().mockResolvedValue(undefined);
      const rag = fakeRagStore(init, { quarantineAndReinit });
      const ref = await Test.createTestingModule({ imports: [KnowledgeCoreModule] })
        .overrideProvider(PathResolver).useValue(new PathResolver(dir))
        .overrideProvider(EMBEDDER).useClass(FakeEmbedder)
        .overrideProvider(RagStore).useValue(rag)
        .overrideProvider(BOOT_RETRY_OPTIONS).useValue({ attempts: 5, baseDelayMs: 1, maxDelayMs: 2 })
        .compile();
      moduleRef = ref;

      await expect(ref.init()).resolves.toBeDefined();
      expect(init).toHaveBeenCalledTimes(3); // 3회차에 회복
      expect(quarantineAndReinit).not.toHaveBeenCalled(); // 격리 없음 — 오탐 방지 핵심
    });

    // ③ 백그라운드 재색인이 한 페이지 실패에도 나머지를 계속 진행하는지 검증.
    // 페이지 3개(.md)를 WikiEngine 색인 트리거를 우회해 부팅 전에 직접 써 둔다 — 배경 재색인
    // 타이머(5ms)가 부팅 직후 발화하므로, indexPage 호출은 전부 배경 루프에서만 나온다(출처 명확).
    it('③ 격리 후 백그라운드 재색인 — N개 페이지 색인, 한 페이지가 실패해도 나머지는 계속된다', async () => {
      await writePublishedPage(dir, 'p1', '첫째 본문');
      await writePublishedPage(dir, 'p2', '둘째 본문');
      await writePublishedPage(dir, 'bad', '셋째 본문(색인 실패 대상)');

      const init = jest.fn(async () => { throw new Error('Error: Panic in async function'); });
      const quarantineAndReinit = jest.fn().mockResolvedValue(undefined);
      const indexPage = jest.fn(async (page: IndexablePage) => {
        if (page.slug === 'bad') throw new Error('boom: 색인 실패 시뮬레이션');
      });
      const rag = fakeRagStore(init, { quarantineAndReinit, indexPage });
      const ref = await Test.createTestingModule({ imports: [KnowledgeCoreModule] })
        .overrideProvider(PathResolver).useValue(new PathResolver(dir))
        .overrideProvider(EMBEDDER).useClass(FakeEmbedder)
        .overrideProvider(RagStore).useValue(rag)
        .overrideProvider(BOOT_RETRY_OPTIONS).useValue({ attempts: 2, baseDelayMs: 1, maxDelayMs: 2 })
        .overrideProvider(REINDEX_DELAY_MS).useValue(5)
        .compile();
      moduleRef = ref;

      const logger = ref.get(PinoLogger);
      const logSpy = jest.spyOn(logger, 'log');
      const errorSpy = jest.spyOn(logger, 'error');

      process.env.ENGRAM_RESIDENT = '1';

      await ref.init();

      // 배경 재색인 완료 로그가 남을 때까지 폴링(타이머 5ms + 페이지 3건 — 넉넉히 2초 상한).
      const deadline = Date.now() + 2000;
      const done = () => logSpy.mock.calls.some((c) => String(c[0]).includes('전체 재색인 완료'));
      while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));

      const slugs = indexPage.mock.calls.map((c) => (c[0] as IndexablePage).slug);
      expect(slugs).toEqual(expect.arrayContaining(['p1', 'p2', 'bad'])); // 3건 모두 시도됐다
      // bad 하나만 실패하고 나머지는 계속 진행 — 완료 로그가 "2/3건" 성공으로 남는다.
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('전체 재색인 완료(2/3건)'))).toBe(true);
      expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('재색인 실패: bad'))).toBe(true);
    });

    it('ENGRAM_RESIDENT 미설정(CLI 등 원샷 부팅) — 격리 성공해도 백그라운드 재색인은 예약하지 않는다', async () => {
      await writePublishedPage(dir, 'p1', '첫째 본문');

      const init = jest.fn(async () => { throw new Error('Error: Panic in async function'); });
      const quarantineAndReinit = jest.fn().mockResolvedValue(undefined);
      const indexPage = jest.fn();
      const rag = fakeRagStore(init, { quarantineAndReinit, indexPage });
      const ref = await Test.createTestingModule({ imports: [KnowledgeCoreModule] })
        .overrideProvider(PathResolver).useValue(new PathResolver(dir))
        .overrideProvider(EMBEDDER).useClass(FakeEmbedder)
        .overrideProvider(RagStore).useValue(rag)
        .overrideProvider(BOOT_RETRY_OPTIONS).useValue({ attempts: 2, baseDelayMs: 1, maxDelayMs: 2 })
        .overrideProvider(REINDEX_DELAY_MS).useValue(5)
        .compile();
      moduleRef = ref;

      delete process.env.ENGRAM_RESIDENT; // cli.ts 등 원샷 부팅 시뮬레이션(main.ts만 이 값을 세팅한다)

      await ref.init();
      await new Promise((r) => setTimeout(r, 50));
      expect(indexPage).not.toHaveBeenCalled();
    });
  });
});
