import { Module } from '@nestjs/common';
import { KnowledgeCoreModule } from './knowledge-core/knowledge-core.module';
import { AgentLayerModule } from './agent-layer/agent-layer.module';
import { EdgeModule } from './edge/edge.module';

// Engram 루트 모듈.
@Module({
  imports: [KnowledgeCoreModule, AgentLayerModule, EdgeModule],
})
export class AppModule {}
