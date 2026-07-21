import 'reflect-metadata';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { execSync, spawn, ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { WebSocket } from 'ws';

// 실 스모크: 서버 콘솔 S3(플랜 .superpowers/sdd/task-4-brief.md, Task 4).
// 모델·MCP·위키·서버설정·preset admin api를 진짜 node dist/src/main.js 프로세스 + 진짜 http로
// 검증한다. 우리 코드는 전혀 모킹하지 않는다(scripts/smoke-console.ts 관례 그대로 계승 —
// 격리 임시 데이터 디렉터리·타임아웃 있는 대기·'error' 리스너 보유 자식 프로세스·finally 정리).
//
// ★보안 핵심(이 스모크의 존재 이유): API 키·OIDC clientSecret 원문이 GET 응답 어디에도
// 실리지 않는다는 것을 "정말로 JSON 문자열에 원문이 없는지" 바이트 단위로 검증한다.
//
// 격리: ENGRAM_DATA_DIR는 항상 임시 디렉터리 — 절대 %APPDATA%\engram나 실사용자 데이터를
// 건드리지 않는다(단, 서버 부팅 시 mirrorClaudeMcp가 ~/.claude.json을 읽는 것은 main.ts의
// 기존 부트 동작이라 불가피 — 읽기 전용, 쓰기는 전혀 하지 않는다).

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
    'desktop/brains-file.ts',
    'desktop/ollama.ts',
    'desktop/api-brain.ts',
    'desktop/mcp-file.ts',
    'desktop/wiki-remote-file.ts',
    'desktop/preset-file.ts',
    'edge/auth/auth.config.ts',
    'edge/messenger/chat.config.ts',
    'desktop/permissions-file.ts',
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

async function jsonFetch(url: string, opts: RequestInit = {}): Promise<{ status: number; body: any; text: string }> {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  return { status: r.status, body, text };
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function jsonHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

// owner 계정을 셋업하고 토큰을 반환한다(scripts/smoke-console.ts ③의 관성 재사용).
async function setupOwner(host: string, port: number, dataDir: string): Promise<string> {
  const setupCodePath = path.join(dataDir, 'state', 'setup-code');
  await waitFor(() => fs.existsSync(setupCodePath), 5000, 'state/setup-code 파일 생성');
  const setupCode = fs.readFileSync(setupCodePath, 'utf8').trim();
  const setupRes = await jsonFetch(`http://${host}:${port}/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: setupCode, loginId: 's3owner', password: 's3-owner-pw-1' }),
  });
  if (setupRes.status !== 200 || !setupRes.body.token) {
    throw new Error(`owner 셋업 실패: status=${setupRes.status} body=${setupRes.text}`);
  }
  return setupRes.body.token as string;
}

// 승인된 member 계정 토큰 확보(등록 → owner ws로 승인 → 로그인). scripts/smoke-console.ts ⑦ 관성.
async function createApprovedMember(host: string, port: number, ownerToken: string, loginId: string, cleanup: Array<() => Promise<void>>): Promise<string> {
  const regRes = await jsonFetch(`http://${host}:${port}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginId, password: `${loginId}-pw-1`, displayName: loginId }),
  });
  if (regRes.status !== 200 || regRes.body.pending !== true) {
    throw new Error(`member 등록 실패: status=${regRes.status} body=${regRes.text}`);
  }
  const ws = await connectWs(host, port, 15000);
  cleanup.push(async () => { try { ws.terminate(); } catch { /* 격리 */ } });
  const authOk = await waitForFrame(ws, (f) => f.t === 'authOk' || f.t === 'authErr', 8000, 'owner ws 인증 응답', { t: 'auth', token: ownerToken });
  if (authOk.t !== 'authOk') throw new Error('owner ws 인증 실패');
  const adminList = await waitForFrame(ws, (f) => f.t === 'adminUsers', 8000, 'adminUsers 목록', { t: 'adminUsers' });
  const pendingAcc = (adminList.list as any[]).find((a) => a.loginId === loginId);
  if (!pendingAcc) throw new Error(`pending 계정을 못 찾음: ${loginId}`);
  await waitForFrame(ws, (f) => f.t === 'adminUsers', 8000, 'adminApprove 후 목록', { t: 'adminApprove', id: pendingAcc.id });
  const loginRes = await jsonFetch(`http://${host}:${port}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginId, password: `${loginId}-pw-1` }),
  });
  if (loginRes.status !== 200 || !loginRes.body.token) {
    throw new Error(`member 로그인 실패: status=${loginRes.status} body=${loginRes.text}`);
  }
  return loginRes.body.token as string;
}

// ── 메인 프로브: 서버 모드 — 모델·MCP·위키·서버설정·preset admin api 전체 ──
async function probeAdminApis(tmpBase: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  console.log('\n[Probe admin-apis] 서버 콘솔 S3 — node dist/src/main.js 실 부트');
  const dataDir = path.join(tmpBase, 'server');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = getFreePortSync();
  const host = '127.0.0.1';
  const base = `http://${host}:${port}`;

  const { proc, getStderr } = spawnServer(dataDir, {
    ENGRAM_CHAT_PORT: String(port),
    ENGRAM_CHAT_BIND: '127.0.0.1',
    // ENGRAM_CHAT_ROLE·ENGRAM_DESKTOP 둘 다 미설정 — 서버 역할 기본값(콘솔 서빙 포함).
  });
  cleanup.push(() => killProc(proc));

  try {
    await waitHealthy(host, port, 60000);
    console.log(`   [setup] 서버 healthy on :${port} (role=server 기본, 0계정)`);

    const ownerToken = await setupOwner(host, port, dataDir);
    console.log('   [setup] owner 셋업 완료, 토큰 확보');

    // ── ①모델: 로컬 모델 추가 → 목록에 보임 → 기본 전환 → 하네스=engram ──────────────
    const addOllamaRes = await jsonFetch(`${base}/admin/api/models/ollama`, {
      method: 'POST', headers: jsonHeaders(ownerToken), body: JSON.stringify({ model: 'qwen3:8b', name: 'qwen' }),
    });
    record('1a', 'POST /admin/api/models/ollama(model+name) → 200 ok', addOllamaRes.status === 200 && addOllamaRes.body.ok === true, `status=${addOllamaRes.status} body=${addOllamaRes.text}`);

    const listAfterAdd = await jsonFetch(`${base}/admin/api/models`, { headers: authHeaders(ownerToken) });
    const qwenEntry = (listAfterAdd.body.models as any[] | undefined)?.find((m) => m.key === 'qwen');
    record('1b', 'GET /admin/api/models에 방금 추가한 qwen 모델이 보임(provider=openai-api)', !!qwenEntry && qwenEntry.provider === 'openai-api' && qwenEntry.model === 'qwen3:8b', `body=${listAfterAdd.text}`);

    const setDefaultRes = await jsonFetch(`${base}/admin/api/models/default`, {
      method: 'POST', headers: jsonHeaders(ownerToken), body: JSON.stringify({ key: 'qwen' }),
    });
    record('1c', 'POST /admin/api/models/default(key=qwen) → 200 ok', setDefaultRes.status === 200 && setDefaultRes.body.ok === true, `status=${setDefaultRes.status} body=${setDefaultRes.text}`);

    const listAfterDefault = await jsonFetch(`${base}/admin/api/models`, { headers: authHeaders(ownerToken) });
    const qwenIsDefault = (listAfterDefault.body.models as any[] | undefined)?.find((m) => m.key === 'qwen')?.isDefault === true;
    record('1d', 'GET /admin/api/models: qwen.isDefault=true + default=qwen + harness=engram(provider openai-api도 engram 하네스)',
      qwenIsDefault && listAfterDefault.body.default === 'qwen' && listAfterDefault.body.harness === 'engram',
      `body=${listAfterDefault.text}`);

    // ── ②API 키 비유출(보안 핵심): 저장 후 GET 응답 어디에도 원문이 없어야 함 ────────────
    const SECRET_KEY = 'sk-ant-SECRET-smoke';
    const saveKeyRes = await jsonFetch(`${base}/admin/api/models/api-key`, {
      method: 'POST', headers: jsonHeaders(ownerToken), body: JSON.stringify({ apiKey: SECRET_KEY }),
    });
    record('2a', 'POST /admin/api/models/api-key(apiKey) → 200 ok', saveKeyRes.status === 200 && saveKeyRes.body.ok === true, `status=${saveKeyRes.status} body=${saveKeyRes.text}`);

    const listAfterKey = await jsonFetch(`${base}/admin/api/models`, { headers: authHeaders(ownerToken) });
    const rawContainsSecret = listAfterKey.text.includes(SECRET_KEY);
    const anthropicEntry = (listAfterKey.body.models as any[] | undefined)?.find((m) => m.provider === 'anthropic-api');
    record('2b', '★보안 핵심: GET /admin/api/models 응답 원문(raw text) 어디에도 API 키 원문이 없음',
      !rawContainsSecret, `rawContainsSecret=${rawContainsSecret} (len=${listAfterKey.text.length})`);
    record('2c', 'GET /admin/api/models: anthropic-api 모델이 hasApiKey=true로 보임(원문 대신 boolean)',
      !!anthropicEntry && anthropicEntry.hasApiKey === true, `anthropicEntry=${JSON.stringify(anthropicEntry)}`);

    // ── ③MCP: 추가 → 목록에 보임 → 삭제 → 사라짐. claude 소스 삭제는 403(있으면) ────────
    const addMcpRes = await jsonFetch(`${base}/admin/api/mcp`, {
      method: 'POST', headers: jsonHeaders(ownerToken), body: JSON.stringify({ name: 'smoke-mcp', commandOrUrl: 'npx -y foo' }),
    });
    record('3a', 'POST /admin/api/mcp(name+commandOrUrl) → 200 ok', addMcpRes.status === 200 && addMcpRes.body.ok === true, `status=${addMcpRes.status} body=${addMcpRes.text}`);

    const listMcpAfterAdd = await jsonFetch(`${base}/admin/api/mcp`, { headers: authHeaders(ownerToken) });
    const smokeMcpEntry = (listMcpAfterAdd.body.servers as any[] | undefined)?.find((s) => s.name === 'smoke-mcp');
    // addMcp는 commandOrUrl 전체를 command 필드에 그대로 저장한다(admin-http.ts addMcp:
    // addMcpServer(configDir, name, commandOrUrl, '') — argsLine은 항상 빈 문자열, 별도 분리 없음).
    record('3b', 'GET /admin/api/mcp에 smoke-mcp가 보임(command=commandOrUrl 원문 그대로, args 없음)',
      !!smokeMcpEntry && smokeMcpEntry.command === 'npx -y foo' && smokeMcpEntry.args === undefined,
      `smokeMcpEntry=${JSON.stringify(smokeMcpEntry)}`);

    const deleteMcpRes = await jsonFetch(`${base}/admin/api/mcp/smoke-mcp`, { method: 'DELETE', headers: authHeaders(ownerToken) });
    record('3c', 'DELETE /admin/api/mcp/smoke-mcp → 200 ok', deleteMcpRes.status === 200 && deleteMcpRes.body.ok === true, `status=${deleteMcpRes.status} body=${deleteMcpRes.text}`);

    const listMcpAfterDelete = await jsonFetch(`${base}/admin/api/mcp`, { headers: authHeaders(ownerToken) });
    const stillThere = (listMcpAfterDelete.body.servers as any[] | undefined)?.some((s) => s.name === 'smoke-mcp');
    record('3d', 'GET /admin/api/mcp: smoke-mcp가 더 이상 안 보임', stillThere === false, `body=${listMcpAfterDelete.text}`);

    const claudeSourced = (listMcpAfterDelete.body.servers as any[] | undefined)?.find((s) => s.source === 'claude');
    if (claudeSourced) {
      const deleteClaudeRes = await jsonFetch(`${base}/admin/api/mcp/${encodeURIComponent(claudeSourced.name)}`, { method: 'DELETE', headers: authHeaders(ownerToken) });
      record('3e', `DELETE /admin/api/mcp/${claudeSourced.name}(source=claude, 이 머신 ~/.claude.json 미러) → 403`,
        deleteClaudeRes.status === 403, `status=${deleteClaudeRes.status} body=${deleteClaudeRes.text}`);
    } else {
      record('3e', 'claude 소스 MCP 삭제 403 — 이 머신엔 ~/.claude.json 미러 항목 없음(document-skip)', true, 'skip: no source=claude entries on this machine');
    }

    // ── ④위키: remote 저장 → 조회 ──────────────────────────────────────────────────
    const saveWikiRes = await jsonFetch(`${base}/admin/api/wiki/remote`, {
      method: 'POST', headers: jsonHeaders(ownerToken), body: JSON.stringify({ url: 'git@x:y.git', branch: 'main' }),
    });
    record('4a', 'POST /admin/api/wiki/remote(url+branch) → 200 ok', saveWikiRes.status === 200 && saveWikiRes.body.ok === true, `status=${saveWikiRes.status} body=${saveWikiRes.text}`);

    const getWikiRes = await jsonFetch(`${base}/admin/api/wiki`, { headers: authHeaders(ownerToken) });
    record('4b', 'GET /admin/api/wiki: remote.url/branch가 방금 저장한 값과 일치',
      getWikiRes.body.remote?.url === 'git@x:y.git' && getWikiRes.body.remote?.branch === 'main',
      `body=${getWikiRes.text}`);

    // ── ⑤서버설정 + secret 비유출: 저장 → GET에 secret 없음/hasOidcSecret=true, 부분갱신 시 secret 보존 ──
    const OIDC_SECRET = 'OIDC-SECRET-smoke';
    const saveSettingsRes = await jsonFetch(`${base}/admin/api/server-settings`, {
      method: 'POST', headers: jsonHeaders(ownerToken),
      body: JSON.stringify({ serverName: 'Smoke', oidc: { issuer: 'https://i', clientId: 'cid', clientSecret: OIDC_SECRET }, codingMode: 'off' }),
    });
    record('5a', 'POST /admin/api/server-settings(serverName+oidc+codingMode) → 200 ok', saveSettingsRes.status === 200 && saveSettingsRes.body.ok === true, `status=${saveSettingsRes.status} body=${saveSettingsRes.text}`);

    const getSettings1 = await jsonFetch(`${base}/admin/api/server-settings`, { headers: authHeaders(ownerToken) });
    const rawContainsOidcSecret = getSettings1.text.includes(OIDC_SECRET);
    record('5b', '★보안 핵심: GET /admin/api/server-settings 응답 원문 어디에도 OIDC clientSecret이 없음',
      !rawContainsOidcSecret, `rawContainsOidcSecret=${rawContainsOidcSecret}`);
    record('5c', 'GET /admin/api/server-settings: hasOidcSecret=true, serverName=Smoke, codingMode=off, oidcIssuer=https://i',
      getSettings1.body.hasOidcSecret === true && getSettings1.body.serverName === 'Smoke' && getSettings1.body.codingMode === 'off' && getSettings1.body.oidcIssuer === 'https://i',
      `body=${getSettings1.text}`);

    // 빈 secret으로 부분 갱신 — issuer만 바뀌고 secret은 보존돼야 함(hasOidcSecret 계속 true).
    const savePartialRes = await jsonFetch(`${base}/admin/api/server-settings`, {
      method: 'POST', headers: jsonHeaders(ownerToken), body: JSON.stringify({ oidc: { issuer: 'https://i2', clientId: 'cid2' } }),
    });
    record('5d', 'POST /admin/api/server-settings(oidc 부분갱신, secret 빈값) → 200 ok', savePartialRes.status === 200 && savePartialRes.body.ok === true, `status=${savePartialRes.status} body=${savePartialRes.text}`);

    const getSettings2 = await jsonFetch(`${base}/admin/api/server-settings`, { headers: authHeaders(ownerToken) });
    record('5e', 'GET /admin/api/server-settings: issuer가 i2로 갱신 + clientId=cid2 + hasOidcSecret은 여전히 true(secret 보존)',
      getSettings2.body.oidcIssuer === 'https://i2' && getSettings2.body.oidcClientId === 'cid2' && getSettings2.body.hasOidcSecret === true,
      `body=${getSettings2.text}`);
    const rawContainsOidcSecret2 = getSettings2.text.includes(OIDC_SECRET);
    record('5f', '★보안 핵심(부분갱신 이후에도): GET 응답 원문에 OIDC clientSecret 여전히 없음', !rawContainsOidcSecret2, `rawContainsOidcSecret2=${rawContainsOidcSecret2}`);

    // ── ⑥입력검증: 잘못된 bind/port → 400 ──────────────────────────────────────────
    const badBindRes = await jsonFetch(`${base}/admin/api/server-settings`, {
      method: 'POST', headers: jsonHeaders(ownerToken), body: JSON.stringify({ bind: 'not-an-ip' }),
    });
    record('6a', 'POST /admin/api/server-settings({bind:"not-an-ip"}) → 400', badBindRes.status === 400, `status=${badBindRes.status} body=${badBindRes.text}`);

    const badPortRes = await jsonFetch(`${base}/admin/api/server-settings`, {
      method: 'POST', headers: jsonHeaders(ownerToken), body: JSON.stringify({ port: true }),
    });
    record('6b', 'POST /admin/api/server-settings({port:true}) → 400', badPortRes.status === 400, `status=${badPortRes.status} body=${badPortRes.text}`);

    // ── ⑦preset: 다운로드 헤더 + 내용 ───────────────────────────────────────────────
    const presetRes = await fetch(`${base}/admin/api/preset`, { headers: authHeaders(ownerToken) });
    const presetText = await presetRes.text();
    let presetBody: any = {};
    try { presetBody = JSON.parse(presetText); } catch { /* 검증에서 실패 처리 */ }
    const disposition = presetRes.headers.get('content-disposition') ?? '';
    record('7', 'GET /admin/api/preset → 200 + Content-Disposition attachment filename=preset.json + {name,endpoint}',
      presetRes.status === 200 && /attachment/i.test(disposition) && /filename="?preset\.json"?/i.test(disposition) && typeof presetBody.name === 'string' && typeof presetBody.endpoint === 'string',
      `status=${presetRes.status} disposition=${disposition} body=${presetText}`);

    // ── ⑧게이트: member 토큰 → 403, 무토큰 → 401 ───────────────────────────────────
    const memberToken = await createApprovedMember(host, port, ownerToken, 's3member', cleanup);
    console.log('   [setup] member 승인+로그인 완료, 게이트 검증 진행');

    const memberGetModels = await jsonFetch(`${base}/admin/api/models`, { headers: authHeaders(memberToken) });
    record('8a', 'GET /admin/api/models(member 토큰) → 403', memberGetModels.status === 403, `status=${memberGetModels.status} body=${memberGetModels.text}`);

    const memberPostSettings = await jsonFetch(`${base}/admin/api/server-settings`, {
      method: 'POST', headers: jsonHeaders(memberToken), body: JSON.stringify({ serverName: 'Hacked' }),
    });
    record('8b', 'POST /admin/api/server-settings(member 토큰) → 403', memberPostSettings.status === 403, `status=${memberPostSettings.status} body=${memberPostSettings.text}`);

    const memberGetSettings = await jsonFetch(`${base}/admin/api/server-settings`, { headers: authHeaders(memberToken) });
    record('8c', 'GET /admin/api/server-settings(member 토큰) → 403', memberGetSettings.status === 403, `status=${memberGetSettings.status} body=${memberGetSettings.text}`);

    const noTokenGetModels = await jsonFetch(`${base}/admin/api/models`);
    record('8d', 'GET /admin/api/models(무토큰) → 401', noTokenGetModels.status === 401, `status=${noTokenGetModels.status} body=${noTokenGetModels.text}`);

    const noTokenGetSettings = await jsonFetch(`${base}/admin/api/server-settings`);
    record('8e', 'GET /admin/api/server-settings(무토큰) → 401', noTokenGetSettings.status === 401, `status=${noTokenGetSettings.status} body=${noTokenGetSettings.text}`);

    if (getStderr().trim()) console.log('\n[server stderr(tail, 참고용)]\n' + getStderr().slice(-2000));
  } catch (e) {
    record('admin-apis', '서버 콘솔 S3 admin api 프로브 전체 흐름 예외 없이 완료', false, String(e));
    const err = getStderr();
    if (err.trim()) console.log('\n[server stderr(tail)]\n' + err.slice(-3000));
  }
}

// ── 데스크톱 프로브: ENGRAM_DESKTOP=1 — /admin(및 그 api)이 전부 404(콘솔=서버 에디션 전용) ──
async function probeDesktopBlocked(tmpBase: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  console.log('\n[Probe desktop] ENGRAM_DESKTOP=1 — /admin/api/models 404(콘솔=서버 에디션 전용)');
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
    const r = await fetch(`http://127.0.0.1:${port}/admin/api/models`);
    record('9', 'ENGRAM_DESKTOP=1 부트 → GET /admin/api/models 404(데스크톱 상주 백엔드는 콘솔 api 자체가 안 뜸)', r.status === 404, `status=${r.status}`);
    if (getStderr().trim()) console.log('\n[desktop stderr(tail, 참고용)]\n' + getStderr().slice(-2000));
  } catch (e) {
    record('9', 'ENGRAM_DESKTOP=1 프로브 전체 흐름 예외 없이 완료', false, String(e));
    const err = getStderr();
    if (err.trim()) console.log('\n[desktop stderr(tail)]\n' + err.slice(-3000));
  }
}

async function main(): Promise<void> {
  checkStaleAndBuild();
  ensureConsoleDist();

  const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'engram-smoke-console-s3-'));
  console.log(`[setup] temp base: ${tmpBase}`);
  const cleanup: Array<() => Promise<void>> = [];

  try {
    await probeAdminApis(tmpBase, cleanup);
    await probeDesktopBlocked(tmpBase, cleanup);
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
