import 'reflect-metadata';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { execSync, spawn, ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { WebSocket } from 'ws';
import { serializePage } from '../src/knowledge-core/wiki/page-serializer';
import type { WikiPage } from '../src/knowledge-core/wiki/page.types';

// 실 스모크: 서버 콘솔 S4(플랜 .superpowers/sdd/task-4-brief.md, Task 4).
// 상태·예약·로그·대화보존 admin api를 진짜 node dist/src/main.js 프로세스 + 진짜 http/ws로
// 검증한다. 우리 코드는 전혀 모킹하지 않는다(scripts/smoke-console-s3.ts 관례 그대로 계승 —
// 격리 임시 데이터 디렉터리·타임아웃 있는 대기·'error' 리스너 보유 자식 프로세스·finally 정리).
//
// ★핵심(이 스모크의 존재 이유): 대화 보존 프루닝(retention count=2)이 실제로 채널 jsonl을
// 정리하면서도, 위키/RAG 지식은 절대 건드리지 않는다는 것을 "프루닝 전후 위키 페이지 수·
// 파일 목록·knowledgeBytes가 바이트 단위로 불변"인지 실증한다.
//
// AI 응답 오염 방지: 대화 append를 정말 "3개"로 정확히 맞추기 위해, 테스트 채널을
// respondMode='mention'으로 두고 @Engram 멘션이 없는 평문 3개를 ws send로 흘린다
// (self.adapter.onSend: respondMode==='mention'&& !hasEngramMention → 응답 핸들러 미호출,
// observe 핸들러도 채널정책 기본값 observe:false라 미호출 — 부작용 없이 순수 3줄만 append됨).
// appendMessage 내부에서 pruneChannel이 매 append 직후 동기 호출되므로, 3번째 append의
// ws 'msg' 브로드캐스트를 받은 시점엔 이미 프루닝이 끝나 있다(경합 없음).
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
    'edge/messenger/chat-store.ts',
    'edge/messenger/chat.config.ts',
    'agent-layer/channel-policy.ts',
    'pal/resource-dir.ts',
    'pal/path-resolver.ts',
    'desktop/schedules-file.ts',
    'knowledge-core/wiki/wiki-engine.ts',
    'knowledge-core/wiki/page-serializer.ts',
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

// console/dist가 없으면(또는 index.html 없으면) console:build 실행(정적 서빙 경로 보호 — api만 쓰지만 관성 유지).
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

// owner 계정을 셋업하고 토큰을 반환한다(scripts/smoke-console-s3.ts 관성 재사용).
async function setupOwner(host: string, port: number, dataDir: string): Promise<string> {
  const setupCodePath = path.join(dataDir, 'state', 'setup-code');
  await waitFor(() => fs.existsSync(setupCodePath), 5000, 'state/setup-code 파일 생성');
  const setupCode = fs.readFileSync(setupCodePath, 'utf8').trim();
  const setupRes = await jsonFetch(`http://${host}:${port}/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: setupCode, loginId: 's4owner', password: 's4-owner-pw-1' }),
  });
  if (setupRes.status !== 200 || !setupRes.body.token) {
    throw new Error(`owner 셋업 실패: status=${setupRes.status} body=${setupRes.text}`);
  }
  return setupRes.body.token as string;
}

// 승인된 member 계정 토큰 확보(등록 → owner ws로 승인 → 로그인). scripts/smoke-console-s3.ts 관성.
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

// ── 메인 프로브: 서버 모드 — 보존 프루닝·위키 불변·상태·예약·로그·게이트 전체 ──
async function probeConsoleS4(tmpBase: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  console.log('\n[Probe console-s4] 서버 콘솔 S4 — node dist/src/main.js 실 부트');
  const dataDir = path.join(tmpBase, 'server');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = getFreePortSync();
  const host = '127.0.0.1';
  const base = `http://${host}:${port}`;

  const { proc, getStderr } = spawnServer(dataDir, {
    ENGRAM_CHAT_PORT: String(port),
    ENGRAM_CHAT_BIND: '127.0.0.1',
    // ENGRAM_CHAT_ROLE·ENGRAM_DESKTOP 둘 다 미설정 — 서버 역할 기본값(콘솔+admin api 배선 포함).
  });
  cleanup.push(() => killProc(proc));

  try {
    await waitHealthy(host, port, 60000);
    console.log(`   [setup] 서버 healthy on :${port} (role=server 기본, 0계정)`);

    const ownerToken = await setupOwner(host, port, dataDir);
    console.log('   [setup] owner 셋업 완료, 토큰 확보');

    // ── 위키 페이지 시딩: 프루닝 불변 증거를 의미있게 만들려면 기준선이 0이 아니어야 한다.
    // WikiEngine.createPage와 동일한 직렬화(serializePage)로 실제 페이지 파일 1개를 미리 심는다.
    const wikiPagesDir = path.join(dataDir, 'wiki', 'pages', 'default');
    fs.mkdirSync(wikiPagesDir, { recursive: true });
    const seedPage: WikiPage = {
      slug: 'smoke-s4-retention-invariant',
      frontmatter: {
        title: 'S4 Retention Invariant Seed', category: 'smoke', status: 'published', sources: [],
        created: new Date().toISOString(), updated: new Date().toISOString(),
      },
      body: 'Seed page for the S4 retention-prune wiki-invariance smoke assertion — must survive chat pruning untouched.',
    };
    fs.writeFileSync(path.join(wikiPagesDir, `${seedPage.slug}.md`), serializePage(seedPage));

    // ── ①-a 기준선(프루닝 "이전"): 위키 페이지 수·파일 목록·knowledgeBytes·chatBytes ──
    const overviewBefore = await jsonFetch(`${base}/admin/api/overview`, { headers: authHeaders(ownerToken) });
    const statusBefore = await jsonFetch(`${base}/admin/api/status`, { headers: authHeaders(ownerToken) });
    const wikiFilesBefore = fs.readdirSync(wikiPagesDir).filter((f) => f.endsWith('.md')).sort();
    record('1a', '위키 페이지 시딩 확인: GET /admin/api/overview.wikiPages ≥ 1(프루닝 불변 증거의 기준선, 0이면 무의미한 증명)',
      typeof overviewBefore.body.wikiPages === 'number' && overviewBefore.body.wikiPages >= 1, `body=${overviewBefore.text}`);

    // ── ①-b retention count=2 저장 → GET으로 영속 확인 ──
    const saveRetentionRes = await jsonFetch(`${base}/admin/api/server-settings`, {
      method: 'POST', headers: jsonHeaders(ownerToken), body: JSON.stringify({ retention: { mode: 'count', value: 2 } }),
    });
    record('1b', "POST /admin/api/server-settings(retention:{mode:'count',value:2}) → 200 ok",
      saveRetentionRes.status === 200 && saveRetentionRes.body.ok === true, `status=${saveRetentionRes.status} body=${saveRetentionRes.text}`);

    const getSettingsAfterRetention = await jsonFetch(`${base}/admin/api/server-settings`, { headers: authHeaders(ownerToken) });
    record('1c', 'GET /admin/api/server-settings: retention이 {mode:count,value:2}로 저장 확인',
      getSettingsAfterRetention.body.retention?.mode === 'count' && getSettingsAfterRetention.body.retention?.value === 2,
      `body=${getSettingsAfterRetention.text}`);

    // ── ①-c ws owner 인증 → 채널 생성 → respondMode=mention(비-멘션 append는 AI 무응답) → 3개 append ──
    const ws = await connectWs(host, port, 15000);
    cleanup.push(async () => { try { ws.terminate(); } catch { /* 격리 */ } });
    const authOk = await waitForFrame(ws, (f) => f.t === 'authOk' || f.t === 'authErr', 8000, 'owner ws 인증 응답', { t: 'auth', token: ownerToken });
    record('1d', 'owner ws 인증 성공(authOk)', authOk.t === 'authOk', JSON.stringify(authOk));

    const chFrame = await waitForFrame(ws, (f) => f.t === 'channels' && f.list.some((c: any) => c.name === 'S4Retention'), 10000, 'S4Retention 채널 생성', { t: 'createChannel', name: 'S4Retention' });
    const channelId: string = chFrame.list.find((c: any) => c.name === 'S4Retention').id;
    console.log(`   [setup] retention 테스트 채널=${channelId}`);

    const modeFrame = await waitForFrame(ws, (f) => f.t === 'channels', 10000, 'setRespondMode(mention) ack', { t: 'setRespondMode', id: channelId, mode: 'mention' });
    const chAfterMode = modeFrame.list.find((c: any) => c.id === channelId);
    record('1e', "채널 respondMode=mention 설정 확인(비-멘션 텍스트는 handler 미호출 → append 순수성 확보)",
      chAfterMode?.respondMode === 'mention', JSON.stringify(chAfterMode));

    // 멘션 없는 평문 3개를 순차 append. 각 건의 ws 'msg' 브로드캐스트를 기다려 append를 확정하고
    // 실제 저장된 message 객체를 모아둔다(①-e 대비 증거: 프루닝 안 됐다면 3줄이었을 바이트 수 계산용).
    // (appendMessage 내부에서 pruneChannel이 동기 호출되므로, 3번째 브로드캐스트 수신 시점엔 이미 프루닝 완료).
    const texts = ['retention msg 1', 'retention msg 2', 'retention msg 3'];
    const sentMsgs: any[] = [];
    for (const t of texts) {
      const f = await waitForFrame(ws, (f) => f.t === 'msg' && f.channelId === channelId && f.message?.text === t, 15000, `append '${t}' 확인`, { t: 'send', channelId, text: t });
      sentMsgs.push(f.message);
    }
    record('1f', '채널에 평문 메시지 3개 append 완료(ws send 3회, 매 건 msg 브로드캐스트로 확인 — @Engram 멘션 없어 AI 무응답)', true);

    // ── ①-d jsonl 파일 직접 확인 — 정확히 2줄만 남음(count=2 프루닝 실증) ──
    const jsonlPath = path.join(dataDir, 'state', 'chat', `${channelId}.jsonl`);
    const rawLines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
    record('1g', `채널 jsonl이 정확히 2줄만 남음(retention count=2 프루닝 실증, 경로=${jsonlPath})`, rawLines.length === 2, `lines=${rawLines.length}`);
    const survivingTexts = rawLines.map((l) => { try { return JSON.parse(l).text; } catch { return null; } });
    record('1h', '남은 2줄이 최신 메시지(msg2·msg3) — 가장 오래된 msg1은 프루닝되어 사라짐',
      survivingTexts.length === 2 && survivingTexts[0] === 'retention msg 2' && survivingTexts[1] === 'retention msg 3',
      `survivingTexts=${JSON.stringify(survivingTexts)}`);

    // ── ①-e ★핵심: 위키 불변 — 대화 프루닝이 위키/RAG 지식에 절대 손대지 않음 ──
    const overviewAfter = await jsonFetch(`${base}/admin/api/overview`, { headers: authHeaders(ownerToken) });
    const statusAfter = await jsonFetch(`${base}/admin/api/status`, { headers: authHeaders(ownerToken) });
    const wikiFilesAfter = fs.readdirSync(wikiPagesDir).filter((f) => f.endsWith('.md')).sort();
    record('1i', '★핵심: GET /admin/api/overview.wikiPages 불변(프루닝 전후 동일 — 대화 정리가 위키를 안 건드림)',
      overviewAfter.body.wikiPages === overviewBefore.body.wikiPages, `before=${overviewBefore.body.wikiPages} after=${overviewAfter.body.wikiPages}`);
    record('1j', '★핵심: 위키 페이지 디렉터리 파일 목록 불변(파일셋 자체가 그대로, 시딩한 페이지 포함)',
      JSON.stringify(wikiFilesBefore) === JSON.stringify(wikiFilesAfter), `before=${JSON.stringify(wikiFilesBefore)} after=${JSON.stringify(wikiFilesAfter)}`);
    record('1k', '★핵심: GET /admin/api/status.knowledgeBytes 불변(위키+RAG 디렉터리 총 바이트도 그대로)',
      statusAfter.body.knowledgeBytes === statusBefore.body.knowledgeBytes, `before=${statusBefore.body.knowledgeBytes} after=${statusAfter.body.knowledgeBytes}`);
    // 대비 증거: 프루닝이 없었다면 jsonl은 sentMsgs 3줄 전체(unprunedBytes)만큼 커야 한다 — 실제 프루닝된
    // 파일(actualBytes, 2줄)이 그보다 작다는 것으로 "대화만 실제로 정리됐다"를 확인한다(위키는 위 ①-i~k에서 불변 확인).
    const unprunedBytes = sentMsgs.reduce((acc, m) => acc + Buffer.byteLength(JSON.stringify(m) + '\n', 'utf8'), 0);
    const actualBytes = Buffer.byteLength(fs.readFileSync(jsonlPath, 'utf8'), 'utf8');
    record('1l', '대비 증거: 프루닝된 jsonl 실 바이트 수 < 프루닝 안 됐을 경우의 3줄 바이트 수(대화만 실제로 줄었다는 것을 확인)',
      actualBytes < unprunedBytes, `actualBytes(2줄)=${actualBytes} unprunedBytes(3줄이었다면)=${unprunedBytes}`);

    // ── ②status: uptime·bytes·counts 형식 ──
    record('2a', 'uptimeSec는 숫자이고 > 0', typeof statusAfter.body.uptimeSec === 'number' && statusAfter.body.uptimeSec > 0, `uptimeSec=${statusAfter.body.uptimeSec}`);
    record('2b', 'chatBytes·knowledgeBytes는 숫자 ≥ 0',
      typeof statusAfter.body.chatBytes === 'number' && statusAfter.body.chatBytes >= 0 && typeof statusAfter.body.knowledgeBytes === 'number' && statusAfter.body.knowledgeBytes >= 0,
      `chatBytes=${statusAfter.body.chatBytes} knowledgeBytes=${statusAfter.body.knowledgeBytes}`);
    record('2c', 'memberCount·channelCount는 숫자', typeof statusAfter.body.memberCount === 'number' && typeof statusAfter.body.channelCount === 'number',
      `memberCount=${statusAfter.body.memberCount} channelCount=${statusAfter.body.channelCount}`);
    record('2d', 'lastHeartbeatMs는 숫자 또는 null(상주 heartbeat 미확인 시 null 허용)',
      statusAfter.body.lastHeartbeatMs === null || typeof statusAfter.body.lastHeartbeatMs === 'number', `lastHeartbeatMs=${JSON.stringify(statusAfter.body.lastHeartbeatMs)}`);

    // ── ③schedules: 예약 1건을 configDir/schedules.json에 직접 시딩(서버는 매 요청마다 파일을 새로
    // 읽으므로 부팅 후에 써도 즉시 반영) → GET에 보임 → DELETE 200 → 재조회 사라짐 → 미지 id DELETE 404.
    const configDir = path.join(dataDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const seedSchedule = { id: 'smoke-sched-1', channelId, cron: '0 9 * * *', task: 'daily smoke digest', createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(configDir, 'schedules.json'), JSON.stringify([seedSchedule], null, 2));

    const getSchedulesRes = await jsonFetch(`${base}/admin/api/schedules`, { headers: authHeaders(ownerToken) });
    const scheduleList: any[] = Array.isArray(getSchedulesRes.body.schedules) ? getSchedulesRes.body.schedules : [];
    if (scheduleList.length > 0) {
      record('3a', 'GET /admin/api/schedules에 시딩한 예약이 목록으로 보임', scheduleList.some((s) => s.id === 'smoke-sched-1'), JSON.stringify(scheduleList));

      const delRes = await jsonFetch(`${base}/admin/api/schedules/smoke-sched-1`, { method: 'DELETE', headers: authHeaders(ownerToken) });
      record('3b', 'DELETE /admin/api/schedules/smoke-sched-1 → 200 ok', delRes.status === 200 && delRes.body.ok === true, `status=${delRes.status} body=${delRes.text}`);

      const getAfterDel = await jsonFetch(`${base}/admin/api/schedules`, { headers: authHeaders(ownerToken) });
      const stillThere = (getAfterDel.body.schedules as any[] | undefined)?.some((s) => s.id === 'smoke-sched-1');
      record('3c', '삭제 후 GET 목록에서 사라짐', stillThere === false, `body=${getAfterDel.text}`);

      const delUnknown = await jsonFetch(`${base}/admin/api/schedules/does-not-exist`, { method: 'DELETE', headers: authHeaders(ownerToken) });
      record('3d', 'DELETE /admin/api/schedules/does-not-exist(미지 id) → 404', delUnknown.status === 404, `status=${delUnknown.status} body=${delUnknown.text}`);
    } else {
      console.log('   [skip] 예약 없음 — 목록·삭제 단언 스킵(브리프 허용 경로). 시딩이 반영 안 됐다면 실패로 취급.');
      record('3', '예약 목록이 비어있음(시딩 실패 의심 — 브리프의 SKIP 경로는 진짜 "예약 0개" 서버용, 시딩했는데 안 보이면 버그)', false, `getSchedulesRes.text=${getSchedulesRes.text}`);
    }

    // ── ④logs: 최근 줄 배열 + ?lines= 상한 동작 ──
    const getLogsRes = await jsonFetch(`${base}/admin/api/logs`, { headers: authHeaders(ownerToken) });
    const logLines: any = getLogsRes.body.lines;
    record('4a', 'GET /admin/api/logs → 200 + {lines: string[]}(배열, 원소 전부 문자열)',
      getLogsRes.status === 200 && Array.isArray(logLines) && logLines.every((l: unknown) => typeof l === 'string'),
      `status=${getLogsRes.status} isArray=${Array.isArray(logLines)} len=${Array.isArray(logLines) ? logLines.length : 'n/a'}`);
    record('4b', '로그가 최소 1줄 이상(부팅 과정에서 pino가 최소 1회 기록 — 완전 무동작이면 로그 배선 회귀 의심)',
      Array.isArray(logLines) && logLines.length > 0, `len=${Array.isArray(logLines) ? logLines.length : 'n/a'}`);

    const getLogsLimited = await jsonFetch(`${base}/admin/api/logs?lines=1`, { headers: authHeaders(ownerToken) });
    record('4c', 'GET /admin/api/logs?lines=1 → 최근 줄이 1줄 이하로 제한됨',
      getLogsLimited.status === 200 && Array.isArray(getLogsLimited.body.lines) && getLogsLimited.body.lines.length <= 1,
      `body=${getLogsLimited.text}`);

    // ── ⑤게이트: 무토큰 401, 비owner 403(status·schedules·logs·server-settings 저장) ──
    const memberToken = await createApprovedMember(host, port, ownerToken, 's4member', cleanup);
    console.log('   [setup] member 승인+로그인 완료, 게이트 검증 진행');

    const noTokenStatus = await jsonFetch(`${base}/admin/api/status`);
    record('5a', 'GET /admin/api/status(무토큰) → 401', noTokenStatus.status === 401, `status=${noTokenStatus.status} body=${noTokenStatus.text}`);
    const noTokenSchedules = await jsonFetch(`${base}/admin/api/schedules`);
    record('5b', 'GET /admin/api/schedules(무토큰) → 401', noTokenSchedules.status === 401, `status=${noTokenSchedules.status} body=${noTokenSchedules.text}`);
    const noTokenLogs = await jsonFetch(`${base}/admin/api/logs`);
    record('5c', 'GET /admin/api/logs(무토큰) → 401', noTokenLogs.status === 401, `status=${noTokenLogs.status} body=${noTokenLogs.text}`);

    const memberStatus = await jsonFetch(`${base}/admin/api/status`, { headers: authHeaders(memberToken) });
    record('5d', 'GET /admin/api/status(member 토큰) → 403', memberStatus.status === 403, `status=${memberStatus.status} body=${memberStatus.text}`);
    const memberSchedules = await jsonFetch(`${base}/admin/api/schedules`, { headers: authHeaders(memberToken) });
    record('5e', 'GET /admin/api/schedules(member 토큰) → 403', memberSchedules.status === 403, `status=${memberSchedules.status} body=${memberSchedules.text}`);
    const memberLogs = await jsonFetch(`${base}/admin/api/logs`, { headers: authHeaders(memberToken) });
    record('5f', 'GET /admin/api/logs(member 토큰) → 403', memberLogs.status === 403, `status=${memberLogs.status} body=${memberLogs.text}`);
    const memberSaveRetention = await jsonFetch(`${base}/admin/api/server-settings`, {
      method: 'POST', headers: jsonHeaders(memberToken), body: JSON.stringify({ retention: { mode: 'unlimited' } }),
    });
    record('5g', 'POST /admin/api/server-settings(retention, member 토큰) → 403(보존 정책도 owner 전용)',
      memberSaveRetention.status === 403, `status=${memberSaveRetention.status} body=${memberSaveRetention.text}`);

    if (getStderr().trim()) console.log('\n[server stderr(tail, 참고용)]\n' + getStderr().slice(-2000));
  } catch (e) {
    record('console-s4', '서버 콘솔 S4 프로브 전체 흐름 예외 없이 완료', false, String(e));
    const err = getStderr();
    if (err.trim()) console.log('\n[server stderr(tail)]\n' + err.slice(-3000));
  }
}

// ── 데스크톱 프로브: ENGRAM_DESKTOP=1 — /admin/api/status가 404(콘솔=서버 에디션 전용, 이중가드) ──
async function probeDesktopBlocked(tmpBase: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  console.log('\n[Probe desktop] ENGRAM_DESKTOP=1 — /admin/api/status 404(콘솔=서버 에디션 전용)');
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
    const r = await fetch(`http://127.0.0.1:${port}/admin/api/status`);
    record('6', 'ENGRAM_DESKTOP=1 부트 → GET /admin/api/status 404(데스크톱 상주 백엔드는 콘솔 api 자체가 안 뜸 — 이중가드)',
      r.status === 404, `status=${r.status}`);
    if (getStderr().trim()) console.log('\n[desktop stderr(tail, 참고용)]\n' + getStderr().slice(-2000));
  } catch (e) {
    record('6', 'ENGRAM_DESKTOP=1 프로브 전체 흐름 예외 없이 완료', false, String(e));
    const err = getStderr();
    if (err.trim()) console.log('\n[desktop stderr(tail)]\n' + err.slice(-3000));
  }
}

async function main(): Promise<void> {
  checkStaleAndBuild();
  ensureConsoleDist();

  const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'engram-smoke-console-s4-'));
  console.log(`[setup] temp base: ${tmpBase}`);
  const cleanup: Array<() => Promise<void>> = [];

  try {
    await probeConsoleS4(tmpBase, cleanup);
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
