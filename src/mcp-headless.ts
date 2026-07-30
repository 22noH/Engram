#!/usr/bin/env node
import 'reflect-metadata';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { NestFactory } from '@nestjs/core';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HeadlessCoreModule } from './knowledge-core/headless-core.module';
import { WikiEngine } from './knowledge-core/wiki/wiki-engine';
import { splitStoreWarning, probeRedirect, importSplitStorePages } from './knowledge-core/wiki/split-store';
import { parsePage } from './knowledge-core/wiki/page-serializer';
import { ProposalStore } from './knowledge-core/proposal-store';
import { ProposalApplier } from './edge/proposal-applier';
import { buildMcpServer, McpDeps } from './edge/mcp/engram-mcp';
import { makeMcpProposals } from './edge/mcp/mcp-proposals';
import { makeMcpSettings } from './edge/mcp/mcp-settings';
import { makeWikiMcpDepsCore, makeWikiWrite } from './edge/mcp/mcp-wiring';
import { makeHeadlessWikiSync } from './edge/mcp/headless-wiki-sync';
import { WikiGit } from './knowledge-core/wiki/wiki-git';
import { loadWikiRemote } from './knowledge-core/wiki/wiki-remote.config';
import { PathResolver } from './pal/path-resolver';
import { makeBridgeServer } from './mcp-bridge';
import { DEFAULT_CHAT_PORT } from './edge/messenger/chat.config';

// 헤드리스 엔트리(설계 §3.1-3.2) — `node dist/src/mcp-headless.js [--data-dir D] [--write-mode] [--port N]`.
// 앱(Electron) 없이 엔그램 지식 코어(위키+제안 대기열)를 stdio MCP 서버로 노출한다.
// 상주 앱이 이미 떠 있으면(§3.2 공존) 직접 코어를 열지 않고 기존 mcp-bridge로 자동 전환한다
// (LanceDB 동시 접근 위험 회피 — 데이터는 항상 앱과 같은 한 곳).
//
// ★2026-07-19 실사고: 플러그인 세션이 6개+ 동시에 헤드리스 MCP를 스폰하는데, 예전엔 앱을 2초
// 1회만 프로브하고 실패하면 바로 core 모드로 같은 rag 폴더를 열었다 — 앱이 막 부팅 중이면
// 뒤이어 뜨는 KnowledgeCoreModule.onModuleInit이 "Panic in async function"(크로스 프로세스 경합)
// 으로 죽어 크래시루프를 탔다.
// ★★근본픽스(2026-07-20): 위 재시도만으로는 "앱이 정말 안 뜬 상태에서 core로 폴백" 케이스의
// 경합을 없애지 못했다(그런 폴백이 실제로 3건 사고를 냈다) — core 모드는 이제 AppModule이 아니라
// RagStore가 아예 없는 HeadlessCoreModule을 부팅한다(그 모듈 파일 주석 참조). 헤드리스는 이제
// LanceDB를 물리적으로 절대 열지 않는다 — Lance는 앱 전용. chooseMode의 재시도(2초 간격 최대
// 6회≈12초, 앱 우선권)는 여전히 유효하지만, core로 폴백해도 더 이상 크로스 프로세스 위험이 없다.
//
// stdout은 MCP 와이어 전용 — 이 파일·이 파일이 부팅하는 HeadlessCoreModule 경로에서 절대
// console.log/process.stdout.write를 쓰지 않는다(모든 로그는 stderr 또는 PinoLogger 파일). Nest는
// { logger: false }로 부팅해 자체 콘솔 로그를 끈다.

// Electron app.getPath('userData')와 동일 규칙(설치형 앱과 데이터 경로 일치 — 헤드리스로 먼저
// 써도 나중에 앱을 깔면 위키·제안이 그대로 이어진다). win=%APPDATA%\Engram·mac=~/Library/
// Application Support/Engram·기타(linux)=$XDG_CONFIG_HOME||~/.config/Engram.
export function defaultDataDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Engram');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Engram');
  }
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'Engram');
}

