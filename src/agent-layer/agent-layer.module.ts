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
import { Synthesizer } from './synthesizer';
import { MeetingEngine } from './meeting-engine';
import { TaskStore } from '../knowledge-core/task-store';
import { RagStore } from '../knowledge-core/rag/rag-store';
import { PinoLogger } from '../pal/logger';
import { PathResolver } from '../pal/path-resolver';
import { ConversationStore } from '../knowledge-core/conversation-store';
import { BRAIN, JUDGE_BRAIN, BrainProvider } from '../brain/brain.port';
import { Semaphore } from '../brain/semaphore';
import { createBrain } from '../brain/brain.factory';
import { loadBrainProfile } from '../brain/brain.config';
import { VerificationGate } from './verification-gate';

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
        // __dirname = dist/src/agent-layer or src/agent-layer → 두 단계 올라가면 프로젝트 루트.
        const personasDir = path.join(__dirname, '..', '..', 'personas');
        return new PersonaRegistry(personasDir, logger);
      },
      inject: [PinoLogger],
    },
    {
      provide: PermissionFence,
      useFactory: async (paths: PathResolver) => {
        const fence = new PermissionFence(path.join(paths.getConfigDir(), 'permissions.json'));
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
    // Synthesizer: JUDGE_BRAIN 사용(작성자≠종합자, seam #5).
    {
      provide: Synthesizer,
      useFactory: (judgeBrain: BrainProvider) => new Synthesizer(judgeBrain),
      inject: [JUDGE_BRAIN],
    },
    MeetingEngine,
    VerificationGate,
    // Orchestrator: 기존 deps + tasks·specialist·synthesizer·semaphore.
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
      ) => {
        const sem = new Semaphore(2);
        return new Orchestrator(reader, conversations, logger, ingester, tasks, specialist, synthesizer, sem);
      },
      inject: [ReaderAgent, ConversationStore, PinoLogger, IngesterAgent, TaskStore, SpecialistAgent, Synthesizer],
    },
  ],
  exports: [Orchestrator, MeetingEngine, PersonaRegistry, PermissionFence, VerificationGate],
})
export class AgentLayerModule implements OnModuleInit {
  constructor(private readonly registry: PersonaRegistry) {}

  async onModuleInit(): Promise<void> {
    await this.registry.load();
  }
}
