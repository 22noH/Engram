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
import { BRAIN } from './brain/brain.port';
import type { BrainProvider } from './brain/brain.port';
import { makeBrainBodyMerger } from './knowledge-core/wiki/wiki-merge';
import { loadPrompt } from './agent-layer/prompt-store';
import { AccountStore } from './edge/auth/account-store';
import { SessionStore } from './edge/auth/session-store';
import { AuthHttp } from './edge/auth/auth-http';
import { loadAuthSettings, saveAuthSettings } from './edge/auth/auth.config';
import { ensureSetupCode } from './edge/auth/setup-code';
import type { AuthDeps, AdminDeps } from './edge/messenger/self.adapter';
import { AdminHttp } from './edge/admin/admin-http';
import type { McpDeps } from './edge/mcp/engram-mcp';
import { makeWikiMcpDeps, makeWikiWrite } from './edge/mcp/mcp-wiring';
import * as fs from 'fs';
import { listBrainNames, defaultBrainName } from './brain/brain.config';
import { BrainDelegator } from './agent-layer/brain-delegator';
import { readClaudeMcpServers } from './brain/claude-mcp-import';
import { mirrorClaudeMcp } from './desktop/mcp-file';

// 위키 본문 병합 프롬프트 내장 기본값(prompts/wiki-merge.md와 동일 — 파일 없을 때 폴백).
// prompts/*.md는 영어만 허용(prompt-md-english.spec.ts) — 두뇌에 보내는 지시문은 영어로 통일.
const WIKI_MERGE_FALLBACK = `Below are two versions of one wiki page body (they conflict due to concurrent edits). Merge them into a single, consistent markdown body without dropping any fact. Clean up duplication but preserve all content. Output only the markdown body — no explanation.

=== Version A ===
{{OURS}}

=== Version B ===
{{THEIRS}}
`;

// permissions.json의 allow.mcpWriteMode 읽기(§3.4) — desktop/permissions-file.ts와 같은 결이지만
// 서버 코드(main.ts)에서 desktop 모듈을 import하지 않기 위해 여기 자체 구현(fs만 의존, 결 동일).
// 없거나 깨짐/미지정값 → 'propose'(기본=제안만, 직접쓰기는 명시적 opt-in).
function readMcpWriteMode(configDir: string): 'propose' | 'write' {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'permissions.json'), 'utf8'));
    return raw?.allow?.mcpWriteMode === 'write' ? 'write' : 'propose';
  } catch {
    return 'propose';
  }
}

