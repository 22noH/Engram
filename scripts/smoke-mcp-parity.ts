import 'reflect-metadata';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as http from 'http';
import * as net from 'net';
import { spawn, execSync, ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';

import { readClaudeMcpServers } from '../src/brain/claude-mcp-import';
import { loadMcpServers } from '../src/brain/mcp-config';
import type { McpServerConfig } from '../src/brain/mcp-config';
import { McpSession } from '../src/brain/mcp-client';
import { ClaudeCliBrain } from '../src/brain/claude-cli.brain';
import type { BrainProfile } from '../src/brain/brain.config';

// 실 스모크: "클로드 MCP 패리티"(부트 시 클로드 MCP 서버를 mcp.json에 읽기전용 미러링 +
// CLI 하네스 --allowedTools 동적 구성 + McpSession의 stdio/http 실 왕복)를 4개 프로브로 검증한다.
// 우리 코드는 전혀 모킹하지 않는다 — 유일한 "이중"은 프로브 3의 CLI 대역(wrapper.cmd, argv 캡처용)뿐이며
// 이것도 ClaudeCliBrain.spawnOnce의 실제 cross-spawn 경로를 그대로 탄다(spawn 대상만 바뀜).
//
// 격리: ENGRAM_DATA_DIR는 항상 임시 디렉터리 — 절대 ~/.claude.json이나 플러그인 캐시를 쓰지 않는다
// (읽기만 한다). 모든 대기는 타임아웃 있음(하우스룰). 자식 프로세스는 전부 'error' 리스너 보유
// (main.js 직접 스폰분은 아래서 부여, ClaudeCliBrain/McpSession 내부 스폰은 해당 소스가 이미 부여).

const REPO_ROOT = path.resolve(__dirname, '..');

type ServerProc = ChildProcessByStdio<null, Readable, Readable>;

interface Result {
  id: string;
  desc: string;
  pass: boolean;
  detail?: string;
}
const results: Result[] = [];
function record(id: string, desc: string, pass: boolean, detail?: string): void {
  results.push({ id, desc, pass, detail });
  console.log(`   ${pass ? '✓' : '✗ FAIL'} (${id}) ${desc}${detail ? ' — ' + detail.slice(0, 300) : ''}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred: () => boolean, timeoutMs: number, label: string, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() >= deadline) throw new Error(`timeout(${timeoutMs}ms) waiting for ${label}`);
    await sleep(intervalMs);
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function killProc(proc: ServerProc | undefined): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  const pid = proc.pid;
  proc.kill();
  try {
    await waitFor(() => proc.exitCode !== null, 8000, 'server process exit');
  } catch {
    if (pid) {
      try {
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      } catch {
        /* 이미 죽었거나 taskkill 실패 — 무시 */
      }
    }
  }
}

// ── dist 신선도 확인: 이 기능이 만지는 소스 목록을 대응 dist .js와 mtime 비교 ──
function checkStaleAndBuild(): void {
  const files = [
    'main.ts',
    'desktop/mcp-file.ts',
    'desktop/main.ts',
    'brain/claude-mcp-import.ts',
    'brain/claude-cli.brain.ts',
    'brain/mcp-client.ts',
    'brain/mcp-config.ts',
    'edge/mcp/mcp-http.ts',
  ];
  let stale = false;
  for (const f of files) {
    const srcPath = path.join(REPO_ROOT, 'src', f);
    const distPath = path.join(REPO_ROOT, 'dist', 'src', f.replace(/\.ts$/, '.js'));
    if (!fs.existsSync(distPath)) {
      stale = true;
      break;
    }
    if (fs.statSync(srcPath).mtimeMs > fs.statSync(distPath).mtimeMs) {
      stale = true;
      break;
    }
  }
  if (stale) {
    console.log('[setup] dist가 stale — npm run build 실행 중 …');
    execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
  } else {
    console.log('[setup] dist 최신 — 빌드 스킵');
  }
}

// ── Probe 1: 실기기 미러 생성 (읽기는 실 클로드 설정, 쓰기는 격리된 temp 데이터 디렉터리) ──
async function probe1(tmpBase: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  console.log('\n[Probe 1] 실기기 미러 생성 — node dist/src/main.js 실 부트');
  const dataDir = path.join(tmpBase, 'p1');
  const configDir = path.join(dataDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  // 그라운드 트루스: 이 머신의 실 클로드 MCP 서버 판독(main.ts가 부팅 시 호출하는 것과 동일 함수,
  // 단 실행 경로는 다르다 — main.ts는 dist 컴파일본을 별도 프로세스로, 여기는 ts-node로 같은 프로세스에서).
  const realEntries = readClaudeMcpServers();
  record('1-pre', '이 머신에 실 클로드 MCP 서버가 1개 이상 존재(스모크 전제조건)', realEntries.length >= 1, `count=${realEntries.length} names=${realEntries.map((e) => e.name).join(',')}`);
  if (realEntries.length === 0) {
    console.log('   [skip] 이 머신에 클로드 MCP 서버가 하나도 없어 probe1 나머지 단언을 건너뜀(증거: readClaudeMcpServers()=[]) — 다른 머신에서 실행 시 통과 가능');
    return;
  }

  const collideName = realEntries[0].name;
  const nonCollide = realEntries.filter((e) => e.name !== collideName);
  console.log(`   [setup] 충돌 대상으로 '${collideName}' 선택(이 머신 실 동기화 이름) — 나머지 ${nonCollide.length}개는 source='claude'로 미러링 기대`);

  // 사전 시딩: mymanual(순수 수동) + collideName(실 동기화 이름과 충돌하는 수동 항목, source 없음).
  fs.writeFileSync(
    path.join(configDir, 'mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          mymanual: { command: 'echo', args: ['manual'] },
          [collideName]: { command: 'manual-override-cmd', args: ['keep-me'] },
        },
      },
      null,
      2,
    ),
  );

  // brains.json 사전 시딩(격리 — 존재하지 않는 CLI로, 실 채팅 호출은 이 프로브에서 안 하지만
  // 관례를 따라 부팅 중 어떤 경로도 실 CLI를 건드리지 않게 방어).
  fs.writeFileSync(
    path.join(configDir, 'brains.json'),
    JSON.stringify(
      { default: 'default', brains: { default: { provider: 'claude-cli', cli: 'engram-smoke-nonexistent-cli-xyz', model: '', concurrency: 1, timeoutMs: 5000 } } },
      null,
      2,
    ),
  );

  const chatPort = await getFreePort();
  const spawnEnv = {
    ...process.env,
    ENGRAM_DATA_DIR: dataDir,
    ENGRAM_CHAT_ROLE: 'brain',
    ENGRAM_CHAT_PORT: String(chatPort),
    ENGRAM_CHAT_BIND: '127.0.0.1',
  };

  let serverErr = '';
  const proc = spawn(process.execPath, [path.join(REPO_ROOT, 'dist', 'src', 'main.js')], {
    cwd: REPO_ROOT,
    env: spawnEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ServerProc;
  proc.on('error', (err) => console.error('[p1 server] spawn error', err));
  proc.stderr.on('data', (d) => (serverErr += d.toString()));
  cleanup.push(() => killProc(proc));

  try {
    const deadline = Date.now() + 60000;
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${chatPort}/`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          const j = (await r.json()) as { ok?: boolean };
          if (j.ok) break;
        }
      } catch {
        /* 아직 리슨 전 — 재시도 */
      }
      if (Date.now() >= deadline) throw new Error('timeout(60000ms) waiting for p1 server health');
      await sleep(300);
    }
    console.log(`   [setup] 서버 healthy on :${chatPort}, mcp.json 기록 대기 중 …`);
    // mirrorClaudeMcp는 app.init() 직후·부팅 흐름 초반에 동기 실행되므로 health 응답 시점엔 이미 끝나 있어야
    // 하지만 파일시스템 flush 여유를 위해 짧게 폴링.
    await sleep(500);

    await killProc(proc);

    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'mcp.json'), 'utf8'));
    const servers: Record<string, Record<string, unknown>> = raw.mcpServers ?? {};

    for (const e of nonCollide) {
      const written = servers[e.name];
      const ok =
        !!written &&
        written.source === 'claude' &&
        (e.command ? written.command === e.command : written.url === e.url);
      record('1a', `실 동기화 항목 '${e.name}'이 source='claude'로 미러링됨`, ok, JSON.stringify(written));
    }

    const claudeSourced = Object.keys(servers).filter((n) => servers[n]?.source === 'claude');
    const expectedNames = new Set(nonCollide.map((e) => e.name));
    const actualNames = new Set(claudeSourced);
    const sameSet = expectedNames.size === actualNames.size && [...expectedNames].every((n) => actualNames.has(n));
    record('1b', `source='claude' 항목 집합이 기대와 일치(충돌 이름 '${collideName}' 제외 ${nonCollide.length}개)`, sameSet, `expected=${[...expectedNames].join(',')} actual=${[...actualNames].join(',')}`);

    const mymanual = servers['mymanual'];
    record('1c', "'mymanual' 수동 항목이 그대로 보존됨(source 없음)", !!mymanual && mymanual.command === 'echo' && mymanual.source === undefined, JSON.stringify(mymanual));

    const collided = servers[collideName];
    record(
      '1d',
      `충돌 이름 '${collideName}'은 수동 버전 유지(source 없음, 덮어쓰기 안 됨)`,
      !!collided && collided.command === 'manual-override-cmd' && collided.source === undefined,
      JSON.stringify(collided),
    );
  } catch (e) {
    record('1', 'probe1 전체 흐름 예외 없이 완료', false, String(e));
    if (serverErr.trim()) console.log('\n[p1 server stderr(tail)]\n' + serverErr.slice(-3000));
  }
}

