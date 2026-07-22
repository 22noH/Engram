import 'reflect-metadata';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { execSync, spawn, spawnSync, ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';

// 실 스모크: engram-server CLI(플랜 .superpowers/sdd/task-5-brief.md, Task 5).
// server-cli.ts를 실제로 spawn(`node dist/src/server-cli.js <args>`)해서 검증한다 — 우리 코드는
// 전혀 모킹하지 않는다(scripts/smoke-console-s4.ts 관례 계승: 격리 임시 ENGRAM_DATA_DIR·타임아웃
// 있는 대기·'error' 리스너 보유 자식 프로세스·finally 정리).
//
// 시나리오(브리프 순서): setup(코드 생성) → config set port/retention → config get 왕복 →
// 실제 서버 부팅(node dist/src/main.js)해 그 셋업 코드로 owner 생성 → user list/approve →
// preset export(파일 생성 확인) → status. service install/uninstall은 윈도우에서만, 비관리자
// 환경이면 안내를 확인하고 실제 설치는 절대 시도하지 않는다(아래 "service" 절 참고 — 이유는
// node-windows의 실제 install/uninstall이 감시 안 되는 UAC 승격을 트리거하거나 windows-supervisor.ts의
// uninstall 이벤트 매핑 누락으로 무한 대기할 위험이 있어, 실기기를 건드리지 않고 status(순수
// fs.existsSync 체크, 부작용 없음)만으로 "not-installed"를 확인한다). 도커는 `docker --version`이
// 실패하면 skip 노트만 남긴다(이 머신은 도커 미설치 — 브리프가 허용하는 경로).
//
// 격리: ENGRAM_DATA_DIR는 항상 임시 디렉터리 — 절대 %APPDATA%\Engram나 실사용자 데이터를 건드리지
// 않는다. CLI 인자는 전부 argv로 넘긴다(한글 포함 문자열도 마찬가지) — 이 머신의 PowerShell 파이프가
// stdin으로 넘긴 한글을 깨뜨리는 알려진 문제가 있어(house 교훈), stdin 파이프는 아예 쓰지 않는다.

const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_CLI = path.join(REPO_ROOT, 'dist', 'src', 'server-cli.js');
const MAIN_JS = path.join(REPO_ROOT, 'dist', 'src', 'main.js');

type ServerProc = ChildProcessByStdio<null, Readable, Readable>;

interface Result { id: string; desc: string; pass: boolean; detail?: string }
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

async function killProc(proc: ServerProc | undefined): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  const pid = proc.pid;
  proc.kill();
  try {
    await waitFor(() => proc.exitCode !== null, 8000, 'server process exit');
  } catch {
    if (pid) {
      try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' }); } catch { /* 이미 죽었거나 실패 — 무시 */ }
    }
  }
}

function spawnServer(dataDir: string): { proc: ServerProc; getStderr: () => string } {
  let serverErr = '';
  const proc = spawn(process.execPath, [MAIN_JS], {
    cwd: REPO_ROOT,
    env: { ...process.env, ENGRAM_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ServerProc;
  proc.on('error', (err) => console.error('[server] spawn error', err));
  proc.stderr.on('data', (d) => (serverErr += d.toString()));
  return { proc, getStderr: () => serverErr };
}

async function waitHealthy(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const j = (await r.json()) as { ok?: boolean };
        if (j.ok) return;
      }
    } catch { /* 아직 리슨 전 — 재시도 */ }
    if (Date.now() >= deadline) throw new Error(`timeout(${timeoutMs}ms) waiting for server health on ${host}:${port}`);
    await sleep(300);
  }
}

async function jsonFetch(url: string, opts: RequestInit = {}): Promise<{ status: number; body: any; text: string }> {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  return { status: r.status, body, text };
}

// ── engram-server CLI를 실제 자식 프로세스로 실행(argv만 사용 — stdin 파이프 없음). ──
interface CliResult { stdout: string; stderr: string; code: number | null }
function runCli(args: string[], dataDir: string): CliResult {
  const r = spawnSync(process.execPath, [SERVER_CLI, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ENGRAM_DATA_DIR: dataDir },
    encoding: 'utf8',
    timeout: 30000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status };
}

function getFreePortSync(): number {
  return 40000 + Math.floor(Math.random() * 20000);
}

