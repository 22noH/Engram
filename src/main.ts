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
import { GroupStore } from './edge/auth/group-store';
import { SessionStore } from './edge/auth/session-store';
import { AuthHttp } from './edge/auth/auth-http';
import { loadAuthSettings, saveAuthSettings } from './edge/auth/auth.config';
import { ensureSetupCode } from './edge/auth/setup-code';
import type { AuthDeps, AdminDeps, AttachmentsDeps } from './edge/messenger/self.adapter';
import { AdminHttp } from './edge/admin/admin-http';
import { AttachmentStore } from './edge/messenger/attachment-store';
import { AttachmentsHttp } from './edge/messenger/attachments-http';
import type { McpDeps } from './edge/mcp/engram-mcp';
import { makeWikiMcpDeps, makeWikiWrite } from './edge/mcp/mcp-wiring';
import * as fs from 'fs';
import { listBrainNames, defaultBrainName } from './brain/brain.config';
import { BrainDelegator } from './agent-layer/brain-delegator';
import { readClaudeMcpServers } from './brain/claude-mcp-import';
import { mirrorClaudeMcp } from './desktop/mcp-file';
import { CompactService } from './agent-layer/compact';

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
    // 서버 콘솔 S4 Task 1/2: 대화 자동 보존 정책은 chat.json에 저장(chat.config.ts)되고 부팅 시
    // 여기서 ChatStore에 주입된다 — 미설정이면 생성자가 손대지 않아 기본(unlimited)을 유지(회귀 0).
    // Task 2(chat-attachments): 첨부 실파일 저장소. dataDir=stateDir 최상위(채팅 jsonl과 형제 —
    // attachments/<channelId>/<id>). isServer 여부와 무관하게 항상 만든다 — ChatStore 삭제 훅
    // (프루닝·자동compact·clear 확정)은 브레인 모드에서도 동작해 운명 공유가 필요하기 때문(HTTP
    // 업로드/다운로드만 isServer 전용 — 아래 attachmentsDeps는 그 블록 안에서만 채워진다).
    const attachmentStore = new AttachmentStore(paths.getStateDir());
    chatStore = new ChatStore(path.join(paths.getStateDir(), 'chat'), chatCfg.retention, { attachmentStore });
    let authDeps: AuthDeps | undefined;
    let mcpDeps: McpDeps | undefined;
    let adminDeps: AdminDeps | undefined;
    let attachmentsDeps: AttachmentsDeps | undefined;
    // clear-compact Task 3b: /compact ws 훅. wiki 배선(메인 서버=isServer)이 있을 때만 채워진다 —
    // brain 모드/미배선이면 undefined인 채로 SelfMessenger에 넘어가 self.adapter의 compact 케이스가
    // 조용한 no-op으로 흡수한다(Task 3이 이미 만들어둔 안전망).
    let compactHandler: ((channelId: string, brainName?: string) => Promise<{ slug: string } | null>) | undefined;
    if (isServer) {
      const accounts = new AccountStore(paths.getStateDir());
      const sessions = new SessionStore(paths.getStateDir());
      // 서버 콘솔 S2(Task 1): 그룹(groups.json) — 유효 권한/채널 해소용. self.adapter가 개인∪그룹
      // 합집합으로 판정(effective-access.ts). Task 2에서 adminDeps에도 같은 인스턴스를 재사용한다.
      const groups = new GroupStore(paths.getStateDir());
      const settings = {
        load: () => loadAuthSettings(paths.getConfigDir()),
        save: (s: ReturnType<typeof loadAuthSettings>) => saveAuthSettings(paths.getConfigDir(), s),
      };
      const authHttp = new AuthHttp({ accounts, sessions, stateDir: paths.getStateDir(), settings });
      authDeps = { accounts, sessions, http: authHttp, settings, groups };

      // Task 2(chat-attachments): /attachments/* http. 같은 accounts/sessions/groups 인스턴스를
      // 재사용(authDeps·adminDeps와 동일 결 — 세션/그룹 판정이 갈라지지 않도록).
      const attachmentsHttp = new AttachmentsHttp({ accounts, sessions, groups, chat: chatStore, attachments: attachmentStore });
      attachmentsDeps = { http: attachmentsHttp };
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
      // 리뷰 지적: 콘솔은 서버 에디션 물건 — 데스크톱 상주 백엔드(src/desktop/main.ts startChild가
      // ENGRAM_DESKTOP='1'로 fork)는 isServer라도 /admin을 서빙하면 안 된다. 여기서 아예 adminDeps를
      // 안 만들어 self.adapter에 안 넘긴다(생성 자체를 스킵 — 데스크톱에서 불필요한 AdminHttp 인스턴스도
      // 안 만듦). 이 env 없는 헤드리스 서버 실행(미래 engram-server 엔트리 포함)은 기존대로 /admin 서빙.
      if (process.env.ENGRAM_DESKTOP !== '1') {
        const adminHttp = new AdminHttp({ accounts, sessions, chat: chatStore, groups, wiki, proposals, configDir: paths.getConfigDir(), paths });
        adminDeps = { http: adminHttp };
      }

      // clear-compact Task 3b: CompactService는 main.ts에서만 조립되는 chatStore가 필요해 DI 밖(setter)으로
      // 주입한다(setChannelBrainSource와 동일 결) — chatStore는 위 chatCfg.enabled 블록에서 이미 non-null.
      const applier = app.get(ProposalApplier);
      const compactService = new CompactService(chatStore, wiki, proposals, applier);
      orchestrator.setCompactService(compactService);
      compactHandler = (id, brainName) => orchestrator.compactChannel(id, brainName);

      // clear-compact Task 5: 보존 프루닝 직전 자동 compact 훅. wiki 배선(isServer)이 있을 때만 주입 —
      // 미주입이면 chat-store.pruneChannel이 기존 동기 프루닝(=raw 삭제, S4) 그대로 돈다(회귀 0). 브레인 해소는
      // orchestrator.autoCompact(채널의 "현재" 브레인을 channelBrainOf로 조회)에 위임 — compactChannel과
      // 동일한 DI-밖 setter 결(순환 회피)을 재사용한다. self는 이 if(isServer) 블록 아래에서 조립되므로
      // 클로저로 참조하되(let self — 재할당은 이 함수 스코프 안에서 곧 일어남), 훅은 실제 프루닝이 발생하는
      // "부팅 이후" 시점에만 호출되므로 그때는 이미 non-null이다(방어적으로 null 체크는 남겨둔다).
      // 훅은 항상 설치하고, "켜짐 여부"는 별도 런타임 플래그(setAutoCompactEnabled)로 둔다(최종 리뷰 지적).
      // 이렇게 하면 콘솔에서 autoCompact를 켬과 동시에 retention을 조여도 둘이 즉시 함께 적용돼(admin-http가
      // setRetention·setAutoCompactEnabled를 같이 호출) "요약 없이 raw 삭제"로 새는 비대칭이 없다. enabled=false면
      // pruneChannel이 훅을 호출조차 안 하고 동기 raw 삭제(S4)로 떨어진다. false 의미 이중화(요약실패 vs 꺼짐)도
      // pruneChannel이 enabled로 먼저 갈라지므로 사라진다.
      chatStore.setAutoCompactHook(async (channelId, dropped) => {
        const r = await orchestrator.autoCompact(channelId, dropped);
        if (!r) return false; // 요약/위키 저장 실패 — chat-store는 아무것도 지우지 않는다(안전 우선)
        // 안내 메시지는 best-effort(목업 ⑤): 실패해도 요약은 이미 성공했으므로 true를 반환해 정리는 진행.
        try {
          if (self) {
            await self.postToChannel(
              channelId,
              `💾 오래된 대화 ${dropped.length}개를 자동 요약해 위키에 저장했어요 · 📄 ${r.slug}`,
            );
          }
        } catch (e) {
          logger.warn(`자동 compact 안내 메시지 게시 실패(무시, 요약은 이미 성공): ${String(e)}`, 'AutoCompact');
        }
        return true;
      });
      chatStore.setAutoCompactEnabled(chatCfg.autoCompact !== false); // 부팅 초기 상태(기본 true)
    }
    self = new SelfMessenger(chatCfg, chatStore, {
      logger,
      brainNames: () => listBrainNames(paths.getConfigDir()),
      defaultBrain: () => defaultBrainName(paths.getConfigDir()),
      compactHandler,
    },
      isServer ? { wiki: app.get(WikiEngine), proposals: app.get(ProposalStore), applier: app.get(ProposalApplier) } : undefined,
      authDeps, mcpDeps, adminDeps, attachmentsDeps);
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
