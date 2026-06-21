import { Module } from '@nestjs/common';
import { KnowledgeCoreModule } from './knowledge-core/knowledge-core.module';

// Engram 루트 모듈.
@Module({
  imports: [KnowledgeCoreModule],
})
export class AppModule {}