// ── dist 신선도: 이 스모크가 만지는 소스 목록을 대응 dist .js와 mtime 비교 ──
function checkStaleAndBuild(): void {
  const files = [
    'server-cli.ts', 'main.ts',
    'edge/server-admin.ts', 'edge/server-service.ts',
    'edge/auth/setup-code.ts', 'edge/auth/account-store.ts', 'edge/auth/auth-http.ts',
    'edge/auth/group-store.ts', 'edge/auth/permissions.ts',
    'edge/messenger/chat.config.ts', 'edge/messenger/chat-store.ts',
    'desktop/preset-file.ts', 'desktop/permissions-file.ts',
    'pal/path-resolver.ts', 'pal/supervisor/supervisor.factory.ts',
  ];
  let stale = false;
  for (const f of files) {
    const srcPath = path.join(REPO_ROOT, 'src', f);
    const distPath = path.join(REPO_ROOT, 'dist', 'src', f.replace(/\.ts$/, '.js'));
    if (!fs.existsSync(distPath)) { stale = true; break; }
    if (fs.statSync(srcPath).mtimeMs > fs.statSync(distPath).mtimeMs) { stale = true; break; }
  }
  if (stale) {
    console.log('[setup] dist가 stale — npm run build 실행 중 …');
    execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
  } else {
    console.log('[setup] dist 최신 — 빌드 스킵');
  }
}

// 탭 구분 표(formatUserList 출력) 한 줄을 파싱한다. 헤더 줄은 건너뛴다.
function parseUserRows(stdout: string): Array<{ id: string; loginId: string; displayName: string; role: string; status: string }> {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  const dataLines = lines.slice(1); // 헤더 'id\tloginId\t...' 제외
  return dataLines.map((l) => {
    const [id, loginId, displayName, role, status] = l.split('\t');
    return { id, loginId, displayName, role, status };
  });
}

