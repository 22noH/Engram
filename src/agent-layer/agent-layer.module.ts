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
import { ConversationStore } from '../knowledge-core/conversation-store';
import { BRAIN, JUDGE_BRAIN, BrainProvider } from '../brain/brain.port';
import { Semaphore } from '../brain/semaphore';
import { createBrain } from '../brain/brain.factory';
import { loadBrainProfile } from '../brain/brain.config';
import { VerificationGate } from './verification-gate';
import { InsightReporter } from './insight-reporter';

// AgentLayer(설계 §7). 코어(RagStore·PinoLogger)와 두뇌(BRAIN)를 소비.
@Module({
  imports: [KnowledgeCoreModule, BrainModule],
  providers: [
    ReaderAgent,
    IngesterAgent,
    // personas 디렉토리는 항상 레포 루트 기준 절대경로로 해소(테스트 cwd 무관).
    {
      provide: PersonaRegistry,
      useFactory: (logger: PinoLogger) => {
        // 빌드 레이아웃 무관하게 레포 루트(package.json 보유)를 찾아 personas 해소.
        const personasDir = path.join(findRepoRoot(__dirname), 'personas');
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
            cache.set(key, createBrain(loadBrainProfile(paths.getConfigDir(), key)));
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
            cache.set(key, createBrain(loadBrainProfile(paths.getConfigDir(), key)));
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
      ) => {
        const sem = new Semaphore(2);
        return new Orchestrator(
          reader, conversations, logger, ingester, tasks, specialist, synthesizer, sem,
          projects, gate, codingGit, coder, reviewer, codeBrain, fence, reporter, registry, paths,
        );
      },
      inject: [
        ReaderAgent, ConversationStore, PinoLogger, IngesterAgent, TaskStore,
        SpecialistAgent, Synthesizer,
        ProjectStore, VerificationGate, CodingGit, CodingSpecialist, ReviewerAgent,
        BRAIN, PermissionFence, InsightReporter, PersonaRegistry, PathResolver,
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
