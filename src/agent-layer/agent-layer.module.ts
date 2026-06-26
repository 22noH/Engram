import { Module } from '@nestjs/common';
import { KnowledgeCoreModule } from '../knowledge-core/knowledge-core.module';
import { BrainModule } from '../brain/brain.module';
import { ReaderAgent } from './reader-agent';
import { Orchestrator } from './orchestrator';
import { IngesterAgent } from './ingester-agent';

// AgentLayer(설계 §7). 코어(RagStore·PinoLogger)와 두뇌(BRAIN)를 소비.
@Module({
  imports: [KnowledgeCoreModule, BrainModule],
  providers: [ReaderAgent, Orchestrator, IngesterAgent],
  exports: [Orchestrator],
})
export class AgentLayerModule {}