// ── 메인 프로브 ──────────────────────────────────────────────────────────────────────────
async function probeServerCli(tmpBase: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  console.log('\n[Probe server-cli] engram-server CLI — node dist/src/server-cli.js 실행 + node dist/src/main.js 실 부트');
  const dataDir = path.join(tmpBase, 'server');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = getFreePortSync();

  // ── ① setup: 셋업 코드 생성(서버 부팅 전) ──
  const setupRes = runCli(['setup'], dataDir);
  const codeMatch = /셋업 코드: (\S+)/.exec(setupRes.stdout);
  record('1a', 'engram-server setup(부팅 전) → exitCode 0 + "셋업 코드: <hex>" 출력',
    setupRes.code === 0 && !!codeMatch, `stdout=${setupRes.stdout} stderr=${setupRes.stderr}`);
  const setupCodePath = path.join(dataDir, 'state', 'setup-code');
  const codeOnDisk = fs.existsSync(setupCodePath) ? fs.readFileSync(setupCodePath, 'utf8').trim() : null;
  record('1b', 'state/setup-code 파일이 CLI 출력과 동일한 코드로 생성됨',
    !!codeMatch && codeOnDisk === codeMatch[1], `cli=${codeMatch?.[1]} disk=${codeOnDisk}`);

  // ── ② config set port/retention ──
  const setPortRes = runCli(['config', 'set', 'port', String(port)], dataDir);
  record('2a', `engram-server config set port ${port} → exitCode 0 + "포트 저장됨: ${port} (서버 재시작 후 적용됩니다)"`,
    setPortRes.code === 0 && setPortRes.stdout.includes(`포트 저장됨: ${port}`) && setPortRes.stdout.includes('재시작 후 적용'),
    `stdout=${setPortRes.stdout}`);

  const setRetentionRes = runCli(['config', 'set', 'retention', 'count:7'], dataDir);
  record('2b', 'engram-server config set retention count:7 → exitCode 0 + "보존 정책 저장됨: count:7"',
    setRetentionRes.code === 0 && setRetentionRes.stdout.includes('보존 정책 저장됨: count:7'),
    `stdout=${setRetentionRes.stdout}`);

  const setBadRes = runCli(['config', 'set', 'port', '999999'], dataDir);
  record('2c', '잘못된 값(config set port 999999) → exitCode 1(검증 실패가 조용히 무시되지 않음)',
    setBadRes.code === 1, `stdout=${setBadRes.stdout} code=${setBadRes.code}`);

  // ── ③ config get 왕복(전체 + 개별 키) ──
  const getAllRes = runCli(['config', 'get'], dataDir);
  record('3a', `config get(키 생략, 전체) → port: ${port}·retention: count:7 둘 다 포함`,
    getAllRes.code === 0 && getAllRes.stdout.includes(`port: ${port}`) && getAllRes.stdout.includes('retention: count:7'),
    `stdout=${getAllRes.stdout}`);

  const getPortRes = runCli(['config', 'get', 'port'], dataDir);
  record('3b', `config get port(단일 키) → "port: ${port}"만 출력`,
    getPortRes.code === 0 && getPortRes.stdout.trim() === `port: ${port}`, `stdout=${getPortRes.stdout}`);

  const getRetentionRes = runCli(['config', 'get', 'retention'], dataDir);
  record('3c', 'config get retention(단일 키) → "retention: count:7"만 출력',
    getRetentionRes.code === 0 && getRetentionRes.stdout.trim() === 'retention: count:7', `stdout=${getRetentionRes.stdout}`);

  // ── ④ 실 서버 부팅(config set으로 저장한 port를 env 오버라이드 없이 그대로 읽어야 함) ──
  const host = '127.0.0.1';
  const base = `http://${host}:${port}`;
  const { proc, getStderr } = spawnServer(dataDir);
  cleanup.push(() => killProc(proc));

  try {
    await waitHealthy(host, port, 60000);
    record('4a', `node dist/src/main.js가 config set으로 저장한 포트(${port})로 실제 리슨(env 오버라이드 없이 파일값 사용)`, true);

    const codeAfterBoot = fs.existsSync(setupCodePath) ? fs.readFileSync(setupCodePath, 'utf8').trim() : null;
    record('4b', '부팅 후에도 셋업 코드가 동일(계정 0개라 재사용, main.ts ensureSetupCode가 새로 안 만듦)',
      codeAfterBoot === codeMatch?.[1], `before=${codeMatch?.[1]} after=${codeAfterBoot}`);

    // ── ⑤ 그 셋업 코드로 owner 생성(HTTP — 실제 웹 콘솔 흐름과 동일한 엔드포인트) ──
    const ownerSetupRes = await jsonFetch(`${base}/auth/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: codeMatch?.[1], loginId: 's5owner', password: 's5-owner-pw-1' }),
    });
    record('5a', 'POST /auth/setup(CLI가 만든 셋업 코드) → 200 + owner 토큰 발급',
      ownerSetupRes.status === 200 && !!ownerSetupRes.body.token, `status=${ownerSetupRes.status} body=${ownerSetupRes.text}`);

    const codeAfterOwner = fs.existsSync(setupCodePath) ? fs.readFileSync(setupCodePath, 'utf8').trim() : null;
    record('5b', 'owner 생성 성공 후 셋업 코드 파일이 삭제됨(1회용 재확인)', codeAfterOwner === null, `codeAfterOwner=${codeAfterOwner}`);

    // pending 상태 멤버 하나 등록(승인 대상 확보).
    const regRes = await jsonFetch(`${base}/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loginId: 's5member', password: 's5-member-pw-1', displayName: 's5member' }),
    });
    record('5c', 'POST /auth/register(멤버) → pending:true', regRes.status === 200 && regRes.body.pending === true, `body=${regRes.text}`);

    // ── ⑥ user list/approve(CLI, 서버 실행 중 — 같은 accounts.json을 CLI가 직접 읽고 씀) ──
    const listBeforeRes = runCli(['user', 'list'], dataDir);
    const rowsBefore = parseUserRows(listBeforeRes.stdout);
    const ownerRow = rowsBefore.find((r) => r.loginId === 's5owner');
    const memberRowBefore = rowsBefore.find((r) => r.loginId === 's5member');
    record('6a', 'engram-server user list → owner(active·role owner)·member(pending) 둘 다 표에 보임',
      listBeforeRes.code === 0 && ownerRow?.status === 'active' && ownerRow?.role === 'owner' && memberRowBefore?.status === 'pending',
      `rows=${JSON.stringify(rowsBefore)}`);

    if (!memberRowBefore) throw new Error('user list에서 s5member를 못 찾음 — 이후 approve 단계 진행 불가');
    const approveRes = runCli(['user', 'approve', memberRowBefore.id], dataDir);
    record('6b', `engram-server user approve ${memberRowBefore.id} → exitCode 0 + "승인됨: s5member"`,
      approveRes.code === 0 && approveRes.stdout.includes('승인됨: s5member'), `stdout=${approveRes.stdout}`);

    const listAfterRes = runCli(['user', 'list'], dataDir);
    const memberRowAfter = parseUserRows(listAfterRes.stdout).find((r) => r.loginId === 's5member');
    record('6c', 'approve 후 user list에서 s5member 상태가 active로 바뀜', memberRowAfter?.status === 'active', `row=${JSON.stringify(memberRowAfter)}`);

    // 이미 active인 계정을 다시 approve → 조용히 성공 처리하지 않고 명시적으로 실패(파일럿 회귀 방지).
    const reApproveRes = runCli(['user', 'approve', memberRowBefore.id], dataDir);
    record('6d', '이미 active인 계정을 다시 approve → exitCode 1(승인 대상 아님을 명시)',
      reApproveRes.code === 1, `stdout=${reApproveRes.stdout}`);

    // ── ⑦ preset export(파일 생성 확인) ──
    const presetPath = path.join(tmpBase, 'preset-export.json');
    const presetRes = runCli(['preset', 'export', presetPath], dataDir);
    record('7a', `engram-server preset export ${presetPath} → exitCode 0 + "preset 저장됨: ..."`,
      presetRes.code === 0 && presetRes.stdout.includes('preset 저장됨:'), `stdout=${presetRes.stdout}`);
    const presetFileExists = fs.existsSync(presetPath);
    record('7b', '지정한 경로에 preset.json 실제로 생성됨', presetFileExists, `path=${presetPath} exists=${presetFileExists}`);
    if (presetFileExists) {
      const presetJson = JSON.parse(fs.readFileSync(presetPath, 'utf8')) as { name?: string; endpoint?: string };
      record('7c', `preset.json 내용이 {name, endpoint: ws://127.0.0.1:${port}} 형태`,
        typeof presetJson.name === 'string' && presetJson.endpoint === `ws://127.0.0.1:${port}`,
        `preset=${JSON.stringify(presetJson)}`);
    }

    // ── ⑧ status(서버 실행 중) ──
    const statusRes = runCli(['status'], dataDir);
    record('8a', 'engram-server status → exitCode 0 + "리슨 중: 예"', statusRes.code === 0 && statusRes.stdout.includes('리슨 중: 예'), `stdout=${statusRes.stdout}`);
    record('8b', 'status가 멤버 2명(owner+approve된 member)을 보여줌', statusRes.stdout.includes('멤버: 2명'), `stdout=${statusRes.stdout}`);
    record('8c', 'status의 마지막 하트비트가 "없음"이 아님(main.ts가 ENGRAM_RESIDENT=1로 기동 즉시 1회 발화)',
      !statusRes.stdout.includes('마지막 하트비트: 없음'), `stdout=${statusRes.stdout}`);

    // ── ⑨ setup 재실행(owner 이미 있음) → alreadyConfigured 안내로 전환(1회용 재확인 보너스) ──
    const setupAgainRes = runCli(['setup'], dataDir);
    record('9', 'owner 생성 후 engram-server setup 재실행 → "이미 설정 완료" 안내(코드 재발급 안 함)',
      setupAgainRes.code === 0 && setupAgainRes.stdout.includes('이미 설정 완료'), `stdout=${setupAgainRes.stdout}`);

    if (getStderr().trim()) console.log('\n[server stderr(tail, 참고용)]\n' + getStderr().slice(-2000));
  } catch (e) {
    record('server-cli', 'engram-server CLI 프로브 전체 흐름 예외 없이 완료', false, String(e));
    const err = getStderr();
    if (err.trim()) console.log('\n[server stderr(tail)]\n' + err.slice(-3000));
  }
}

