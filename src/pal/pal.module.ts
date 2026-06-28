import { Module } from '@nestjs/common';
import { KnowledgeCoreModule } from '../knowledge-core/knowledge-core.module';
import { HeartbeatEmitter } from './heartbeat';
import { MemoryMonitor } from './memory-monitor';
import { PathResolver } from './path-resolver';
import { PinoLogger } from './logger';

// PAL 상주 위생(설계 §10). HeartbeatEmitter·MemoryMonitor @Interval 등록.
// ScheduleModule.forRoot()는 EdgeModule이 이미 호출(앱 전역 explorer가 이 모듈 @Interval도 발견) → 여기선 재호출 금지.
// PathResolver·PinoLogger는 KnowledgeCoreModule이 export.
@Module({
  imports: [KnowledgeCoreModule],
  providers: [
    HeartbeatEmitter,
    { provide: MemoryMonitor, useFactory: (p: PathResolver, l: PinoLogger) => new MemoryMonitor(p, l), inject: [PathResolver, PinoLogger] },
  ],
})
export class PalModule {}
