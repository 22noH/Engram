import { Module } from '@nestjs/common';
import { KnowledgeCoreModule } from './knowledge-core/knowledge-core.module';
import { AgentLayerModule } from './agent-layer/agent-layer.module';
import { EdgeModule } from './edge/edge.module';
import { PalModule } from './pal/pal.module';

// Engram 루트 모듈.
@Module({
  imports: [KnowledgeCoreModule, AgentLayerModule, EdgeModule, PalModule],
})
export class AppModule {}
