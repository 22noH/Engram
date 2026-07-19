import 'reflect-metadata';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { execSync, spawn, ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { WebSocket } from 'ws';

// 실 스모크: "배포 형태 분리(스탠드얼론 무게이트)" — 계정 0개+루프백이면 게이트 생략(Task 1
// self.adapter.isFreeSocket/bypassAuth), 계정이 생기는 순간 다음 프레임부터 즉시 재게이트,
// 비루프백은 계정 0개여도 게이트 유지, brain 모드는 항상 무인증(회귀 없음)을 4개 프로브로 검증한다.
// 우리 코드는 전혀 모킹하지 않는다 — 진짜 node dist/src/main.js 프로세스 + 진짜 ws 클라이언트 + 진짜 http.
//
// 격리: ENGRAM_DATA_DIR는 항상 임시 디렉터리 — 절대 %APPDATA%\engram나 ~/.claude.json에 쓰지 않는다
// (main.ts 부트가 ~/.claude.json을 읽기만 하는 mirrorClaudeMcp를 호출하는 것은 기존 관례상 허용).
// 모든 대기는 타임아웃 있음(하우스룰). 자식 프로세스는 전부 'error' 리스너 보유.

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

function spawnServer(dataDir: string, env: Record<string, string>): { proc: ServerProc; getStderr: () => string } {
  let serverErr = '';
  const proc = spawn(process.execPath, [path.join(REPO_ROOT, 'dist', 'src', 'main.js')], {
    cwd: REPO_ROOT,
    env: { ...process.env, ENGRAM_DATA_DIR: dataDir, ...env },
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
    } catch {
      /* 아직 리슨 전 — 재시도 */
    }
    if (Date.now() >= deadline) throw new Error(`timeout(${timeoutMs}ms) waiting for server health on ${host}:${port}`);
    await sleep(300);
  }
}

function connectWs(host: string, port: number, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}:${port}`);
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* 격리 */ }
      reject(new Error(`timeout(${timeoutMs}ms) connecting ws://${host}:${port}`));
    }, timeoutMs);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// 프레임을 보내고(옵션) predicate에 맞는 응답을 기다린다. send 전에 리스너부터 건다(race 없음).
