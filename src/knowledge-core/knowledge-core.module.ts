import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { PathResolver, DEFAULT_USER } from '../pal/path-resolver';
import { WikiEngine } from './wiki/wiki-engine';
import { WikiGit } from './wiki/wiki-git';
import { EMBEDDER } from './rag/embedder.port';
import { TransformersEmbedder } from './rag/transformers-embedder';
import { CachingEmbedder } from './rag/caching-embedder';
import { RagStore, withBootRetry, BootRetryOptions } from './rag/rag-store';
import { WikiWatcher } from './rag/wiki-watcher';
import { PAGE_INDEXER } from './rag/rag.types';
import { KeyedLock } from './keyed-lock';
import { PinoLogger } from '../pal/logger';
import { ConversationStore } from './conversation-store';
import { ImportanceGate } from './importance-gate';
import { ProposalStore } from './proposal-store';
import { DigestLock } from './digest-lock';
import { TaskStore } from './task-store';
import { ProjectStore } from './project-store';
import { CodingGit } from './coding-git';
import { InsightStore } from './insight/insight-store';
import { InsightContext } from './insight/insight-context';

// 부트 재시도 튜닝값 — 테스트가 overrideProvider로 attempts/baseDelayMs/maxDelayMs를 작게 줄여
// 실시간 대기 없이 재시도 경로를 검증할 수 있게 DI 토큰으로 분리(knowledge-core.module.spec.ts).
export const BOOT_RETRY_OPTIONS = 'BOOT_RETRY_OPTIONS';
export type BootRetryTuning = Pick<BootRetryOptions, 'attempts' | 'baseDelayMs' | 'maxDelayMs'>;

// KnowledgeCore: 단일 진실원(설계 §5). 시작 시 위키 git + RAG 색인을 보장한다.
@Module({
  providers: [
    { provide: PathResolver, useFactory: () => new PathResolver() },
    // ★2026-07-19 실사고: 앱 부팅과 헤드리스 MCP가 동시에 같은 rag 폴더를 열면 RagStore.init()이
    // "Panic in async function"으로 죽어 크래시루프를 탔다 — 앱 부팅이 우선권을 갖도록 재시도.
    { provide: BOOT_RETRY_OPTIONS, useValue: { attempts: 5, baseDelayMs: 2000, maxDelayMs: 8000 } as BootRetryTuning },
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
    ConversationStore,
    { provide: ImportanceGate, useFactory: () => new ImportanceGate() },
    ProposalStore,
    DigestLock,
    {
      provide: TaskStore,
      useFactory: (paths: PathResolver, lock: KeyedLock) => new TaskStore(paths.getStateDir(), lock),
      inject: [PathResolver, KeyedLock],
    },
    // ProjectStore: config/projects/ 디렉터리 기반 코딩 프로젝트 설정 저장(설계 §5.2).
    {
      provide: ProjectStore,
      useFactory: (paths: PathResolver) => new ProjectStore(paths.getProjectsDir()),
      inject: [PathResolver],
    },
    // CodingGit: 타깃 외부 repo git 운전(설계 §4). 경로는 호출자(Orchestrator)가 제공.
    CodingGit,
    // InsightStore: 일일 인사이트 JSON 영속(설계 §5.4). state/insights/{userId}/에 저장.
    { provide: InsightStore, useFactory: (paths: PathResolver) => new InsightStore(paths), inject: [PathResolver] },
    // InsightContext: 최신 인사이트를 ReaderAgent 주입용 문자열로(설계 §5.4·spec A3).
    { provide: InsightContext, useFactory: (store: InsightStore) => new InsightContext(store), inject: [InsightStore] },
  ],
  exports: [PathResolver, WikiEngine, RagStore, PinoLogger, ConversationStore, ImportanceGate, ProposalStore, DigestLock, TaskStore, ProjectStore, CodingGit, InsightStore, InsightContext],
})
export class KnowledgeCoreModule implements OnModuleInit {
  constructor(
    private readonly git: WikiGit,
    private readonly wiki: WikiEngine,
    private readonly rag: RagStore,
    private readonly watcher: WikiWatcher,
    private readonly logger: PinoLogger,
    @Inject(BOOT_RETRY_OPTIONS) private readonly bootRetryOptions: BootRetryTuning,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.git.ensureRepo();
      // RAG open()을 부트 우선권으로 재시도 — 실패마다 warn 로깅, 소진되면 기존과 동일하게
      // catch에서 error 로깅 후 throw(디그레이드, 무한 대기 없음).
      await withBootRetry(() => this.rag.init(), {
        ...this.bootRetryOptions,
        onRetry: (attempt, err, delayMs) => {
          this.logger.warn(
            `KnowledgeCore RAG 초기화 재시도 ${attempt}회차(${delayMs}ms 후 재시도, 크로스 프로세스 경합 추정): ${err.message}`,
            'KnowledgeCoreModule',
          );
        },
      });
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
