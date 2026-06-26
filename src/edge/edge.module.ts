import { Module } from '@nestjs/common';
import { AgentLayerModule } from '../agent-layer/agent-layer.module';
import { CliGateway } from './cli.gateway';

// Edge(설계 §9). Gateway 어댑터를 AgentLayer(Orchestrator) 앞단에 둔다.
@Module({
  imports: [AgentLayerModule],
  providers: [CliGateway],
  exports: [CliGateway],
})
export class EdgeModule {}
