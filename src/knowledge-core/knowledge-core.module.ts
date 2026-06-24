import { Module, OnModuleInit } from '@nestjs/common';
import { PathResolver, DEFAULT_USER } from '../pal/path-resolver';
import { WikiEngine } from './wiki/wiki-engine';
import { WikiGit } from './wiki/wiki-git';
import { EMBEDDER } from './rag/embedder.port';
import { TransformersEmbedder } from './rag/transformers-embedder';
import { CachingEmbedder } from './rag/caching-embedder';
import { RagStore } from './rag/rag-store';
import { WikiWatcher } from './rag/wiki-watcher';
import { PAGE_INDEXER } from './rag/rag.types';
import { KeyedLock } from './keyed-lock';
import { PinoLogger } from '../pal/logger';

// KnowledgeCore: 단일 진실원(설계 §5). 시작 시 위키 git + RAG 색인을 보장한다.
@Module({
  providers: [
    { provide: PathResolver, useFactory: () => new PathResolver() },
    WikiGit,
    // 페이지별 쓰기 직렬화 락 — WikiEngine·WikiWatcher 공유(§10.3).
    KeyedLock,
    // 구조화 로깅(pino) — WikiWatcher·KnowledgeCoreModule에 주입된다.
    PinoLogger,
    // TransformersEmbedder를 standalone provider로 등록 후 CachingEmbedder로 감쌈.
    // EMBEDDER override 시(테스트 등) 팩토리가 우회돼 FakeEmbedder가 직접 주입된다.
    TransformersEmbedder,
    {
      provide: EMBEDDER,
      useFactory: (base: TransformersEmbedder) => new CachingEmbedder(base),
      inject: [TransformersEmbedder],
    },
    RagStore,
    { provide: PAGE_INDEXER, useExisting: RagStore },
    WikiWatcher,
    WikiEngine,
  ],
  exports: [WikiEngine, RagStore],
})
export class KnowledgeCoreModule implements OnModuleInit {
  constructor(
    private readonly git: WikiGit,
    private readonly wiki: WikiEngine,
    private readonly rag: RagStore,
    private readonly watcher: WikiWatcher,
    private readonly logger: PinoLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.git.ensureRepo();
      await this.rag.init();
      // 시작 시 published 페이지 전체 재색인(모듈이 조율 → RagStore가 WikiEngine을 역의존하지 않음).
      // 현재 단일사용자 = DEFAULT_USER. reindexAll은 watcher.start() 전이라 동시 쓰기원이 없다(락 불필요).
      const pages = await this.wiki.listPages({ status: 'published' }, DEFAULT_USER);
      await this.rag.reindexAll(
        pages.map((p) => ({
          userId: DEFAULT_USER,
          slug: p.slug,
          title: p.frontmatter.title,
          category: p.frontmatter.category,
          sources: p.frontmatter.sources,
          body: p.body,
        })),
      );
      await this.watcher.start();
    } catch (err) {
      // 한 단계 실패가 프로세스를 죽이지 않게 로깅(설계 §10.3). 데이터는 runtime/에 보존.
      this.logger.error('KnowledgeCore 초기화 실패', String(err), 'KnowledgeCoreModule');
      throw err;
    }
  }
}
