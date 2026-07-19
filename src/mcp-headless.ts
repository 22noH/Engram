#!/usr/bin/env node
import 'reflect-metadata';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { NestFactory } from '@nestjs/core';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AppModule } from './app.module';
import { WikiEngine } from './knowledge-core/wiki/wiki-engine';
import { ProposalStore } from './knowledge-core/proposal-store';
import { ProposalApplier } from './edge/proposal-applier';
import { buildMcpServer, McpDeps } from './edge/mcp/engram-mcp';
import { makeMcpProposals } from './edge/mcp/mcp-proposals';
import { makeWikiMcpDeps, makeWikiWrite } from './edge/mcp/mcp-wiring';
import { makeBridgeServer } from './mcp-bridge';
import { DEFAULT_CHAT_PORT } from './edge/messenger/chat.config';

// 헤드리스 엔트리(설계 §3.1-3.2) — `node dist/src/mcp-headless.js [--data-dir D] [--write-mode] [--port N]`.
// 앱(Electron) 없이 엔그램 지식 코어(위키+의미검색+제안 대기열)를 stdio MCP 서버로 노출한다.
// 상주 앱이 이미 떠 있으면(§3.2 공존) 직접 코어를 열지 않고 기존 mcp-bridge로 자동 전환한다
// (LanceDB 동시 접근 위험 회피 — 데이터는 항상 앱과 같은 한 곳).
//
// ★2026-07-19 실사고: 플러그인 세션이 6개+ 동시에 헤드리스 MCP를 스폰하는데, 예전엔 앱을 2초
// 1회만 프로브하고 실패하면 바로 core 모드로 같은 rag 폴더를 열었다 — 앱이 막 부팅 중이면
// 뒤이어 뜨는 KnowledgeCoreModule.onModuleInit이 "Panic in async function"(크로스 프로세스 경합)
// 으로 죽어 크래시루프를 탔다. 그래서 chooseMode는 이제 2초 간격으로 최대 6회(총 ~12초) 앱을
// 기다린 뒤에야 core로 폴백한다 — 몇 회차든 응답이 오면(1회차 포함) 그 즉시 bridge로 반환한다
// (빠른 경로 보존, 앱이 정말 없을 때만 12초를 다 쓴다).
//
// stdout은 MCP 와이어 전용 — 이 파일·이 파일이 부팅하는 AppModule 경로에서 절대 console.log/
// process.stdout.write를 쓰지 않는다(모든 로그는 stderr 또는 PinoLogger 파일). Nest는
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

async function runBridge(port: number): Promise<void> {
  process.stderr.write(
    "[mcp-headless] Engram app is running — bridging to its /mcp (approval tools follow the app; write mode follows the app's setting)\n",
  );
  const server = makeBridgeServer(`http://127.0.0.1:${port}/mcp`);
  server.onerror = (e) => console.error('[mcp-headless] bridge server error:', e);
  const transport = new StdioServerTransport();
  // 브리지 모드도 동일한 종료 보장 — 정리할 Nest 앱이 없으므로 cleanup은 no-op.
  exitOnStdinClosed(async () => { /* no resources to release */ });
  server.onclose = () => process.exit(0);
  await server.connect(transport);
}

async function runCore(dataDir: string, writeMode: boolean): Promise<void> {
  // Nest 부팅 이전에 데이터 경로를 스스로 설정(§3.1) — PathResolver가 DI 해소 시점에 1회 읽는다.
  // ★ENGRAM_RESIDENT는 세팅하지 않는다 — 헤드리스는 상주가 아니다(하트비트·watchdog 오판 방지,
  // src/pal/heartbeat.ts 참조). 이미 설정돼 있으면(사용자 env) 존중 — 강제 덮어쓰기 안 함.
  process.env.ENGRAM_DATA_DIR ??= dataDir;

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  await app.init();

  const wiki = app.get(WikiEngine);
  const proposals = app.get(ProposalStore);
  const applier = app.get(ProposalApplier);

  const deps: McpDeps = {
    ...makeWikiMcpDeps(wiki, proposals),
    askBrain: null, // 헤드리스에 두뇌(위임) 없음(설계 §3.1 — 비범위)
    brainNames: () => [],
    proposals: makeMcpProposals(proposals, applier), // 헤드리스 자체 in-flight Set(앱 ws와 별개 프로세스)
    write: writeMode ? makeWikiWrite(wiki) : null,
  };

  const server = buildMcpServer(deps);
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
    await runBridge(port);
    return;
  }
  await runCore(dataDir, writeMode);
}

// 엔트리(직접 실행될 때만) — require.main===module로 테스트 임포트 시 자동실행 방지(mcp-bridge.ts와 동형).
if (require.main === module) {
  main().catch((e) => {
    console.error('[mcp-headless] fatal:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