function waitForFrame<T = any>(ws: WebSocket, pred: (f: any) => boolean, timeoutMs: number, label: string, send?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timeout(${timeoutMs}ms) waiting for ${label}`));
    }, timeoutMs);
    function onMsg(raw: Buffer | string): void {
      let f: any;
      try { f = JSON.parse(String(raw)); } catch { return; }
      if (pred(f)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(f);
      }
    }
    ws.on('message', onMsg);
    if (send !== undefined) ws.send(JSON.stringify(send));
  });
}

// 일정 시간 동안 아무 메시지도 predicate에 안 걸리면 통과(부재 증명). 걸리면 실패로 reject.
function expectNoFrame(ws: WebSocket, pred: (f: any) => boolean, waitMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      resolve();
    }, waitMs);
    function onMsg(raw: Buffer | string): void {
      let f: any;
      try { f = JSON.parse(String(raw)); } catch { return; }
      if (pred(f)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        reject(new Error(`unexpected frame: ${JSON.stringify(f)}`));
      }
    }
    ws.on('message', onMsg);
  });
}

function waitClose(ws: WebSocket, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(true); return; }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    ws.once('close', () => { clearTimeout(timer); resolve(true); });
  });
}

// LAN(비루프백) IPv4 하나를 찾는다 — 없으면 undefined(프로브 3을 증거와 함께 스킵).
function findLanIPv4(): string | undefined {
  const nics = os.networkInterfaces();
  for (const addrs of Object.values(nics)) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return undefined;
}

// ── dist 신선도 확인: 이 기능이 만지는 소스 목록을 대응 dist .js와 mtime 비교 ──
function checkStaleAndBuild(): void {
  const files = [
    'main.ts',
    'edge/auth/auth-http.ts',
    'edge/auth/setup-code.ts',
    'edge/auth/account-store.ts',
    'edge/auth/session-store.ts',
    'edge/auth/auth.config.ts',
    'edge/messenger/self.adapter.ts',
    'edge/messenger/chat.config.ts',
    'edge/mcp/mcp-http.ts',
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

function getFreePortSync(): number {
  // 포트 충돌 회피를 위해 넉넉한 임의 범위에서 고른다(실 미점유 여부는 서버 부팅 실패로 드러남 —
  // 별도 net.createServer 프로빙 없이 스크립트를 단순하게 유지, 하우스 스모크들과 동일 결).
  return 40000 + Math.floor(Math.random() * 20000);
}

// ── Probe 1+2: 스탠드얼론 무인증 ws 실왕복 + 계정 생성 시 게이트 재가동(같은 서버·같은 소켓) ──
async function probe1and2(tmpBase: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  console.log('\n[Probe 1+2] 스탠드얼론 무인증 왕복 → 계정 생성 즉시 재게이트 — node dist/src/main.js 실 부트');
  const dataDir = path.join(tmpBase, 'p1');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = getFreePortSync();

  const { proc, getStderr } = spawnServer(dataDir, {
    ENGRAM_CHAT_PORT: String(port),
    ENGRAM_CHAT_BIND: '127.0.0.1',
    // ENGRAM_CHAT_ROLE 의도적으로 미설정 — 기본값(server 역할) 검증이 이 프로브의 핵심.
  });
  cleanup.push(() => killProc(proc));

  try {
    await waitHealthy('127.0.0.1', port, 60000);
    console.log(`   [setup] 서버 healthy on :${port} (role=server 기본, 0계정, 루프백)`);

    // 1a: /auth/status — localFree:true, configured:false (계정 생성 전)
    const statusBefore = await (await fetch(`http://127.0.0.1:${port}/auth/status`)).json();
    record('1a', "/auth/status가 configured:false·localFree:true (0계정+루프백)", statusBefore.localFree === true && statusBefore.configured === false, JSON.stringify(statusBefore));

    // 1b: 무인증 ws 연결 — auth 프레임 전송 없이 channels 요청 → 응답이 와야 함(이전엔 무시됐다는 회귀 대상).
    const ws = await connectWs('127.0.0.1', port, 15000);
    cleanup.push(async () => { try { ws.terminate(); } catch { /* 격리 */ } });

    const chFrame = await waitForFrame(ws, (f) => f.t === 'channels', 8000, "무인증 channels 프레임 응답", { t: 'channels' });
    record('1b', '무인증 소켓의 channels 요청에 channels 프레임으로 응답(무시되지 않음)', chFrame.t === 'channels' && Array.isArray(chFrame.list), JSON.stringify({ t: chFrame.t, n: chFrame.list?.length }));

    // 1c: 채널 생성
    const created = await waitForFrame(
      ws,
      (f) => f.t === 'channels' && f.list.some((c: any) => c.name === 'StandaloneSmokeChannel'),
      8000,
      'createChannel 응답',
      { t: 'createChannel', name: 'StandaloneSmokeChannel' },
    );
    const chanId: string | undefined = created.list.find((c: any) => c.name === 'StandaloneSmokeChannel')?.id;
    record('1c', '무인증 소켓의 createChannel이 실제로 채널을 만들고 브로드캐스트됨', !!chanId, JSON.stringify(created.list?.map((c: any) => c.name)));

    // 1d: 메시지 전송 → msg 프레임(에코/브로드캐스트) 수신
    if (chanId) {
      const msgText = '스탠드얼론 무인증 스모크 메시지';
      const msgFrame = await waitForFrame(
        ws,
        (f) => f.t === 'msg' && f.channelId === chanId && f.message?.text === msgText,
        8000,
        '전송 메시지 브로드캐스트',
        { t: 'send', channelId: chanId, text: msgText },
      );
      record('1e', '무인증 소켓의 send가 accepted(msg 프레임으로 브로드캐스트됨)', msgFrame.message?.text === msgText, JSON.stringify(msgFrame.message));
    } else {
      record('1e', '무인증 소켓의 send가 accepted(msg 프레임으로 브로드캐스트됨)', false, 'chanId 없음(1c 실패로 스킵)');
    }

    // ── Probe 2: 계정 생성 시 게이트 재가동 ──
    console.log('\n[Probe 2] 계정 생성 시 게이트 재가동 — 같은 서버·같은 아직 열린 무인증 소켓');

    const setupCodePath = path.join(dataDir, 'state', 'setup-code');
    await waitFor(() => fs.existsSync(setupCodePath), 5000, 'state/setup-code 파일 생성');
    const setupCode = fs.readFileSync(setupCodePath, 'utf8').trim();
    record('2a', '부트 시 state/setup-code 파일이 생성되고 비어있지 않음', setupCode.length > 0, `path=${setupCodePath} len=${setupCode.length}`);

    const setupRes = await fetch(`http://127.0.0.1:${port}/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: setupCode, loginId: 'smokeowner', password: 'smoke-pw-12345' }),
    });
    const setupBody = await setupRes.json().catch(() => ({}));
    record('2b', 'POST /auth/setup(정답 코드)이 200과 token+user를 반환', setupRes.status === 200 && !!setupBody.token && !!setupBody.user, `status=${setupRes.status} body=${JSON.stringify(setupBody)}`);

    // 2c: 계정이 방금 생겼으니 같은(아직 열려있는) 무인증 소켓은 더 이상 free가 아니다 — 다음 프레임은
    // authed WeakSet에도 없으므로 handleFrame의 !isConnected(ws) 분기로 떨어져 authErr+close가 기대값.
    let gotAuthErr = false;
    const authErrOrClose = Promise.race([
      waitForFrame(ws, (f) => f.t === 'authErr', 6000, 'authErr(재게이트)').then(() => { gotAuthErr = true; }),
      waitClose(ws, 6000).then((closed) => { if (closed && !gotAuthErr) { /* 프레임 없이 바로 닫힘도 게이트 증거 */ } }),
    ]);
    ws.send(JSON.stringify({ t: 'channels' }));
    let raced = false;
    try { await authErrOrClose; raced = true; } catch { raced = false; }
    const closedAfter = ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;
    record('2c', '계정 생성 직후 같은 무인증 소켓의 다음 프레임은 authErr 또는 연결종료(게이트 재가동, 무시되지 않음)', raced && (gotAuthErr || closedAfter), `gotAuthErr=${gotAuthErr} closedAfter=${closedAfter}`);

    // 2d: /auth/status가 즉시 반영됨
    const statusAfter = await (await fetch(`http://127.0.0.1:${port}/auth/status`)).json();
    record('2d', "계정 생성 후 /auth/status가 configured:true·localFree:false", statusAfter.configured === true && statusAfter.localFree === false, JSON.stringify(statusAfter));

    // 2e: 새 ws 연결(무인증) — 계정이 있으니 이제는 게이트가 적용돼야 한다(5s 타임아웃 close 또는 authErr).
    const ws2 = await connectWs('127.0.0.1', port, 15000);
    cleanup.push(async () => { try { ws2.terminate(); } catch { /* 격리 */ } });
    let ws2GotAuthErr = false;
    let ws2Closed = false;
    const gate2 = Promise.race([
      waitForFrame(ws2, (f) => f.t === 'authErr', 7000, 'ws2 authErr').then(() => { ws2GotAuthErr = true; }),
      waitClose(ws2, 7000).then((c) => { ws2Closed = c; }),
    ]);
    try { await gate2; } catch { /* close 경로는 reject 없음, authErr 타임아웃이면 위에서 이미 처리 */ }
    // channels 요청도 함께 보내 무응답(게이트)임을 추가 확증 — 이미 닫혔으면 send가 예외를 던질 수 있어 격리.
    try { ws2.send(JSON.stringify({ t: 'channels' })); } catch { /* 격리 — 이미 닫힘도 게이트 증거 */ }
    let ws2GotChannels = false;
    try {
      await waitForFrame(ws2, (f) => f.t === 'channels', 1500, 'ws2 channels(있으면 안 됨)');
      ws2GotChannels = true;
    } catch { /* 응답 없음 = 기대값 */ }
    record('2e', '계정 생성 후 새 무인증 ws 연결은 게이트됨(5s 타임아웃 close 또는 authErr, channels 응답 없음)', (ws2GotAuthErr || ws2Closed) && !ws2GotChannels, `authErr=${ws2GotAuthErr} closed=${ws2Closed} gotChannels=${ws2GotChannels}`);

    if (getStderr().trim()) console.log('\n[p1 server stderr(tail, 참고용 — 실패 아닐 수 있음)]\n' + getStderr().slice(-2000));
  } catch (e) {
    record('1-2', 'probe1+2 전체 흐름 예외 없이 완료', false, String(e));
    const err = getStderr();
    if (err.trim()) console.log('\n[p1 server stderr(tail)]\n' + err.slice(-3000));
  }
}