// ── service install/uninstall/status(윈도우 전용) ──
// install/uninstall은 실제로 호출하지 않는다(브리프의 안전 지침 — 이 머신은 비관리자라 안내 메시지가
// 기대 경로이고, node-windows의 실제 install()은 디스크에 winsw 래퍼·xml을 실제로 만든 뒤 비대화형
// 환경에서 감시되지 않는 승격을 시도할 수 있으며, windows-supervisor.ts의 uninstall()은 이벤트
// 매핑상 서비스가 애초에 없을 때 발생하는 'alreadyuninstalled'를 못 받아 무한 대기할 수 있다 — 둘 다
// 실기기에서 절대 재현하고 싶지 않은 위험. 대신 상태 조회만 실행한다: status는 fs.existsSync 두 번뿐인
// 순수 조회라 부작용이 전혀 없다.
async function probeService(tmpBase: string): Promise<void> {
  console.log('\n[Probe service] engram-server service — 윈도우 전용, install/uninstall은 실행하지 않음(아래 이유)');
  if (process.platform !== 'win32') {
    console.log('   [skip] 이 머신은 win32가 아님 — service 명령은 비윈도우 안내 메시지만 형식 확인');
    const dataDir = path.join(tmpBase, 'service-nonwin');
    fs.mkdirSync(dataDir, { recursive: true });
    const r = runCli(['service', 'status'], dataDir);
    record('10a', '비윈도우: service status → exitCode 1 + 비윈도우 안내(도커/engram-server start 사용법)',
      r.code === 1 && r.stdout.includes('윈도우 전용'), `stdout=${r.stdout}`);
    return;
  }
  const dataDir = path.join(tmpBase, 'service');
  fs.mkdirSync(dataDir, { recursive: true });
  const r = runCli(['service', 'status'], dataDir);
  record('10a', 'engram-server service status(윈도우, install 이력 없음) → exitCode 0 + "EngramServer 상태: not-installed"',
    r.code === 0 && r.stdout.includes('EngramServer 상태: not-installed'), `stdout=${r.stdout}`);
  console.log('   [skip note] install/uninstall은 실제로 실행하지 않음 — 이 머신은 비관리자 PowerShell이라');
  console.log('   installService()가 supervisor.install() 실패 시 안내 메시지를 반환하는 경로를 타는 것이');
  console.log('   기대 동작이지만, node-windows의 install()이 실제로 디스크에 서비스 래퍼 파일을 만들고');
  console.log('   비대화형 승격을 시도할 수 있어(감시 안 되면 무기한 대기 위험) 실기기에서 실행하지 않기로');
  console.log('   결정함(브리프 지침: "실기기에 서비스·방화벽 규칙을 남기지 않는다"). status(순수 조회)로 대체.');
}