function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= 65535;
}

export interface HeadlessArgs {
  dataDir: string;
  writeMode: boolean;
  port: number;
}

// 인자 파싱 — 우선순위: --data-dir/--port > ENGRAM_DATA_DIR/ENGRAM_PORT > 기본값.
export function parseHeadlessArgs(argv: string[], env: NodeJS.ProcessEnv): HeadlessArgs {
  const dataDirIdx = argv.indexOf('--data-dir');
  const argDataDir = dataDirIdx !== -1 ? argv[dataDirIdx + 1] : undefined;
  const dataDir = argDataDir || env.ENGRAM_DATA_DIR || defaultDataDir(process.platform, env);

  const writeMode = argv.includes('--write-mode');

  const portIdx = argv.indexOf('--port');
  const argPort = portIdx !== -1 ? Number(argv[portIdx + 1]) : NaN;
  const envPort = env.ENGRAM_PORT !== undefined ? Number(env.ENGRAM_PORT) : NaN;
  const port = isValidPort(argPort) ? argPort : isValidPort(envPort) ? envPort : DEFAULT_CHAT_PORT;

  return { dataDir, writeMode, port };
}

// 단발 프로브 — 상주 앱의 채팅 서버가 그 포트에서 응답하면(GET / → 200 + {ok:true}) 'bridge',
// 아니면(연결거부·타임아웃·형식 불일치 등 전부) 'core'. never-throw — 실패는 전부 'core' 폴백이 아니라
// "이번 시도엔 상주 없음"으로 해석한다(chooseMode가 재시도할지 최종 core로 결정할지 판단).
function probeOnce(port: number, timeoutMs: number): Promise<'bridge' | 'core'> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as unknown;
          const ok = res.statusCode === 200 && !!parsed && typeof parsed === 'object' && (parsed as { ok?: unknown }).ok === true;
          resolve(ok ? 'bridge' : 'core');
        } catch {
          resolve('core');
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve('core'); });
    req.on('error', () => resolve('core'));
  });
}

export interface ChooseModeRetryOptions {
  attempts?: number;
  intervalMs?: number;
}