// ── Probe 3: 비루프백 게이트 유지(가능하면) ──
async function probe3(tmpBase: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  console.log('\n[Probe 3] 비루프백 게이트 유지 — 0.0.0.0 바인딩 + LAN IP에서 접속');
  const lanIp = findLanIPv4();
  record('3-pre', '이 머신에 비루프백 IPv4(LAN) 주소가 1개 이상 존재', !!lanIp, lanIp ? `lanIp=${lanIp}` : '없음 — 아래 나머지 프로브3 단언은 스킵');
  if (!lanIp) {
    console.log('   [skip] 비루프백 IPv4를 찾지 못해 프로브3 나머지 단언을 건너뜀(증거: os.networkInterfaces()에 non-internal IPv4 없음) — 다른 머신/네트워크에서 실행 시 통과 가능');
    return;
  }

  const dataDir = path.join(tmpBase, 'p3');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = getFreePortSync();

  const { proc, getStderr } = spawnServer(dataDir, {
    ENGRAM_CHAT_PORT: String(port),
    ENGRAM_CHAT_BIND: '0.0.0.0',
    // ENGRAM_CHAT_ROLE 미설정 — role=server 기본, 계정 0개(신규 dataDir).
  });
  cleanup.push(() => killProc(proc));

  try {
    await waitHealthy('127.0.0.1', port, 60000); // 헬스체크 자체는 로컬로(0.0.0.0 바인딩이므로 127.0.0.1도 도달 가능)
    console.log(`   [setup] 서버 healthy on 0.0.0.0:${port}, LAN IP ${lanIp}에서 접속 시도`);

    // 3a: /auth/status를 LAN IP 경유로 조회 — 계정 0개여도 비루프백이면 localFree:false여야 한다.
    let statusLan: any;
    try {
      const r = await fetch(`http://${lanIp}:${port}/auth/status`, { signal: AbortSignal.timeout(5000) });
      statusLan = await r.json();
      record('3a', 'LAN IP 경유 /auth/status: 계정0개여도 비루프백이면 localFree:false', statusLan.localFree === false, JSON.stringify(statusLan));
    } catch (e) {
      record('3a', 'LAN IP 경유 /auth/status 요청 자체가 성공', false, String(e));
    }

    // 3b: LAN IP로 ws 연결 → 무인증 프레임은 게이트(응답 없음/close), 계정 0개인데도 free 취급되지 않아야 한다.
    try {
      const ws = await connectWs(lanIp, port, 10000);
      cleanup.push(async () => { try { ws.terminate(); } catch { /* 격리 */ } });
      let gotChannels = false;
      let gotAuthErr = false;
      let closed = false;
      const race = Promise.race([
        waitForFrame(ws, (f) => f.t === 'channels', 7000, 'LAN ws channels(있으면 안 됨)').then(() => { gotChannels = true; }),
        waitForFrame(ws, (f) => f.t === 'authErr', 7000, 'LAN ws authErr').then(() => { gotAuthErr = true; }),
        waitClose(ws, 7000).then((c) => { closed = c; }),
      ]);
      ws.send(JSON.stringify({ t: 'channels' }));
      await race.catch(() => { /* channels 타임아웃은 기대 경로 — 무시 */ });
      record('3b', 'LAN IP 무인증 소켓은 channels 요청에도 응답 없음(게이트, free 아님) — authErr 또는 close만 허용', !gotChannels && (gotAuthErr || closed), `gotChannels=${gotChannels} gotAuthErr=${gotAuthErr} closed=${closed}`);
    } catch (e) {
      record('3b', 'LAN IP ws 연결 자체가 성공(방화벽 등으로 실패 시 별도 원인)', false, String(e));
    }

    if (getStderr().trim()) console.log('\n[p3 server stderr(tail, 참고용)]\n' + getStderr().slice(-2000));
  } catch (e) {
    record('3', 'probe3 전체 흐름 예외 없이 완료', false, String(e));
    const err = getStderr();
    if (err.trim()) console.log('\n[p3 server stderr(tail)]\n' + err.slice(-3000));
  }
}

