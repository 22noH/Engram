import { Injectable, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { MeetingEngine } from '../agent-layer/meeting-engine';
import { PathResolver, DEFAULT_USER } from '../pal/path-resolver';
import { PinoLogger } from '../pal/logger';
import { loadMeetings } from './meeting-config';

// 등록된 회의를 동적 cron으로 — config N개를 onModuleInit에 등록(정적 @Cron 불가).
@Injectable()
export class MeetingScheduler implements OnModuleInit {
  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly engine: MeetingEngine,
    private readonly paths: PathResolver,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    if (process.env.ENGRAM_RESIDENT !== '1') return; // 상주 게이트 — 헤드리스·원샷은 회의 크론 미등록
    for (const def of loadMeetings(this.paths.getConfigDir())) {
      const job = new CronJob(def.schedule, () => {
        this.engine.run(def, DEFAULT_USER).catch((e) =>
          this.logger.error('회의 실행 실패', String(e), 'MeetingScheduler'),
        );
      });
      this.registry.addCronJob(`meeting-${def.name}`, job as any);
      job.start();
    }
  }
}
