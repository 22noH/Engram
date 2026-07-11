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
import { WikiEngine } from './knowledge-core/wiki/wiki-engine';
import { ProposalApplier } from './edge/proposal-applier';
import * as path from 'path';
import { loadChatConfig } from './edge/messenger/chat.config';
import { ChatStore } from './edge/messenger/chat-store';
import { SelfMessenger } from './edge/messenger/self.adapter';
import { MessengerHub } from './edge/messenger/messenger-hub';
import { ChannelPoster } from './edge/messenger/messenger.port';
import { WikiGit } from './knowledge-core/wiki/wiki-git';
import { loadWikiRemote } from './knowledge-core/wiki/wiki-remote.config';
import { WikiSyncService } from './edge/wiki-sync.service';

// 상주 부트스트랩(설계 §9.2). 스케줄러(@Cron)는 모듈 그래프로 자동 가동.
// Phase 6a: messenger.json provider가 있으면 메신저 어댑터를 띄워 @Engram 멘션을 받는다.
async function bootstrap(): Promise<void> {
  process.env.ENGRAM_RESIDENT = '1'; // 상주 표식 — HeartbeatEmitter가 기동 즉시 1회 발화
  const app = await NestFactory.createApplicationContext(AppModule);
  await app.init();

  const paths = app.get(PathResolver);
  const logger = app.get(PinoLogger);
  const orchestrator = app.get(Orchestrator);
  const policy = loadChannelPolicy(paths.getConfigDir());

  // 위키 git 원격 동기화(Phase 15b): 원격이 설정됐을 때만 가동. 실패해도 상주 불사.
  const wikiRemote = loadWikiRemote(paths.getConfigDir());
  if (wikiRemote) {
    const wikiSync = new WikiSyncService(app.get(WikiGit), wikiRemote, logger);
    void wikiSync.start().catch((e) => logger.warn(`위키 동기화 시작 실패: ${String(e)}`, 'WikiSync'));
  }

  // 자체 채팅(Phase 9): 기본 가동(chat.json enabled:false만 끔). 실패해도 상주 불사.
  let self: SelfMessenger | null = null;
  let chatStore: ChatStore | null = null;
  const chatCfg = loadChatConfig(paths.getConfigDir());
  if (chatCfg.enabled) {
    chatStore = new ChatStore(path.join(paths.getStateDir(), 'chat'));
    self = new SelfMessenger(chatCfg, chatStore, { logger }, {
      wiki: app.get(WikiEngine),
      proposals: app.get(ProposalStore),
      applier: app.get(ProposalApplier),
    });
  }

  // Discord(Phase 6a): messenger.json에 있으면 병행.
  const cfg = loadMessengerConfig(paths.getConfigDir());
  let discord: MessengerPort | null = null;
  try {
    discord = createMessenger(cfg);
  } catch (e) {
    logger.warn(`메신저 설정 오류(비활성): ${String(e)}`, 'Messenger');
  }

  const ports: MessengerPort[] = [self, discord].filter((p): p is MessengerPort => p !== null);
  if (ports.length === 0) return; // 채팅 끔 + Discord 없음 = 상주만 가동(기존 동작)

  for (const p of ports) bindMessenger(p, orchestrator, logger, policy);

  // 예약·ambient의 게시 통로: self가 있으면 Hub 라우팅, 없으면 Discord 직결.
  const poster: ChannelPoster =
    self && chatStore ? new MessengerHub(chatStore, self, discord ?? undefined) : discord!;

  // 재시작 생존(Phase 10b): 중단된 코딩 작업을 부팅 시 이어서. 게시는 poster(재시작 후엔 라이브 reply 핸들 없음).
  // 실패는 상주를 죽이지 않는다.
  try {
    const resumed = await orchestrator.resumeInterrupted((channelId, text) => poster.postToChannel(channelId, text));
    if (resumed > 0) logger.log(`중단된 코딩 ${resumed}건 재개`, 'Restart');
  } catch (e) {
    logger.warn(`재시작 재개 실패: ${String(e)}`, 'Restart');
  }

  const store = new ScheduleStore(paths.getConfigDir());
  const scheduler = new ScheduleService(orchestrator, poster, app.get(SchedulerRegistry), store, logger);
  orchestrator.setScheduler(scheduler);
  scheduler.start();
  const ambient = new AmbientService(
    orchestrator, poster, app.get(SchedulerRegistry), app.get(ProposalStore), policy,
    path.join(paths.getDataDir(), 'state', 'conversations'), logger,
  );
  ambient.start();

  // 포트 기동: self 리슨 실패(포트 점유 등)는 채팅만 비활성(경고)하고 상주는 계속.
  for (const p of ports) {
    try {
      await p.start();
    } catch (e) {
      logger.warn(`메신저 기동 실패(해당 채널 비활성): ${String(e)}`, 'Messenger');
    }
  }
  const active = [self ? `self(:${chatCfg.port})` : null, discord ? cfg.provider : null].filter(Boolean);
  logger.log(`메신저 가동: ${active.join(', ')}`, 'Messenger');
}

void bootstrap();
