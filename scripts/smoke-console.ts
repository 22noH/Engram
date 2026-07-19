import 'reflect-metadata';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { execSync, spawn, ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { WebSocket } from 'ws';

// 실 스모크: 서버 콘솔 S1(플랜 docs/superpowers/plans/2026-07-19-server-console-s1.md Task 3).
// /admin 정적 서빙 + 셋업 + 로그인 + /admin/api/overview 게이트(무토큰 401·owner 200·non-owner 403)
// + 데스크톱 차단(ENGRAM_DESKTOP=1 → /admin 404) + traversal 방어를 진짜 node dist/src/main.js
// 프로세스 + 진짜 http로 검증한다. 우리 코드는 전혀 모킹하지 않는다(scripts/smoke-standalone.ts 관례 계승).
//
// 격리: ENGRAM_DATA_DIR는 항상 임시 디렉터리 — 절대 %APPDATA%\engram나 실사용자 데이터를 건드리지 않는다.
// 모든 대기는 타임아웃 있음(하우스룰). 자식 프로세스는 전부 'error' 리스너 보유.

const REPO_ROOT = path.resolve(__dirname, '..');

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
    } catch { /* 아직 리슨 전 — 재시도 */ }
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

// ── dist 신선도: 이 기능이 만지는 소스 목록을 대응 dist .js와 mtime 비교 ──
function checkStaleAndBuild(): void {
  const files = [
    'main.ts',
    'edge/admin/admin-http.ts',
    'edge/auth/auth-http.ts',
    'edge/auth/setup-code.ts',
    'edge/auth/account-store.ts',
    'edge/auth/session-store.ts',
    'edge/messenger/self.adapter.ts',
    'pal/resource-dir.ts',
    'pal/repo-root.ts',
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

// console/dist가 없으면(또는 index.html 없으면) console:build 실행.
function ensureConsoleDist(): void {
  const indexPath = path.join(REPO_ROOT, 'console', 'dist', 'index.html');
  if (fs.existsSync(indexPath)) {
    console.log('[setup] console/dist 존재 — 빌드 스킵');
    return;
  }
  console.log('[setup] console/dist 없음 — npm run console:build 실행 중 …');
  execSync('npm run console:build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

function getFreePortSync(): number {
  return 40000 + Math.floor(Math.random() * 20000);
}

// ── 메인 프로브: 서버 모드(ENGRAM_CHAT_ROLE 미설정) — 서빙·셋업·로그인·개요 게이트·traversal ──
async function probeServerMode(tmpBase: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  console.log('\n[Probe server] 서버 콘솔 S1 — node dist/src/main.js 실 부트');
  const dataDir = path.join(tmpBase, 'server');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = getFreePortSync();

  const { proc, getStderr } = spawnServer(dataDir, {
    ENGRAM_CHAT_PORT: String(port),
    ENGRAM_CHAT_BIND: '127.0.0.1',
    // ENGRAM_CHAT_ROLE·ENGRAM_DESKTOP 둘 다 미설정 — 기본값(서버 역할+/admin 서빙) 검증이 핵심.
  });
  cleanup.push(() => killProc(proc));

  try {
    await waitHealthy('127.0.0.1', port, 60000);
    console.log(`   [setup] 서버 healthy on :${port} (role=server 기본, 0계정)`);

    // ①GET /admin(무슬래시) → 302 + Location: /admin/ (S1 최종리뷰: base='/admin/' 고정 마운트라
    // 무슬래시로 index.html을 서빙하면 자산 URL이 사이트 루트로 풀려 404→빈 페이지가 됐다. redirect:
    // 'manual'로 자동 추적을 끄고 302 자체를 검증한다.
    const adminNoSlashRes = await fetch(`http://127.0.0.1:${port}/admin`, { redirect: 'manual' });
    record('1', 'GET /admin(무슬래시) → 302 + Location: /admin/',
      adminNoSlashRes.status === 302 && adminNoSlashRes.headers.get('location') === '/admin/',
      `status=${adminNoSlashRes.status} location=${adminNoSlashRes.headers.get('location')}`);

    // ①b GET /admin/(슬래시 포함) → 200 html + 그 안의 자산 URL(src="...")이 실제로 200으로 로드됨
    // (base='/admin/' 고정 마운트 회귀 방지 — 상대경로 base였다면 /admin/ 아래서는 우연히 맞았지만
    // 무슬래시에서 깨졌던 문제의 반대쪽 증거: 슬래시 있는 정상 경로에서도 자산이 실제로 뜨는지 확인).
    const adminRes = await fetch(`http://127.0.0.1:${port}/admin/`);
    const adminBody = await adminRes.text();
    const adminOk = adminRes.status === 200 && /<html/i.test(adminBody);
    record('1a', 'GET /admin/ → 200 + html(index.html 서빙)', adminOk, `status=${adminRes.status} ct=${adminRes.headers.get('content-type')} len=${adminBody.length}`);

    const assetMatch = /\bsrc="([^"]+)"/.exec(adminBody);
    if (assetMatch) {
      const assetUrl = new URL(assetMatch[1], `http://127.0.0.1:${port}/admin/`).toString();
      const assetRes = await fetch(assetUrl);
      record('1b', 'index.html의 자산 URL(src=)이 페이지 URL 기준으로 풀려 200으로 로드됨',
        assetRes.status === 200, `assetUrl=${assetUrl} status=${assetRes.status}`);
    } else {
      record('1b', 'index.html의 자산 URL(src=)이 페이지 URL 기준으로 풀려 200으로 로드됨', false, `html에서 src="..." 매치 실패(len=${adminBody.length})`);
    }

    // ②/auth/status → configured:false(계정 0개)
    const statusBefore = await (await fetch(`http://127.0.0.1:${port}/auth/status`)).json();
    record('2', '/auth/status가 configured:false(계정 0개)', statusBefore.configured === false, JSON.stringify(statusBefore));

    // ③setup-code 파일 읽고 → /auth/setup → 200 token(owner 생성)
    const setupCodePath = path.join(dataDir, 'state', 'setup-code');
    await waitFor(() => fs.existsSync(setupCodePath), 5000, 'state/setup-code 파일 생성');
    const setupCode = fs.readFileSync(setupCodePath, 'utf8').trim();
    record('3a', 'state/setup-code 파일이 생성되고 비어있지 않음', setupCode.length > 0, `len=${setupCode.length}`);

    const setupRes = await fetch(`http://127.0.0.1:${port}/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: setupCode, loginId: 'consoleowner', password: 'console-owner-pw-1' }),
    });
    const setupBody = await setupRes.json().catch(() => ({}));
    record('3b', 'POST /auth/setup(정답 코드) → 200 + token + user(role=owner)', setupRes.status === 200 && !!setupBody.token && setupBody.user?.role === 'owner', `status=${setupRes.status} body=${JSON.stringify(setupBody)}`);
    const ownerToken: string = setupBody.token ?? '';

    // ④POST /auth/login(방금 만든 계정) → 200 token
    const loginRes = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loginId: 'consoleowner', password: 'console-owner-pw-1' }),
    });
    const loginBody = await loginRes.json().catch(() => ({}));
    record('4', 'POST /auth/login(생성한 계정) → 200 + token', loginRes.status === 200 && !!loginBody.token, `status=${loginRes.status} body=${JSON.stringify(loginBody)}`);
    const loggedInToken: string = loginBody.token ?? ownerToken;

    // ⑤GET /admin/api/overview(owner 토큰) → 200 + 계약 필드 전부
    const overviewRes = await fetch(`http://127.0.0.1:${port}/admin/api/overview`, {
      headers: { authorization: `Bearer ${loggedInToken}` },
    });
    const overviewBody = await overviewRes.json().catch(() => ({}));
    const requiredFields = ['members', 'pendingMembers', 'channels', 'wikiPages', 'pendingProposals', 'todayMessages', 'pendingMemberNames', 'pendingProposalTitles'];
    const missing = requiredFields.filter((k) => !(k in overviewBody));
    record('5', 'GET /admin/api/overview(owner) → 200 + 계약 필드 전부(pendingMemberNames·pendingProposalTitles 배열 포함)',
      overviewRes.status === 200 && missing.length === 0 && Array.isArray(overviewBody.pendingMemberNames) && Array.isArray(overviewBody.pendingProposalTitles),
      `status=${overviewRes.status} missing=${JSON.stringify(missing)} body=${JSON.stringify(overviewBody)}`);

    // ⑥무토큰 → 401
    const noTokenRes = await fetch(`http://127.0.0.1:${port}/admin/api/overview`);
    const noTokenBody = await noTokenRes.json().catch(() => ({}));
    record('6', 'GET /admin/api/overview(무토큰) → 401', noTokenRes.status === 401, `status=${noTokenRes.status} body=${JSON.stringify(noTokenBody)}`);

    // ⑦비owner(가입 계정 승인 후 로그인) → 403
    // /auth/register는 pending 계정만 만들고 토큰을 안 주므로(로그인 불가) — owner ws로 adminApprove해
    // active로 만든 뒤 /auth/login으로 진짜 non-owner 토큰을 얻는다(플랜 3의 "document-skip 대신
    // 승인 API로 해소" 경로 — ws admin 프레임이 이미 있어 heavy하지 않았다).
    try {
      const regRes = await fetch(`http://127.0.0.1:${port}/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ loginId: 'consolemember', password: 'console-member-pw-1', displayName: 'Console Member' }),
      });
      const regBody = await regRes.json().catch(() => ({}));
      const registeredPending = regRes.status === 200 && regBody.pending === true;

      const ws = await connectWs('127.0.0.1', port, 15000);
      cleanup.push(async () => { try { ws.terminate(); } catch { /* 격리 */ } });
      const authOk = await waitForFrame(ws, (f) => f.t === 'authOk' || f.t === 'authErr', 8000, 'owner ws 인증 응답', { t: 'auth', token: loggedInToken });
      const wsAuthed = authOk.t === 'authOk' && authOk.user?.role === 'owner';

      const adminList = await waitForFrame(ws, (f) => f.t === 'adminUsers', 8000, 'adminUsers 목록', { t: 'adminUsers' });
      const pendingAcc = (adminList.list as any[]).find((a) => a.loginId === 'consolemember');

      let approved = false;
      let memberToken = '';
      if (pendingAcc) {
        const afterApprove = await waitForFrame(ws, (f) => f.t === 'adminUsers', 8000, 'adminApprove 후 목록', { t: 'adminApprove', id: pendingAcc.id });
        const nowActive = (afterApprove.list as any[]).find((a: any) => a.id === pendingAcc.id);
        approved = nowActive?.status === 'active';

        const memberLoginRes = await fetch(`http://127.0.0.1:${port}/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ loginId: 'consolemember', password: 'console-member-pw-1' }),
        });
        const memberLoginBody = await memberLoginRes.json().catch(() => ({}));
        memberToken = memberLoginBody.token ?? '';
      }

      if (memberToken) {
        const forbiddenRes = await fetch(`http://127.0.0.1:${port}/admin/api/overview`, {
          headers: { authorization: `Bearer ${memberToken}` },
        });
        const forbiddenBody = await forbiddenRes.json().catch(() => ({}));
        record('7', 'GET /admin/api/overview(승인된 non-owner 토큰) → 403',
          forbiddenRes.status === 403,
          `registeredPending=${registeredPending} wsAuthed=${wsAuthed} approved=${approved} status=${forbiddenRes.status} body=${JSON.stringify(forbiddenBody)}`);
      } else {
        record('7', 'GET /admin/api/overview(승인된 non-owner 토큰) → 403', false,
          `non-owner 토큰 확보 실패(registeredPending=${registeredPending} wsAuthed=${wsAuthed} pendingAcc=${!!pendingAcc} approved=${approved}) — document-skip 대상`);
      }
    } catch (e) {
      record('7', 'GET /admin/api/overview(승인된 non-owner 토큰) → 403', false, `예외: ${String(e)} — document-skip 대상`);
    }

    // ⑨traversal — ..%5c.. 등 인코딩 경유 상위 탈출 시도 → 404(정적 서빙 root 밖 이스케이프 불가)
    const traversalPaths = [
      '/admin/..%5c..%5cpackage.json',
      '/admin/..%2f..%2fpackage.json',
      '/admin/%2e%2e/%2e%2e/package.json',
    ];
    let traversalAllPass = true;
    const traversalDetail: string[] = [];
    for (const p of traversalPaths) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      const ok = r.status === 404;
      traversalAllPass = traversalAllPass && ok;
      traversalDetail.push(`${p} → ${r.status}`);
    }
    record('9', 'traversal(..%5c.. 등 인코딩 경유) → 전부 404(root 밖 이스케이프 불가)', traversalAllPass, traversalDetail.join('; '));

    if (getStderr().trim()) console.log('\n[server stderr(tail, 참고용)]\n' + getStderr().slice(-2000));
  } catch (e) {
    record('server', '서버 모드 프로브 전체 흐름 예외 없이 완료', false, String(e));
    const err = getStderr();
    if (err.trim()) console.log('\n[server stderr(tail)]\n' + err.slice(-3000));
  }
}