// ── Probe 2: stdio MCP 실왕복 — 로더(loadMcpServers)→McpSession, 실 자식 프로세스 ──
async function probe2(tmpBase: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  console.log('\n[Probe 2] stdio MCP 실왕복 — 엔그램 하네스(McpSession) 직결');
  const dir = path.join(tmpBase, 'p2');
  fs.mkdirSync(dir, { recursive: true });

  // SDK 모듈의 실제 해소 경로(exports map 때문에 dist/cjs로 리다이렉트됨) — 이 스크립트(REPO_ROOT
  // 아래) 컨텍스트에서 require.resolve해 절대경로를 얻은 뒤, temp 디렉터리의 독립 스크립트에
  // 절대경로 requires로 박아 넣는다(temp 디렉터리는 node_modules 조상 체인 밖이라 bare specifier 불가).
  const sdkServerIndex = require.resolve('@modelcontextprotocol/sdk/server/index.js');
  const sdkStdio = require.resolve('@modelcontextprotocol/sdk/server/stdio.js');
  const sdkTypes = require.resolve('@modelcontextprotocol/sdk/types.js');

  const echoServerPath = path.join(dir, 'echo-mcp-server.js');
  const echoServerSrc = `
const { Server } = require(${JSON.stringify(sdkServerIndex)});
const { StdioServerTransport } = require(${JSON.stringify(sdkStdio)});
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(sdkTypes)});

const server = new Server({ name: 'smoke-echo', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'echo', description: 'echo back input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const text = (req.params.arguments && req.params.arguments.text) || '';
  return { content: [{ type: 'text', text: 'echo:' + text }] };
});
const transport = new StdioServerTransport();
server.connect(transport);
`;
  fs.writeFileSync(echoServerPath, echoServerSrc);

  // "동기화된 것처럼" 임시 mcp.json에 stdio 항목 추가(source는 로더가 무시함을 증명하려 일부러 붙임).
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'mcp.json'),
    JSON.stringify(
      { mcpServers: { smokeecho: { command: process.execPath, args: [echoServerPath], source: 'claude' } } },
      null,
      2,
    ),
  );

  let session: McpSession | undefined;
  try {
    const servers = loadMcpServers(configDir);
    record('2a', "loadMcpServers가 'smokeecho' stdio 항목을 로드(source 필드는 무시)", !!servers.smokeecho, JSON.stringify(Object.keys(servers)));
    if (!servers.smokeecho) return;

    session = McpSession.create('smokeecho', servers.smokeecho);
    cleanup.push(async () => {
      try {
        await session?.close();
      } catch {
        /* 격리 */
      }
    });

    const connected = await session.connect(15000);
    record('2b', 'connect() 성공(실 자식 프로세스 스폰+initialize 왕복)', connected === true);
    if (!connected) return;

    const defs = await session.listToolDefs();
    record('2c', "listTools 왕복에 'mcp__smokeecho__echo' 존재", defs.some((d) => d.name === 'mcp__smokeecho__echo'), JSON.stringify(defs.map((d) => d.name)));

    const out = await session.callTool('mcp__smokeecho__echo', { text: 'hello-real-roundtrip' });
    record('2d', 'callTool 실왕복 결과에 echo:hello-real-roundtrip 포함', out.includes('echo:hello-real-roundtrip'), out);

    await session.close();
    record('2e', 'close() 예외 없이 완료', true);
  } catch (e) {
    record('2', 'probe2 전체 흐름 예외 없이 완료', false, String(e));
  }
}

