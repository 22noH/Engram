import * as path from 'path';
import { Module, OnModuleInit } from '@nestjs/common';
import { KnowledgeCoreModule } from '../knowledge-core/knowledge-core.module';
import { BrainModule } from '../brain/brain.module';
import { ReaderAgent } from './reader-agent';
import { Orchestrator } from './orchestrator';
import { IngesterAgent } from './ingester-agent';
import { PersonaRegistry } from './persona-registry';
import { PermissionFence } from './permission-fence';
import { SpecialistAgent } from './specialist-agent';
import { CodingSpecialist } from './coding-specialist';
import { ReviewerAgent } from './reviewer-agent';
import { ProjectWiki } from './project-wiki';
import { Synthesizer } from './synthesizer';
import { MeetingEngine } from './meeting-engine';
import { TaskStore } from '../knowledge-core/task-store';
import { ProjectStore } from '../knowledge-core/project-store';
import { CodingGit } from '../knowledge-core/coding-git';
import { RagStore } from '../knowledge-core/rag/rag-store';
import { WikiEngine } from '../knowledge-core/wiki/wiki-engine';
import { PinoLogger } from '../pal/logger';
import { PathResolver } from '../pal/path-resolver';
import { findRepoRoot } from '../pal/repo-root';
import { resolveResourceDir } from '../pal/resource-dir';
import { ConversationStore } from '../knowledge-core/conversation-store';
import { BRAIN, JUDGE_BRAIN, BrainProvider } from '../brain/brain.port';
import { Semaphore } from '../brain/semaphore';
import { createBrain } from '../brain/brain.factory';
import { loadBrainProfile, listBrainNames } from '../brain/brain.config';
import { VerificationGate } from './verification-gate';
import { InsightReporter } from './insight-reporter';
import { BrainDelegator } from './brain-delegator';
import { ChannelBrainResolver, BRAIN_NAME_RESOLVE, BrainNameResolve } from './channel-brain-resolver';