// ── 브레인 모드 프로브: ENGRAM_CHAT_ROLE=brain → /admin 404(authDeps 자체가 없어 라우팅 안 됨) ──
async function probeBrainMode(tmpBase: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  console.log('\n[Probe brain] ENGRAM_CHAT_ROLE=brain — /admin 404(구조상 미배선)');
  const dataDir = path.join(tmpBase, 'brain');
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
    const r = await fetch(`http://127.0.0.1:${port}/admin`);
    record('brain-admin', 'brain 모드는 /admin이 404(authDeps 미주입 → self.adapter 라우팅 자체가 안 됨)', r.status === 404, `status=${r.status}`);
    if (getStderr().trim()) console.log('\n[brain stderr(tail, 참고용)]\n' + getStderr().slice(-2000));
  } catch (e) {
    record('brain', 'brain 모드 프로브 전체 흐름 예외 없이 완료', false, String(e));
    const err = getStderr();
    if (err.trim()) console.log('\n[brain stderr(tail)]\n' + err.slice(-3000));
  }
}

// ── 데스크톱 프로브: ENGRAM_DESKTOP=1 — 서버 역할이라도 /admin 404(콘솔=서버 에디션 전용) ──
async function probeDesktopMode(tmpBase: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  console.log('\n[Probe desktop] ENGRAM_DESKTOP=1 — 서버 역할이라도 /admin 404');
  const dataDir = path.join(tmpBase, 'desktop');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = getFreePortSync();

  const { proc, getStderr } = spawnServer(dataDir, {
    ENGRAM_CHAT_PORT: String(port),
    ENGRAM_CHAT_BIND: '127.0.0.1',
    ENGRAM_DESKTOP: '1',
    // ENGRAM_CHAT_ROLE 미설정 — isServer=true지만 ENGRAM_DESKTOP='1'이라 adminDeps 자체를 안 만든다(main.ts).
  });
  cleanup.push(() => killProc(proc));

  try {
    await waitHealthy('127.0.0.1', port, 60000);
    const r = await fetch(`http://127.0.0.1:${port}/admin`);
    record('8', 'ENGRAM_DESKTOP=1 부트 → /admin 404(데스크톱 상주 백엔드는 콘솔 서빙 안 함)', r.status === 404, `status=${r.status}`);
    // /auth/status는 정상 배선(authDeps는 여전히 있음, adminDeps만 없음) — 구조 확인용 부가 증거.
    const s = await (await fetch(`http://127.0.0.1:${port}/auth/status`)).json();
    record('8b', 'ENGRAM_DESKTOP=1이어도 /auth/status는 정상 배선(adminDeps만 스킵됨, authDeps는 유지)', typeof s.configured === 'boolean', JSON.stringify(s));
    if (getStderr().trim()) console.log('\n[desktop stderr(tail, 참고용)]\n' + getStderr().slice(-2000));
  } catch (e) {
    record('8', 'ENGRAM_DESKTOP=1 프로브 전체 흐름 예외 없이 완료', false, String(e));
    const err = getStderr();
    if (err.trim()) console.log('\n[desktop stderr(tail)]\n' + err.slice(-3000));
  }
}

async function main(): Promise<void> {
  checkStaleAndBuild();
  ensureConsoleDist();

  const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'engram-smoke-console-'));
  console.log(`[setup] temp base: ${tmpBase}`);
  const cleanup: Array<() => Promise<void>> = [];

  try {
    await probeServerMode(tmpBase, cleanup);
    await probeDesktopMode(tmpBase, cleanup);
    await probeBrainMode(tmpBase, cleanup);
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