// ── Probe 3: CLI 스폰 인자 — ClaudeCliBrain을 real profile로 만들고 wrapper.cmd가 argv를 캡처 ──
async function probe3(tmpBase: string): Promise<void> {
  console.log('\n[Probe 3] CLI 스폰 인자 — ClaudeCliBrain 실 spawn(cross-spawn), wrapper.cmd argv 캡처');
  const dir = path.join(tmpBase, 'p3');
  fs.mkdirSync(dir, { recursive: true });

  const captureJsPath = path.join(dir, 'capture.js');
  fs.writeFileSync(
    captureJsPath,
    `const fs = require('fs');\nfs.writeFileSync(process.env.CAPTURE_OUT, JSON.stringify(process.argv.slice(2)));\n`,
  );
  const wrapperPath = path.join(dir, 'wrapper.cmd');
  fs.writeFileSync(wrapperPath, `@echo off\r\n"${process.execPath}" "${captureJsPath}" %*\r\n`);

  const BASE_ALLOWED_TOOLS = ['WebSearch', 'WebFetch', 'mcp__engram', 'mcp__plugin_engram_engram'];
  const realEntries = readClaudeMcpServers();
  const dynamicTokens: string[] = [];
  for (const e of realEntries) {
    dynamicTokens.push(`mcp__${e.name}`);
    if (e.pluginName) dynamicTokens.push(`mcp__plugin_${e.pluginName}_${e.name}`);
  }
  const expectedSet = new Set([...BASE_ALLOWED_TOOLS, ...dynamicTokens]);

  // ── 3-1: 프로필이 --allowedTools 미지정 → 동적 구성(base4 ∪ 실 클로드 MCP 전체, 중복 제거) ──
  try {
    const outFile1 = path.join(dir, 'argv1.json');
    const profile1: BrainProfile = {
      provider: 'claude-cli',
      cli: wrapperPath,
      model: '',
      concurrency: 1,
      timeoutMs: 15000,
      extraArgs: [],
      env: { CAPTURE_OUT: outFile1 },
    };
    const brain1 = new ClaudeCliBrain(profile1);
    const prompt1 = '스모크 allowedTools 캡처용 프롬프트 with spaces';
    await brain1.complete(prompt1);
    await waitFor(() => fs.existsSync(outFile1), 8000, 'argv1.json 생성');
    const argv1: string[] = JSON.parse(fs.readFileSync(outFile1, 'utf8'));

    const idxList = argv1.reduce<number[]>((acc, a, i) => (a === '--allowedTools' ? [...acc, i] : acc), []);
    record('3a', "--allowedTools 플래그가 정확히 1회 등장", idxList.length === 1, JSON.stringify(idxList));

    const promptOk = argv1.includes('-p') && argv1[argv1.indexOf('-p') + 1] === prompt1;
    record('3b', "argv에 -p <프롬프트>가 그대로(공백 포함) 왕복됨", promptOk, JSON.stringify(argv1.slice(0, 3)));

    if (idxList.length === 1) {
      const value = argv1[idxList[0] + 1];
      const tokens = value.split(',');
      const tokenSet = new Set(tokens);
      record('3c', 'allowedTools 값에 중복 없음(split 길이 === Set 크기)', tokens.length === tokenSet.size, `tokens=${tokens.length} set=${tokenSet.size}`);

      const missingBase = BASE_ALLOWED_TOOLS.filter((t) => !tokenSet.has(t));
      record('3d', '고정 기본 4개(WebSearch/WebFetch/mcp__engram/mcp__plugin_engram_engram) 전부 포함', missingBase.length === 0, `missing=${missingBase.join(',')}`);

      const missingDynamic = dynamicTokens.filter((t) => !tokenSet.has(t));
      record('3e', `이 머신 실 클로드 MCP ${realEntries.length}개의 도구 토큰(mcp__<name>[+mcp__plugin_<plugin>_<name>]) 전부 포함`, missingDynamic.length === 0, `missing=${missingDynamic.join(',')} tokens=${[...tokenSet].join(',')}`);

      const setEqual = tokenSet.size === expectedSet.size && [...expectedSet].every((t) => tokenSet.has(t));
      record('3f', 'allowedTools 값 집합이 기대(base4 ∪ 동적) 전체와 정확히 일치', setEqual, `expected=${[...expectedSet].join(',')} actual=${[...tokenSet].join(',')}`);
    }
  } catch (e) {
    record('3-1', 'probe3 시나리오1(동적 allowedTools) 예외 없이 완료', false, String(e));
  }

  // ── 3-2: 프로필이 extraArgs=['--allowedTools','Bash'] → 사용자 지정 우선(동적 구성 미주입) ──
  try {
    const outFile2 = path.join(dir, 'argv2.json');
    const profile2: BrainProfile = {
      provider: 'claude-cli',
      cli: wrapperPath,
      model: '',
      concurrency: 1,
      timeoutMs: 15000,
      extraArgs: ['--allowedTools', 'Bash'],
      env: { CAPTURE_OUT: outFile2 },
    };
    const brain2 = new ClaudeCliBrain(profile2);
    await brain2.complete('스모크 프로필 지정 allowedTools 프롬프트');
    await waitFor(() => fs.existsSync(outFile2), 8000, 'argv2.json 생성');
    const argv2: string[] = JSON.parse(fs.readFileSync(outFile2, 'utf8'));

    const idxList2 = argv2.reduce<number[]>((acc, a, i) => (a === '--allowedTools' ? [...acc, i] : acc), []);
    record('3g', "프로필 지정 시에도 --allowedTools는 정확히 1회(중복 주입 없음)", idxList2.length === 1, JSON.stringify(idxList2));

    if (idxList2.length === 1) {
      const value2 = argv2[idxList2[0] + 1];
      record('3h', "프로필의 --allowedTools 값이 'Bash' 그대로(동적 구성 미주입, 사용자 의도 우선)", value2 === 'Bash', value2);
    }
    record('3i', "동적 구성 토큰(WebSearch 등)이 argv에 없음(프로필 지정이 완전히 대체)", !argv2.includes('WebSearch'), JSON.stringify(argv2));
  } catch (e) {
    record('3-2', 'probe3 시나리오2(프로필 지정 allowedTools) 예외 없이 완료', false, String(e));
  }
}