// AgentLayer(설계 §7). 코어(RagStore·PinoLogger)와 두뇌(BRAIN)를 소비.
@Module({
  imports: [KnowledgeCoreModule, BrainModule],
  providers: [
    ReaderAgent,
    // 이름→두뇌 캐시(8d 위임기 정책 — 프로필별 새 인스턴스·고유 세마포어). 위임기·채널 두뇌 해소(Task 2)가
    // 이 하나의 캐시를 공유한다(새 캐시 금지 — 같은 이름은 어느 경로로 와도 같은 인스턴스).
    // ★'claude'를 주입 BRAIN으로 pre-seed하지 않는다. 위임/채널 두뇌 이름은 brains.json 실키(listBrainNames)라
    // 'claude'는 진짜 claude-cli 프로필. 주입 BRAIN(=지휘자 자신)으로 alias하면 (1)'claude' 위임이 지휘자를
    // 다시 돌려 데드락(같은 Semaphore 재진입), (2)사용자가 지목한 claude-cli 대신 엉뚱한 두뇌가 돈다.
    // 그래서 항상 프로필로부터 새 인스턴스(고유 Semaphore)로 해소.
    {
      provide: BRAIN_NAME_RESOLVE,
      useFactory: (paths: PathResolver): BrainNameResolve => {
        const cache = new Map<string, BrainProvider>();
        return (key: string): BrainProvider => {
          if (!cache.has(key)) cache.set(key, createBrain(loadBrainProfile(paths.getConfigDir(), key), paths.getConfigDir()));
          return cache.get(key)!;
        };
      },
      inject: [PathResolver],
    },
    {
      provide: BrainDelegator,
      useFactory: (resolve: BrainNameResolve, paths: PathResolver) =>
        new BrainDelegator(resolve, () => listBrainNames(paths.getConfigDir())),
      inject: [BRAIN_NAME_RESOLVE, PathResolver],
    },
    // 채널별 두뇌 해소(스펙 §3.2). 이름 미지정=주입 BRAIN, 이름 지정=위와 동일 캐시로 resolve, 실패=기본+warn.
    {
      provide: ChannelBrainResolver,
      useFactory: (resolve: BrainNameResolve, defaultBrain: BrainProvider, logger: PinoLogger) =>
        new ChannelBrainResolver(resolve, defaultBrain, logger),
      inject: [BRAIN_NAME_RESOLVE, BRAIN, PinoLogger],
    },
    IngesterAgent,
    // personas 디렉토리는 절대경로로 해소(테스트 cwd 무관): dataDir 오버라이드 우선, 없으면 레포/앱 루트(Phase 7).
    {
      provide: PersonaRegistry,
      useFactory: (logger: PinoLogger) => {
        // ENGRAM_DATA_DIR/personas가 있으면 사용자 편집본, 없으면 번들본(package.json 보유 루트).
        const personasDir = resolveResourceDir('personas');
        return new PersonaRegistry(personasDir, logger);
      },
      inject: [PinoLogger],
    },
    {
      provide: PermissionFence,
      useFactory: async (paths: PathResolver) => {
        // 자기수정 백스톱(§9 ③): engramRoot는 빌드(dist)/테스트(src) 무관하게 *진짜* 레포 루트여야 한다.
        // __dirname 깊이 의존은 빌드 시 dist/를 가리켜 백스톱을 무력화하므로 package.json 탐색으로 해소.
        const engramRoot = findRepoRoot(__dirname);
        const fence = new PermissionFence(path.join(paths.getConfigDir(), 'permissions.json'), engramRoot);
        await fence.load();
        return fence;
      },
      inject: [PathResolver],
    },
    // SpecialistAgent: BRAIN 토큰을 우선 사용 → FakeBrain override가 테스트에서 동작.
    // persona.brain이 'claude'(기본 프로필명) → 주입된 BRAIN 반환, 그 외 → createBrain(loadBrainProfile(...)).
    {
      provide: SpecialistAgent,
      useFactory: (
        registry: PersonaRegistry,
        fence: PermissionFence,
        rag: RagStore,
        logger: PinoLogger,
        paths: PathResolver,
        defaultBrain: BrainProvider,
      ) => {
        const cache = new Map<string, BrainProvider>();
        // 'claude' 키(brains.json default 프로필명)는 DI 주입 BRAIN으로 고정 — FakeBrain override 관통.
        cache.set('claude', defaultBrain);
        const resolveBrain = (key: string): BrainProvider => {
          if (!cache.has(key)) {
            cache.set(key, createBrain(loadBrainProfile(paths.getConfigDir(), key), paths.getConfigDir()));
          }
          return cache.get(key)!;
        };
        return new SpecialistAgent(registry, fence, resolveBrain, rag, logger);
      },
      inject: [PersonaRegistry, PermissionFence, RagStore, PinoLogger, PathResolver, BRAIN],
    },
    // CodingSpecialist: SpecialistAgent와 동일 패턴(BRAIN 기본 + 캐시).
    {
      provide: CodingSpecialist,
      useFactory: (
        registry: PersonaRegistry,
        fence: PermissionFence,
        logger: PinoLogger,
        paths: PathResolver,
        defaultBrain: BrainProvider,
      ) => {
        const cache = new Map<string, BrainProvider>();
        cache.set('claude', defaultBrain);
        const resolveBrain = (key: string): BrainProvider => {
          if (!cache.has(key)) {
            cache.set(key, createBrain(loadBrainProfile(paths.getConfigDir(), key), paths.getConfigDir()));
          }
          return cache.get(key)!;
        };
        return new CodingSpecialist(registry, fence, resolveBrain, logger);
      },
      inject: [PersonaRegistry, PermissionFence, PinoLogger, PathResolver, BRAIN],
    },
    // Synthesizer: JUDGE_BRAIN 사용(작성자≠종합자, seam #5).
    {
      provide: Synthesizer,
      useFactory: (judgeBrain: BrainProvider) => new Synthesizer(judgeBrain),
      inject: [JUDGE_BRAIN],
    },
    MeetingEngine,
    VerificationGate,
    InsightReporter,
    // ReviewerAgent: JUDGE_BRAIN 사용(작성자≠검증자, seam #5).
    {
      provide: ReviewerAgent,
      useFactory: (judgeBrain: BrainProvider) => new ReviewerAgent(judgeBrain),
      inject: [JUDGE_BRAIN],
    },
    // ProjectWiki: findings 저장(설계 §5.3). WikiEngine을 KnowledgeCore에서 소비.
    {
      provide: ProjectWiki,
      useFactory: (wiki: WikiEngine) => new ProjectWiki(wiki),
      inject: [WikiEngine],
    },
    // Orchestrator: 코딩 협력자 6개 추가 — 생성자 15인자 순서대로 전달.
    // inject 배열 순서 = useFactory 인자 순서 (sem은 내부 생성, inject 제외).
    {
      provide: Orchestrator,
      useFactory: (
        reader: ReaderAgent,
        conversations: ConversationStore,
        logger: PinoLogger,
        ingester: IngesterAgent,
        tasks: TaskStore,
        specialist: SpecialistAgent,
        synthesizer: Synthesizer,
        projects: ProjectStore,
        gate: VerificationGate,
        codingGit: CodingGit,
        coder: CodingSpecialist,
        reviewer: ReviewerAgent,
        codeBrain: BrainProvider,
        fence: PermissionFence,
        reporter: InsightReporter,
        registry: PersonaRegistry,
        paths: PathResolver,
        rag: RagStore,
        channelBrain: ChannelBrainResolver,
      ) => {
        const sem = new Semaphore(2);
        return new Orchestrator(
          reader, conversations, logger, ingester, tasks, specialist, synthesizer, sem,
          projects, gate, codingGit, coder, reviewer, codeBrain, fence, reporter, registry, paths,
          rag, channelBrain,
        );
      },
      inject: [
        ReaderAgent, ConversationStore, PinoLogger, IngesterAgent, TaskStore,
        SpecialistAgent, Synthesizer,
        ProjectStore, VerificationGate, CodingGit, CodingSpecialist, ReviewerAgent,
        BRAIN, PermissionFence, InsightReporter, PersonaRegistry, PathResolver, RagStore,
        ChannelBrainResolver,
      ],
    },
  ],
  exports: [Orchestrator, MeetingEngine, PersonaRegistry, PermissionFence, VerificationGate, CodingSpecialist, ReviewerAgent, ProjectWiki],
})
export class AgentLayerModule implements OnModuleInit {
  constructor(private readonly registry: PersonaRegistry) {}

  async onModuleInit(): Promise<void> {
    await this.registry.load();
  }
}
