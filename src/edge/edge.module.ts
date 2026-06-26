import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AgentLayerModule } from '../agent-layer/agent-layer.module';
import { KnowledgeCoreModule } from '../knowledge-core/knowledge-core.module';
import { CliGateway } from './cli.gateway';
import { ProposalApplier } from './proposal-applier';
import { DigestScheduler } from './digest.scheduler';

// Edge(설계 §9). Gateway 어댑터를 AgentLayer(Orchestrator) 앞단에 둔다.
// KnowledgeCoreModule에서 WikiEngine·ProposalStore를 받아 ProposalApplier에 주입.
// DigestScheduler: 상주 프로세스에서 @Cron으로 자율 다이제스트 실행(설계 §9.2).
@Module({
  imports: [AgentLayerModule, KnowledgeCoreModule, ScheduleModule.forRoot()],
  providers: [CliGateway, ProposalApplier, DigestScheduler],
  exports: [CliGateway],
})
export class EdgeModule {}