// 공존 감지(§3.2) — probeOnce를 intervalMs 간격으로 최대 attempts회 재시도한다. 어느 시도든
// 'bridge'가 나오면(1회차 포함) 그 즉시 반환(빠른 경로 보존) — 전부 실패해야 최종 'core'.
// 기본값(6회·2초 간격≈총 12초)은 앱이 막 부팅 중일 때 core 폴백으로 같은 LanceDB 폴더를
// 여는 크로스 프로세스 경합을 피하기 위함(★2026-07-19 실사고, 파일 상단 주석 참조).
export async function chooseMode(
  port: number,
  timeoutMs = 2000,
  retryOpts: ChooseModeRetryOptions = {},
): Promise<'bridge' | 'core'> {
  const { attempts = 6, intervalMs = 2000 } = retryOpts;
  for (let i = 1; i <= attempts; i++) {
    const mode = await probeOnce(port, timeoutMs);
    if (mode === 'bridge') return mode;
    if (i < attempts) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return 'core';
}

// ★종료 보장(리뷰 Important 반영): 이 Node/Windows 조합에선 호스트(MCP 클라이언트)가 stdio 파이프를
// 닫아도 SDK의 server.onclose가 발화하지 않는 경우가 실측됨(파일 stdin EOF·MSYS 파이프 닫힘·
// PowerShell 리다이렉트·initialize 후 disconnect 전부) — 프로세스가 LanceDB/git 핸들을 쥔 채
// 고아로 남는다. 그래서 SDK에 의존하지 않고 process.stdin의 'end'/'close'를 직접 구독해 같은
// 종료 루틴으로 라우팅하고, 종료 루틴 끝에 반드시 process.exit(0)를 호출한다(Nest teardown이
// 라이브 핸들을 남겨도 종료가 보장되도록 — belt+braces). once-플래그로 다중 트리거(둘 다 발화·
// SIGINT 병행)에 안전.
function exitOnStdinClosed(cleanup: () => Promise<void>): void {
  let triggered = false;
  const finish = (): void => {
    if (triggered) return;
    triggered = true;
    void cleanup().finally(() => process.exit(0)); // cleanup이 reject해도 종료는 무조건
  };
  process.stdin.on('end', finish);
  process.stdin.on('close', finish);
  process.on('SIGINT', finish);
}

async function runBridge(port: number, dataDir: string): Promise<void> {
  process.stderr.write(
    "[mcp-headless] Engram app is running — bridging to its /mcp (approval tools follow the app; write mode follows the app's setting)\n",
  );
  // 브리지도 wiki.autosave를 읽어야 한다 — 상류에만 검사가 있으면 브리지 선택창이 먼저 떠서
  // 설정이 무시된다. Nest 없이 경로만 필요하므로 PathResolver를 직접 만든다(앱과 같은 파일).
  const server = makeBridgeServer(`http://127.0.0.1:${port}/mcp`, new PathResolver(dataDir).getConfigDir());
  server.onerror = (e) => console.error('[mcp-headless] bridge server error:', e);
  const transport = new StdioServerTransport();
  // 브리지 모드도 동일한 종료 보장 — 정리할 Nest 앱이 없으므로 cleanup은 no-op.
  exitOnStdinClosed(async () => { /* no resources to release */ });
  server.onclose = () => process.exit(0);
  await server.connect(transport);
}

async function runCore(dataDir: string, writeMode: boolean, mode: 'core' | 'bridge'): Promise<void> {
  // Nest 부팅 이전에 데이터 경로를 스스로 설정(§3.1) — PathResolver가 DI 해소 시점에 1회 읽는다.
  // ★ENGRAM_RESIDENT는 세팅하지 않는다 — 헤드리스는 상주가 아니다(하트비트·watchdog 오판 방지,
  // src/pal/heartbeat.ts 참조). 이미 설정돼 있으면(사용자 env) 존중 — 강제 덮어쓰기 안 함.
  process.env.ENGRAM_DATA_DIR ??= dataDir;

  // ★근본픽스(2026-07-20): AppModule이 아니라 HeadlessCoreModule — RagStore/EMBEDDER/WikiWatcher가
  // 아예 이 모듈 그래프에 없어 LanceDB가 물리적으로 열리지 않는다(headless-core.module.ts 참조).
  const app = await NestFactory.createApplicationContext(HeadlessCoreModule, { logger: false });
  await app.init();

  const wiki = app.get(WikiEngine);
  const proposals = app.get(ProposalStore);
  const paths = app.get(PathResolver);
  // ★코어 모드는 자기가 직접 위키에 쓴다 — 이 프로세스가 샌드박스된 호스트(패키지 데스크톱 앱) 안에서
  // 돌면 그 쓰기가 컨테이너로 리디렉션돼 앱이 영영 못 보는 두 번째 위키가 생긴다(2026-07-27 실사고:
  // 13장 중 11장이 그렇게 갈렸고 아무도 몰랐다). 갈라진 걸 발견하면 조용히 넘어가지 않는다.
  const split = splitStoreWarning(paths.getDataDir());
  if (split) process.stderr.write(`[mcp-headless] ${split}\n`);
  // ★근본 방지: 내 쓰기가 컨테이너로 리디렉션되면 여기서 저장을 막는다. 그대로 두면 "저장했다"는
  // 답을 돌려주면서 앱이 영영 못 보는 두 번째 위키를 만든다 — 그건 성공이 아니라 조용한 실패다.
  // 읽기·검색은 그대로 둔다(합쳐진 뷰라 사용자에겐 정상으로 보이고, 막아서 얻을 게 없다).
  const redirected = probeRedirect(paths.getDataDir());
  let redirectNotice: string | null = null;
  // ProposalApplier는 DI 없이도 되는 순수 클래스(WikiEngine+ProposalStore만 소비) — HeadlessCoreModule에
  // 등록해 EdgeModule 전체를 끌어올 필요 없이 직접 생성.
  const applier = new ProposalApplier(wiki, proposals);

  const deps: McpDeps = {
    // ★근본픽스: makeWikiMcpDeps(wiki.search→RagStore 위임) 대신 makeWikiMcpDepsCore — search는
    // 텍스트 폴백(makeFileSearch)이고 searchFallback:true로 wiki_search 도구 설명에 그 사실을 알린다.
    ...makeWikiMcpDepsCore(wiki, proposals),
    askBrain: null, // 헤드리스에 두뇌(위임) 없음(설계 §3.1 — 비범위)
    brainNames: () => [],
    proposals: makeMcpProposals(proposals, applier), // 헤드리스 자체 in-flight Set(앱 ws와 별개 프로세스)
    write: writeMode ? makeWikiWrite(wiki) : null,
    // 설정 조회·변경(2026-07-25) — MCP만 쓰는 사용자(앱 설정 화면이 없는 사람)가 감시 폴더·위키
    // 원격을 말로 바꿀 수 있게. 위험한 값은 elicitation 승인이 없으면 거부된다(engram-mcp.ts).
    settings: makeMcpSettings(paths.getConfigDir()),
  };

  // 리디렉션이 확인되면 쓰기 도구를 아예 빼고, propose는 이유를 들고 실패한다(도구층이 isError로
  // 감싼다). 조용히 성공한 척하지 않는 것이 요점이다 — 사용자는 저장이 안 됐다는 걸 즉시 알아야 한다.
  // ★회귀 정정(2026-07-30): 여기서 저장을 **거부**했다 — 틀렸다. 앱이 없는 사용자에게 그 리디렉션된
  // 저장소는 **유일한 위키**다. 갈라질 상대가 없는데 갈라짐을 막겠다고 저장을 막고, 없는 앱을 켜라고
  // 안내했다(실측 재현: "Start the Engram app and try again"). 조용한 실패가 나쁜 것과 별개로,
  // **아예 못 쓰게 만드는 건 더 나쁘다.** 이제 막지 않고 사실만 알린다 — 모델이 보는 곳에 실어야
  // 사용자에게 닿는다(stderr는 아무도 안 본다).
  // ★문구 정정 2탄(2026-07-30): "앱은 이 페이지들을 영원히 못 본다"고 적었는데, 이제 틀렸다.
  // 앱이 부팅할 때 갇힌 페이지를 자기 위키로 가져온다(knowledge-core.module의 importSandboxedPages).
  // 사용자에게 "손으로 옮겨라"라고 말하게 만드는 문구는 이제 잘못된 지시다.
  if (redirected) {
    redirectNotice =
      `NOTE: this MCP server runs inside a sandboxed app, so its writes to ${paths.getDataDir()} actually land in ` +
      `${redirected}. Saving works. If the user also has the Engram desktop app, a page saved here shows up in it ` +
      `the next time the app starts — the app imports pages from this store on boot. Nothing to move by hand. ` +
      `Say this once if the user wonders why a new page is not in the app yet, then drop it.`;
    process.stderr.write(`[mcp-headless] ${redirectNotice}\n`);
  } else if (split) {
    // ★앱이 없는 사용자도 합쳐진다(2026-07-30 적대적 검토 지적). 갈라진 저장소를 발견했는데
    // **내 쓰기는 리디렉션되지 않는다** = 이 프로세스가 가상화 밖에 있다 = 앱이 하는 일을 내가
    // 할 수 있다. 실제 조합: 사용자가 클로드 데스크톱(샌드박스)과 클로드 코드 CLI(샌드박스 아님)를
    // 같이 쓰면, 갇힌 페이지를 CLI 쪽이 데려온다 — 엔그램 앱이 아예 없어도 위키가 한 벌이 된다.
    // redirected가 null일 때만 돈다 — 내가 가상화된 쪽이면 데려와도 또 오버레이에 쓸 뿐이다.
    void importSplitStorePages(paths.getDataDir(), {
      commit: (rel) => app.get(WikiGit).commitAll(`import ${rel} (sandboxed store)`, rel),
      validate: (text) => { parsePage('validate', text); },
    }).then((r) => {
      if (r.imported.length > 0) {
        process.stderr.write(`[mcp-headless] 갇혀 있던 위키 페이지 ${r.imported.length}장을 가져왔습니다: ${r.imported.join(', ')}\n`);
      }
      if (r.failed.length > 0) {
        process.stderr.write(`[mcp-headless] 가져오지 못한 페이지 ${r.failed.length}장 — 다음 실행에 다시 시도합니다\n`);
      }
    }).catch((e) => {
      // never-throw: 못 데려와도 MCP 서버는 정상 동작해야 한다.
      process.stderr.write(`[mcp-headless] 샌드박스 페이지 가져오기 실패(건너뜀): ${e instanceof Error ? e.message : String(e)}\n`);
    });
  }

  // 위키 git 원격 동기화(main.ts:124 배선의 헤드리스 짝) — config/wiki-remote.json에 원격이 있을
  // 때만 배선된다. 없으면 makeHeadlessWikiSync가 null을 돌려주고 deps는 손도 안 댄 원본 그대로다.
  // 두뇌 병합기(setBodyMerger)는 붙이지 않는다 — 헤드리스엔 두뇌가 없으므로 union 폴백(main.ts의
  // 배선 실패 시 폴백과 동일 결)이 맞다. 자세한 설계 근거는 headless-wiki-sync.ts 상단 주석.
  const sync = makeHeadlessWikiSync({
    mode,
    cfg: loadWikiRemote(paths.getConfigDir()),
    git: app.get(WikiGit),
    stateDir: paths.getStateDir(),
    log: (m) => process.stderr.write(`[mcp-headless] ${m}\n`),
  });
  if (sync) {
    // git이 자격증명 프롬프트로 행(hang)되면 stdio MCP 프로세스가 통째로 멈춘다 — 물어보지 말고
    // 즉시 실패하게 해서 사유가 로그/도구 응답에 뜨도록(사용자 env가 이미 정했으면 존중).
    process.env.GIT_TERMINAL_PROMPT ??= '0';
    void sync.start(); // 시작 pull/push는 백그라운드(MCP initialize를 네트워크에 물리지 않는다)
  }

  const server = buildMcpServer(sync ? sync.wrap(deps) : deps, redirectNotice);
  server.onerror = (e) => console.error('[mcp-headless] core server error:', e);
  const transport = new StdioServerTransport();

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await app.close();
    } catch (e) {
      console.error('[mcp-headless] app.close 실패(무해 — 프로세스는 종료):', e instanceof Error ? e.message : String(e));
    }
  };
  // ★stdin 'end'/'close' 직접 구독이 주 종료 경로(위 exitOnStdinClosed 주석 — SDK onclose는
  // 이 환경에서 발화 안 함이 실측됨). onclose도 발화한다면 같은 shutdown 후 명시적 exit(belt+braces
  // — shutdown의 closed 플래그가 이중 실행을 막고, exit는 Nest teardown의 잔여 핸들에 안 막힌다).
  server.onclose = () => { void shutdown().finally(() => process.exit(0)); };
  exitOnStdinClosed(shutdown);

  await server.connect(transport);
}

async function main(): Promise<void> {
  const { dataDir, writeMode, port } = parseHeadlessArgs(process.argv, process.env);
  const mode = await chooseMode(port);
  if (mode === 'bridge') {
    await runBridge(port, dataDir);
    return;
  }
  await runCore(dataDir, writeMode, mode);
}

// 엔트리(직접 실행될 때만) — require.main===module로 테스트 임포트 시 자동실행 방지(mcp-bridge.ts와 동형).
if (require.main === module) {
  main().catch((e) => {
    console.error('[mcp-headless] fatal:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
