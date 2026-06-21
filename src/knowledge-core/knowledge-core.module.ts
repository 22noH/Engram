import { Module } from '@nestjs/common';
import { PathResolver } from '../pal/path-resolver';
import { WikiEngine } from './wiki/wiki-engine';

// KnowledgeCore: 단일 진실원(설계 §5). Phase 0에선 WikiEngine부터.
// PathResolver는 string 인자를 DI로 주입할 수 없으므로 useFactory로 기본값 생성.
@Module({
  providers: [
    { provide: PathResolver, useFactory: () => new PathResolver() },
    WikiEngine,
  ],
  exports: [WikiEngine],
})
export class KnowledgeCoreModule {}