// ── 도커: docker --version이 실패하면 skip 노트만 남긴다. ──
function probeDocker(): void {
  console.log('\n[Probe docker] docker --version 확인');
  let dockerAvailable = false;
  try {
    const r = spawnSync('docker', ['--version'], { encoding: 'utf8', timeout: 10000 });
    dockerAvailable = r.status === 0;
  } catch { dockerAvailable = false; }

  if (!dockerAvailable) {
    console.log('   [skip note] docker CLI가 이 머신에 없음(command not found) — docker build 실행 불가.');
    console.log('   Dockerfile·docker-compose.yml·.dockerignore는 Task 4에서 육안 검토+YAML 파싱 검증됨');
    console.log('   (.superpowers/sdd/task-4-report.md). 브리프가 허용하는 skip 경로.');
    return;
  }

  console.log('   [setup] docker 발견 — docker build 시도 중 …');
  const build = spawnSync('docker', ['build', '-t', 'engram-smoke-cli-test', '.'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 600000,
  });
  record('11', 'docker build -t engram-smoke-cli-test . → 성공', build.status === 0, `status=${build.status} stderr(tail)=${(build.stderr ?? '').slice(-500)}`);
  try { spawnSync('docker', ['rmi', 'engram-smoke-cli-test'], { encoding: 'utf8', timeout: 30000 }); } catch { /* 정리 실패는 무해 */ }
}

async function main(): Promise<void> {
  checkStaleAndBuild();

  const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'engram-smoke-server-cli-'));
  console.log(`[setup] temp base: ${tmpBase}`);
  const cleanup: Array<() => Promise<void>> = [];

  try {
    await probeServerCli(tmpBase, cleanup);
    await probeService(tmpBase);
    probeDocker();
  } finally {
    for (const task of cleanup.reverse()) {
      try { await task(); } catch { /* 정리 실패는 무해 — 계속 진행 */ }
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
