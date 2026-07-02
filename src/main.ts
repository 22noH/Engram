import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Orchestrator } from './agent-layer/orchestrator';
import { PathResolver } from './pal/path-resolver';
import { PinoLogger } from './pal/logger';
import { loadMessengerConfig } from './edge/messenger/messenger.config';
import { createMessenger } from './edge/messenger/messenger.factory';
import { bindMessenger } from './edge/messenger/messenger-bridge';
import { MessengerPort } from './edge/messenger/messenger.port';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ScheduleStore } from './agent-layer/schedule-store';
import { ScheduleService } from './edge/schedule-service';
import { loadChannelPolicy } from './agent-layer/channel-policy';
import { AmbientService } from './edge/ambient-service';
import { ProposalStore } from './knowledge-core/proposal-store';
import * as path from 'path';

// 상주 부트스트랩(설계 §9.2). 스케줄러(@Cron)는 모듈 그래프로 자동 가동.
// Phase 6a: messenger.json provider가 있으면 메신저 어댑터를 띄워 @Engram 멘션을 받는다.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  await app.init();

  const paths = app.get(PathResolver);
  const logger = app.get(PinoLogger);
  const cfg = loadMessengerConfig(paths.getConfigDir());
  let port: MessengerPort | null = null;
  try {
    port = createMessenger(cfg);
  } catch (e) {
    logger.warn(`메신저 설정 오류(비활성): ${String(e)}`, 'Messenger');
  }
  if (port) {
    const orchestrator = app.get(Orchestrator);
    const policy = loadChannelPolicy(paths.getConfigDir());
    bindMessenger(port, orchestrator, logger, policy);
    const store = new ScheduleStore(paths.getConfigDir());
    const scheduler = new ScheduleService(orchestrator, port, app.get(SchedulerRegistry), store, logger);
    orchestrator.setScheduler(scheduler);
    scheduler.start();
    const ambient = new AmbientService(
      orchestrator, port, app.get(SchedulerRegistry), app.get(ProposalStore), policy,
      path.join(paths.getDataDir(), 'state', 'conversations'), logger,
    );
    ambient.start();
    await port.start();
    logger.log(`메신저 가동: ${cfg.provider}`, 'Messenger');
  }
}

void bootstrap();