// ── Probe 4: brain 모드 회귀 — ENGRAM_CHAT_ROLE=brain은 항상 무인증(현행 유지) ──
async function probe4(tmpBase: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  console.log('\n[Probe 4] brain 모드 회귀 — ENGRAM_CHAT_ROLE=brain 무인증 ws 왕복');
  const dataDir = path.join(tmpBase, 'p4');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = getFreePortSync();

  const { proc, getStderr } = spawnServer(dataDir, {
    ENGRAM_CHAT_PORT: String(port),
    ENGRAM_CHAT_BIND: '127.0.0.1',
    ENGRAM_CHAT_ROLE: 'brain',
  });
  cleanup.push(() => killProc(proc));

  try {
    await waitHealthy('127.0.0.1', port, 60000);
    console.log(`   [setup] brain 모드 서버 healthy on :${port}`);

    const ws = await connectWs('127.0.0.1', port, 15000);
    cleanup.push(async () => { try { ws.terminate(); } catch { /* 격리 */ } });

    const chFrame = await waitForFrame(ws, (f) => f.t === 'channels', 8000, 'brain 모드 channels 응답', { t: 'channels' });
    record('4a', 'brain 모드는 authDeps 미배선 — 무인증 channels 요청에 정상 응답(회귀 없음)', chFrame.t === 'channels' && Array.isArray(chFrame.list), JSON.stringify({ n: chFrame.list?.length }));

    const created = await waitForFrame(
      ws,
      (f) => f.t === 'channels' && f.list.some((c: any) => c.name === 'BrainSmokeChannel'),
      8000,
      'brain 모드 createChannel 응답',
      { t: 'createChannel', name: 'BrainSmokeChannel' },
    );
    const chanId: string | undefined = created.list.find((c: any) => c.name === 'BrainSmokeChannel')?.id;
    record('4b', 'brain 모드에서 무인증 createChannel이 그대로 동작', !!chanId, JSON.stringify(created.list?.map((c: any) => c.name)));

    // brain 모드는 /auth/*가 배선되지 않는다(authDeps 미주입) — 404가 기대값(구조 확인용 부가 증거).
    const statusRes = await fetch(`http://127.0.0.1:${port}/auth/status`);
    record('4c', 'brain 모드는 /auth/status가 배선되지 않아 404(authDeps 미주입 구조 확인)', statusRes.status === 404, `status=${statusRes.status}`);

    if (getStderr().trim()) console.log('\n[p4 server stderr(tail, 참고용)]\n' + getStderr().slice(-2000));
  } catch (e) {
    record('4', 'probe4 전체 흐름 예외 없이 완료', false, String(e));
    const err = getStderr();
    if (err.trim()) console.log('\n[p4 server stderr(tail)]\n' + err.slice(-3000));
  }
}

async function main(): Promise<void> {
  checkStaleAndBuild();

  const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'engram-smoke-standalone-'));
  console.log(`[setup] temp base: ${tmpBase}`);
  const cleanup: Array<() => Promise<void>> = [];

  try {
    await probe1and2(tmpBase, cleanup);
    await probe3(tmpBase, cleanup);
    await probe4(tmpBase, cleanup);
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