// 상주 부트스트랩(설계 §9.2). 스케줄러(@Cron)는 모듈 그래프로 자동 가동.
// Phase 6a: messenger.json provider가 있으면 메신저 어댑터를 띄워 @Engram 멘션을 받는다.
async function bootstrap(): Promise<void> {
  process.env.ENGRAM_RESIDENT = '1'; // 상주 표식 — HeartbeatEmitter가 기동 즉시 1회 발화
  const app = await NestFactory.createApplicationContext(AppModule);
  await app.init();

  const paths = app.get(PathResolver);
  const logger = app.get(PinoLogger);

  // 클로드 MCP 패리티(설계 §3.2): 부트 1회, 두뇌 생성 이전. 미러 실패는 부팅을 막지 않는다.
  try {
    mirrorClaudeMcp(paths.getConfigDir(), readClaudeMcpServers());
  } catch (e) {
    logger.warn(`클로드 MCP 미러 실패(무시하고 계속): ${String(e)}`, 'McpParity');
  }

  const orchestrator = app.get(Orchestrator);
  const policy = loadChannelPolicy(paths.getConfigDir());

  // 위키 git 원격 동기화(Phase 15b): 원격이 설정됐을 때만 가동. 실패해도 상주 불사.
  const wikiRemote = loadWikiRemote(paths.getConfigDir());
  if (wikiRemote) {
    const wikiGit = app.get(WikiGit);
    try {
      const brain = app.get<BrainProvider>(BRAIN);
      const mergePrompt = loadPrompt('wiki-merge', WIKI_MERGE_FALLBACK);
      wikiGit.setBodyMerger(makeBrainBodyMerger(brain, mergePrompt));
    } catch (e) {
      logger.warn(`위키 병합 두뇌 배선 실패(union 폴백): ${String(e)}`, 'WikiSync');
    }
    const wikiSync = new WikiSyncService(wikiGit, wikiRemote, logger);
    void wikiSync.start().catch((e) => logger.warn(`위키 동기화 시작 실패: ${String(e)}`, 'WikiSync'));
  }

  // 자체 채팅(Phase 9): 기본 가동(chat.json enabled:false만 끔). 실패해도 상주 불사.
  let self: SelfMessenger | null = null;
  let chatStore: ChatStore | null = null;
  const chatCfg = loadChatConfig(paths.getConfigDir());
  if (chatCfg.enabled) {
    const isServer = chatCfg.role !== 'brain'; // brain=계정·team·위키승인 미탑재, 127.0.0.1 고정(Phase 16a)
    chatStore = new ChatStore(path.join(paths.getStateDir(), 'chat'));
    let authDeps: AuthDeps | undefined;
    let mcpDeps: McpDeps | undefined;
    let adminDeps: AdminDeps | undefined;
    if (isServer) {
      const accounts = new AccountStore(paths.getStateDir());
      const sessions = new SessionStore(paths.getStateDir());
      const settings = {
        load: () => loadAuthSettings(paths.getConfigDir()),
        save: (s: ReturnType<typeof loadAuthSettings>) => saveAuthSettings(paths.getConfigDir(), s),
      };
      const authHttp = new AuthHttp({ accounts, sessions, stateDir: paths.getStateDir(), settings });
      authDeps = { accounts, sessions, http: authHttp, settings };
      if (accounts.count() === 0) {
        logger.log(`서버 미설정 — 초기 설정 코드: ${ensureSetupCode(paths.getStateDir())}`, 'Auth');
      }

      // Phase 8c-2: /mcp(외부 MCP 클라이언트)용 실 배선. 메인 서버에만(brain 모드는 미주입 → /mcp 404).
      const wiki = app.get(WikiEngine);
      const proposals = app.get(ProposalStore);
      // search/read/list/propose 조립은 mcp-headless.ts와 공유(src/edge/mcp/mcp-wiring.ts, 동작 무변경).
      mcpDeps = {
        ...makeWikiMcpDeps(wiki, proposals),
        askBrain: null, // 아래에서 BrainDelegator가 해소되면 채운다(8d 위임 계약 재사용).
        brainNames: () => listBrainNames(paths.getConfigDir()),
      };
      try {
        const delegator = app.get(BrainDelegator);
        mcpDeps.askBrain = (brain, task) => delegator.handle().run(brain, task);
      } catch (e) {
        logger.warn(`MCP ask_brain 배선 실패(도구 미노출): ${String(e)}`, 'Mcp');
      }

      // §3.4 직접쓰기 모드: permissions.json allow.mcpWriteMode: 'write'일 때만 wiki_write 노출.
      if (readMcpWriteMode(paths.getConfigDir()) === 'write') {
        mcpDeps.write = makeWikiWrite(wiki);
      }

      // Task 2(서버 콘솔 S1): /admin(console/dist 정적 서빙+owner 게이트 개요 api). 메인 서버에만
      // (brain 모드는 authDeps 자체가 없어 self.adapter가 /admin을 라우팅하지 않는다).
      const adminHttp = new AdminHttp({ accounts, sessions, chat: chatStore, wiki, proposals });
      adminDeps = { http: adminHttp };
    }
    self = new SelfMessenger(chatCfg, chatStore, {
      logger,
      brainNames: () => listBrainNames(paths.getConfigDir()),
      defaultBrain: () => defaultBrainName(paths.getConfigDir()),
    },
      isServer ? { wiki: app.get(WikiEngine), proposals: app.get(ProposalStore), applier: app.get(ProposalApplier) } : undefined,
      authDeps, mcpDeps, adminDeps);
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

  // 채널→브레인 조회 배선(Finding 1): chat 활성화됐을 때만(chatStore가 채널 목록의 유일한 소스).
  if (chatStore) orchestrator.setChannelBrainSource(chatStore);

  // 재시작 생존(Phase 10b): 중단된 코딩 작업을 부팅 시 이어서. 게시는 poster(재시작 후엔 라이브 reply 핸들 없음).
  // 실패는 상주를 죽이지 않는다.
  try {
    const resumed = await orchestrator.resumeInterrupted((channelId, text) => poster.postToChannel(channelId, text));
    if (resumed > 0) logger.log(`중단된 코딩 ${resumed}건 재개`, 'Restart');
  } catch (e) {
    logger.warn(`재시작 재개 실패: ${String(e)}`, 'Restart');
  }

  const store = new ScheduleStore(paths.getConfigDir());
  const scheduler = new ScheduleService(orchestrator, poster, app.get(SchedulerRegistry), store, logger, chatStore ?? undefined);
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
