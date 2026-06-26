import { Module } from '@nestjs/common';
import { AgentLayerModule } from '../agent-layer/agent-layer.module';
import { KnowledgeCoreModule } from '../knowledge-core/knowledge-core.module';
import { CliGateway } from './cli.gateway';
import { ProposalApplier } from './proposal-applier';

// Edge(설계 §9). Gateway 어댑터를 AgentLayer(Orchestrator) 앞단에 둔다.
// KnowledgeCoreModule에서 WikiEngine·ProposalStore를 받아 ProposalApplier에 주입.
@Module({
  imports: [AgentLayerModule, KnowledgeCoreModule],
  providers: [CliGateway, ProposalApplier],
  exports: [CliGateway],
})
export class EdgeModule {}
