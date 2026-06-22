import { Module, OnModuleInit } from '@nestjs/common';
import { PathResolver } from '../pal/path-resolver';
import { WikiEngine } from './wiki/wiki-engine';
import { WikiGit } from './wiki/wiki-git';
import { EMBEDDER } from './rag/embedder.port';
import { TransformersEmbedder } from './rag/transformers-embedder';
import { RagStore } from './rag/rag-store';
import { WikiWatcher } from './rag/wiki-watcher';
import { PAGE_INDEXER } from './rag/rag.types';

// KnowledgeCore: 단일 진실원(설계 §5). 시작 시 위키 git + RAG 색인을 보장한다.
@Module({
  providers: [
    { provide: PathResolver, useFactory: () => new PathResolver() },
    WikiGit,
    { provide: EMBEDDER, useClass: TransformersEmbedder },
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
  ) {}

  async onModuleInit(): Promise<void> {
    await this.git.ensureRepo();
    await this.rag.init();
    // 시작 시 published 페이지 전체 재색인(모듈이 조율 → RagStore가 WikiEngine을 역의존하지 않음).
    const pages = await this.wiki.listPages({ status: 'published' });
    await this.rag.reindexAll(
      pages.map((p) => ({
        slug: p.slug,
        title: p.frontmatter.title,
        category: p.frontmatter.category,
        sources: p.frontmatter.sources,
        body: p.body,
      })),
    );
    await this.watcher.start();
  }
}