// ── Probe 4: http 401 / 연결거부 — McpSession.connect()가 크래시 없이 false ──
async function probe4(cleanup: Array<() => Promise<void>>): Promise<void> {
  console.log('\n[Probe 4] http MCP — 401 및 연결거부');

  try {
    const server401 = http.createServer((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    server401.on('error', (e) => console.error('[401-server] error', e));
    const port401 = await new Promise<number>((resolve) => {
      server401.listen(0, '127.0.0.1', () => {
        const addr = server401.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    cleanup.push(() => new Promise<void>((r) => server401.close(() => r())));

    const cfg401: McpServerConfig = { args: [], env: {}, url: `http://127.0.0.1:${port401}/mcp` };
    const session401 = McpSession.create('smoke401', cfg401);
    const connected401 = await session401.connect(8000);
    record('4a', '401을 상시 반환하는 http 서버 → connect()가 크래시 없이 false', connected401 === false, `connected=${connected401}`);
    await session401.close();
  } catch (e) {
    record('4a', '401 시나리오 예외 없이 완료', false, String(e));
  }

  try {
    // 아무도 리슨하지 않는(방금 닫은) 포트 — 연결거부(ECONNREFUSED) 유도.
    const probeSrv = net.createServer();
    const refusedPort = await new Promise<number>((resolve, reject) => {
      probeSrv.on('error', reject);
      probeSrv.listen(0, '127.0.0.1', () => {
        const addr = probeSrv.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    await new Promise<void>((r) => probeSrv.close(() => r()));

    const cfgRefused: McpServerConfig = { args: [], env: {}, url: `http://127.0.0.1:${refusedPort}/mcp` };
    const sessionRefused = McpSession.create('smokerefused', cfgRefused);
    const connectedRefused = await sessionRefused.connect(8000);
    record('4b', '연결거부 포트 → connect()가 크래시 없이 false', connectedRefused === false, `connected=${connectedRefused}`);
    await sessionRefused.close();
  } catch (e) {
    record('4b', '연결거부 시나리오 예외 없이 완료', false, String(e));
  }
}

async function main(): Promise<void> {
  checkStaleAndBuild();

  const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'engram-smoke-mcp-parity-'));
  console.log(`[setup] temp base: ${tmpBase}`);
  const cleanup: Array<() => Promise<void>> = [];

  try {
    await probe1(tmpBase, cleanup);
    await probe2(tmpBase, cleanup);
    await probe3(tmpBase);
    await probe4(cleanup);
  } finally {
    for (const task of cleanup.reverse()) {
      try {
        await task();
      } catch {
        /* 정리 실패는 무해 — 계속 진행 */
      }
    }
    await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }

  const failures = results.filter((r) => !r.pass).length;
  console.log('\n=== 결과 표 ===');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  (${r.id}) ${r.desc}`);
  console.log(`\n${failures === 0 ? '✅ 전부 통과' : `❌ ${failures}건 실패`} (총 ${results.length}건)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exitCode = 1;
});
