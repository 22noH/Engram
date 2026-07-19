import { Module, OnModuleInit } from '@nestjs/common';
import { PathResolver } from '../pal/path-resolver';
import { WikiGit } from './wiki/wiki-git';
import { KeyedLock } from './keyed-lock';
import { WikiEngine } from './wiki/wiki-engine';
import { ProposalStore } from './proposal-store';
import { PinoLogger } from '../pal/logger';

// 헤드리스 MCP 코어 모드 전용 모듈(근본픽스 2026-07-20 — `npx engram-wiki-mcp` 코어 모드가
// KnowledgeCoreModule/AppModule 전체를 부팅하며 앱과 같은 %APPDATA%\Engram\rag LanceDB 폴더를
// 열어 크로스 프로세스 손상을 일으킨 사고 3건의 근본 원인 제거).
//
// KnowledgeCoreModule과 달리 RagStore/EMBEDDER(TransformersEmbedder/CachingEmbedder)/WikiWatcher를
// 아예 providers에 넣지 않는다 — Nest는 여기 나열된 provider만 인스턴스화하므로 RagStore는 이
// 모듈 그래프에 존재하지 않고, 따라서 RagStore.init()(LanceDB 커넥션을 여는 지점)이 물리적으로
// 호출될 수 없다. 마찬가지로 AgentLayerModule/EdgeModule(BrainModule·DigestScheduler·
// InsightScheduler·MeetingScheduler 등)도 import하지 않는다 — 헤드리스 코어 인스턴스가 N개
// 동시에 떠도(플러그인 세션마다 스폰) 파일 읽기 + wiki 쓰기(git 커밋)만 하는 안전한 경로만 남는다.
//
// WikiEngine의 PAGE_INDEXER는 @Optional()이라 미주입 시 모든 indexer?.xxx 호출이 조용히 no-op —
// 색인은 건너뛰고 wiki.search()는 항상 빈 배열([]).mcp-wiring.ts의 makeWikiMcpDepsCore가 이걸
// makeFileSearch(텍스트 폴백 검색)로 대체해 wiki_search 도구를 계속 동작시킨다.
@Module({
  providers: [
    { provide: PathResolver, useFactory: () => new PathResolver() },
    WikiGit,
    KeyedLock,
    PinoLogger,
    WikiEngine,
    ProposalStore,
  ],
  exports: [PathResolver, WikiGit, WikiEngine, ProposalStore, PinoLogger],
})
export class HeadlessCoreModule implements OnModuleInit {
  constructor(private readonly git: WikiGit) {}

  // KnowledgeCoreModule.onModuleInit과 동형이나 rag.init()/reindexAll/watcher.start가 없다 — 위키
  // git 저장소만 보장(파일 CRUD·커밋에 필요, §5.1). RagStore가 없으므로 §3.2 부트 재시도(withBootRetry)
  // 도 불필요 — 헤드리스는 애초에 그 경합의 당사자가 아니게 된다.
  async onModuleInit(): Promise<void> {
    await this.git.ensureRepo();
  }
}
