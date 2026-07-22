import 'reflect-metadata';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as http from 'http';
import { execSync, spawn, ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { WebSocket } from 'ws';
import { serializePage } from '../src/knowledge-core/wiki/page-serializer';
import type { WikiPage } from '../src/knowledge-core/wiki/page.types';
import { slugifyMcpTitle } from '../src/edge/mcp/mcp-propose';

// 실 스모크: /clear·/compact + 자동 compact(플랜 docs/superpowers/plans/2026-07-22-clear-compact.md,
// Task 8 — brief .superpowers/sdd/task-8-brief.md). 진짜 node dist/src/main.js 서버 프로세스 +
// 진짜 ws 클라이언트 + 진짜(격리) HTTP 두뇌 목(scripts/smoke-channel-brain.ts 패턴 재사용)로 검증한다.
// 우리 코드는 전혀 모킹하지 않는다 — 유일한 모킹은 openai-api 하네스가 말 거는 상대(외부 LLM API)뿐.
// 하네스는 scripts/smoke-console-s4.ts(서버 부팅·owner 셋업·위키 불변 진단)와
// scripts/smoke-channel-brain.ts(목 두뇌 http·ws 라우팅)의 헬퍼를 그대로 재사용한다(신규 하네스 발명 금지).
//
// ★핵심 발견(스파이크로 실증 후 반영, 아래 ③a 섹션 주석 참조): auto-compact의 사후 안내 메시지
// (main.ts postToChannel)가 그 자체로 appendMessage→pruneChannel을 재유발해, 정확히 "보존 개수"줄로
// 안착하지 않고 "kept + 안내 1줄"로 안착할 수 있다(디바운스가 그 라운드의 정밀 재프루닝을 건너뛰고,
// 후속 append가 없으면 재시도되지 않음 — chat-store.ts의 기존 설계 주석대로). 그래서 ③a는 "정확히 N줄"이
// 아니라 "가장 오래된 원본 텍스트가 사라짐 + 위키 안내 앵커가 나타남 + 위키 불변"으로 실측 기반 단언한다.
//
// 격리: ENGRAM_DATA_DIR는 항상 임시 디렉터리 — 절대 %APPDATA%\engram나 실사용자 데이터를 건드리지 않는다.

const REPO_ROOT = path.resolve(__dirname, '..');

type ServerProc = ChildProcessByStdio<null, Readable, Readable>;

interface Result { id: string; desc: string; pass: boolean; detail?: string }
const results: Result[] = [];
function record(id: string, desc: string, pass: boolean, detail?: string): void {
  results.push({ id, desc, pass, detail });
  console.log(`   ${pass ? '✓' : '✗ FAIL'} (${id}) ${desc}${detail ? ' — ' + detail.slice(0, 400) : ''}`);
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

// ── dist 신선도: 이 기능이 만지는 소스 목록을 대응 dist .js와 mtime 비교(scripts/smoke-console-s4.ts 관례). ──
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
    'edge/proposal-applier.ts',
    'edge/mcp/mcp-propose.ts',
    'agent-layer/compact.ts',
    'agent-layer/orchestrator.ts',
    'agent-layer/channel-brain-resolver.ts',
    'agent-layer/channel-policy.ts',
    'brain/openai-api.brain.ts',
    'pal/resource-dir.ts',
    'pal/path-resolver.ts',
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

function getFreePortSync(): number {
  return 45000 + Math.floor(Math.random() * 15000);
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

// owner 계정을 셋업하고 토큰을 반환한다(scripts/smoke-console-s4.ts 관성 재사용).
async function setupOwner(host: string, port: number, dataDir: string, loginId: string): Promise<string> {
  const setupCodePath = path.join(dataDir, 'state', 'setup-code');
  await waitFor(() => fs.existsSync(setupCodePath), 5000, 'state/setup-code 파일 생성');
  const setupCode = fs.readFileSync(setupCodePath, 'utf8').trim();
  const setupRes = await jsonFetch(`http://${host}:${port}/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: setupCode, loginId, password: `${loginId}-pw-1` }),
  });
  if (setupRes.status !== 200 || !setupRes.body.token) {
    throw new Error(`owner 셋업 실패: status=${setupRes.status} body=${setupRes.text}`);
  }
  return setupRes.body.token as string;
}

// 승인된 member 계정 토큰 확보(등록 → owner ws로 승인 → 로그인). scripts/smoke-console-s4.ts 관성.
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

// ── 목 두뇌 http(scripts/smoke-channel-brain.ts의 createMockBrainServer를 그대로 재사용). openai-api
// 하네스가 말 거는 OpenAI 호환 chat/completions를 SSE로 흉내낸다. 큐가 비어있으면 고정 텍스트 폴백. ──
type ScriptedResponse = { type: 'content'; text: string };
interface MockRequest { n: number; body: { messages?: Array<{ role: string; content?: string | null }> } }
const MOCKBRAIN_FALLBACK = 'MOCKBRAIN-SAYS';

function createMockBrainServer(): { server: http.Server; port: number; requestLog: MockRequest[]; queue: ScriptedResponse[] } {
  const requestLog: MockRequest[] = [];
  const queue: ScriptedResponse[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('error', () => { try { res.destroy(); } catch { /* 격리 */ } });
    req.on('end', () => {
      let body: MockRequest['body'] = {};
      try { body = JSON.parse(raw); } catch { /* 손상 요청은 빈 바디로 기록 */ }
      requestLog.push({ n: requestLog.length + 1, body });
      const item = queue.shift();
      const payload = { choices: [{ delta: { content: item ? item.text : MOCKBRAIN_FALLBACK } }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  server.on('error', (err) => console.error('[mock] server error', err));
  return { server, port: 0, requestLog, queue };
}

// ── 위키 페이지 스냅샷/불변 비교 헬퍼(scripts/smoke-console-s4.ts의 "파일 목록·내용 불변" 관례를
// slug 단위로 일반화 — compact/auto-compact는 매번 정확히 1개 새 페이지만 추가해야 하고, 그 외 기존
// 페이지는 파일명·바이트 내용 모두 그대로여야 한다(지식 무관 실증). ──
function snapshotWikiFiles(wikiPagesDir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(wikiPagesDir)) return out;
  for (const f of fs.readdirSync(wikiPagesDir)) {
    if (!f.endsWith('.md')) continue;
    out.set(f, fs.readFileSync(path.join(wikiPagesDir, f), 'utf8'));
  }
  return out;
}

function assertWikiInvariant(
  id: string, desc: string, before: Map<string, string>, after: Map<string, string>, expectedNewFiles: string[],
): void {
  const expectedKeys = new Set([...before.keys(), ...expectedNewFiles]);
  const actualKeys = new Set(after.keys());
  const sameKeySet = expectedKeys.size === actualKeys.size && [...expectedKeys].every((k) => actualKeys.has(k));
  let unchanged = true;
  const changedFiles: string[] = [];
  for (const [k, v] of before) {
    if (after.get(k) !== v) { unchanged = false; changedFiles.push(k); }
  }
  record(id, desc, sameKeySet && unchanged,
    `beforeKeys=${JSON.stringify([...before.keys()])} afterKeys=${JSON.stringify([...actualKeys])} expectedNew=${JSON.stringify(expectedNewFiles)} changedExisting=${JSON.stringify(changedFiles)}`);
}

function readJsonlLines(jsonlPath: string): any[] {
  if (!fs.existsSync(jsonlPath)) return [];
  return fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// Boot A: /clear+undo(①) · /compact(②) · 권한 게이트(④) · auto-compact ON(③a) — mockbrain 필요.
// retention은 처음 unlimited(①②④에 영향 없게)로 두다가, ③a 직전 admin api로 count:2 런타임 전환한다
// (admin-http.ts:888 this.deps.chat.setRetention — 재시작 없이 즉시 반영. autoCompact 훅 설치 자체는
// 부팅 시점 1회 결정이라 재부팅 불필요 — chatCfg.autoCompact가 false가 아니면 기본 true로 훅이 걸린다).
// ══════════════════════════════════════════════════════════════════════════════════════════
async function probeBootA(tmpBase: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  console.log('\n[Probe A] /clear+undo · /compact(위키 저장) · 권한 게이트 · auto-compact ON');
  const dataDir = path.join(tmpBase, 'boot-a');
  fs.mkdirSync(dataDir, { recursive: true });
  const configDir = path.join(dataDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const port = getFreePortSync();
  const host = '127.0.0.1';
  const base = `http://${host}:${port}`;

  // ── 목 두뇌 http(mockbrain) — 채널이 명시적으로 이 이름을 지정할 때만 쓰인다. ──
  const mock = createMockBrainServer();
  await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', () => resolve()));
  const mockAddr = mock.server.address();
  const mockPort = typeof mockAddr === 'object' && mockAddr ? mockAddr.port : 0;
  cleanup.push(() => new Promise<void>((r) => mock.server.close(() => r())));
  console.log(`   [setup] mockbrain http on 127.0.0.1:${mockPort}`);

  fs.writeFileSync(path.join(configDir, 'brains.json'), JSON.stringify({
    default: 'default',
    brains: {
      default: { provider: 'claude-cli', cli: 'engram-smoke-cc-nonexistent-cli-xyz', model: '', concurrency: 1, timeoutMs: 5000 },
      mockbrain: { provider: 'openai-api', baseUrl: `http://127.0.0.1:${mockPort}`, model: 'mock-model', concurrency: 1, timeoutMs: 30000, apiKey: 'test-key' },
    },
  }, null, 2));
  // 부팅 시 retention 미설정(unlimited 기본) — autoCompact는 명시 안 함(chatCfg.autoCompact undefined
  // !== false → 훅은 설치되지만 unlimited 정책에선 pruneChannel이 애초에 발동 안 함, 회귀 0).
  fs.writeFileSync(path.join(configDir, 'chat.json'), JSON.stringify({ enabled: true, role: 'server' }, null, 2));

  const { proc, getStderr } = spawnServer(dataDir, { ENGRAM_CHAT_PORT: String(port), ENGRAM_CHAT_BIND: '127.0.0.1' });
  cleanup.push(() => killProc(proc));

  try {
    await waitHealthy(host, port, 60000);
    console.log(`   [setup] 서버 healthy on :${port}`);

    const ownerToken = await setupOwner(host, port, dataDir, 'cca-owner');
    console.log('   [setup] owner 셋업 완료');

    // ── 위키 불변 증거의 기준선: 시딩 페이지 1개(console-s4와 동일 관례 — 0이면 무의미한 증명). ──
    const wikiPagesDir = path.join(dataDir, 'wiki', 'pages', 'default');
    fs.mkdirSync(wikiPagesDir, { recursive: true });
    const seedPage: WikiPage = {
      slug: 'smoke-clear-compact-baseline-a',
      frontmatter: { title: 'Clear-Compact Smoke Baseline A', category: 'smoke', status: 'published', sources: [], created: new Date().toISOString(), updated: new Date().toISOString() },
      body: 'Baseline page for Boot A — must survive /clear, /compact, and auto-compact untouched (byte-identical).',
    };
    fs.writeFileSync(path.join(wikiPagesDir, `${seedPage.slug}.md`), serializePage(seedPage));
    let wikiSnapshot = snapshotWikiFiles(wikiPagesDir);
    record('a0', '위키 기준선 시딩 확인(≥1 페이지, 불변 증명의 출발점)', wikiSnapshot.size === 1, `files=${JSON.stringify([...wikiSnapshot.keys()])}`);

    const ownerWs = await connectWs(host, port, 15000);
    cleanup.push(async () => { try { ownerWs.terminate(); } catch { /* 격리 */ } });
    const authOk = await waitForFrame(ownerWs, (f) => f.t === 'authOk' || f.t === 'authErr', 8000, 'owner ws 인증', { t: 'auth', token: ownerToken });
    record('a1', 'owner ws 인증 성공(authOk)', authOk.t === 'authOk', JSON.stringify(authOk));

    // ══════════════════ ① /clear + undo ══════════════════
    const chFrame = await waitForFrame(ownerWs, (f) => f.t === 'channels' && f.list.some((c: any) => c.name === 'ClearTest'), 10000, 'ClearTest 채널 생성', { t: 'createChannel', name: 'ClearTest' });
    const clearChId: string = chFrame.list.find((c: any) => c.name === 'ClearTest').id;
    await waitForFrame(ownerWs, (f) => f.t === 'channels', 10000, 'setRespondMode(mention)', { t: 'setRespondMode', id: clearChId, mode: 'mention' });
    const clearJsonl = path.join(dataDir, 'state', 'chat', `${clearChId}.jsonl`);
    const clearBackup = `${clearJsonl}.cleared`;

    for (const text of ['clear-src-msg-1', 'clear-src-msg-2', 'clear-src-msg-3']) {
      await waitForFrame(ownerWs, (f) => f.t === 'msg' && f.channelId === clearChId && f.message?.text === text, 15000, `append '${text}'`, { t: 'send', channelId: clearChId, text });
    }
    record('c1', '① 채널에 메시지 3개 append 완료(jsonl 3줄)', readJsonlLines(clearJsonl).length === 3, `lines=${readJsonlLines(clearJsonl).length}`);

    const clearedFrame = await waitForFrame(ownerWs, (f) => f.t === 'historyCleared' && f.channelId === clearChId, 10000, 'historyCleared', { t: 'clearHistory', id: clearChId });
    record('c2', "① clearHistory → {t:'historyCleared'} 브로드캐스트 수신", clearedFrame.t === 'historyCleared', JSON.stringify(clearedFrame));
    record('c3', '① clear 후 jsonl 없음(history 빈 것)', !fs.existsSync(clearJsonl), `exists=${fs.existsSync(clearJsonl)}`);
    record('c4', "① clear 후 `.cleared` 백업 파일 존재", fs.existsSync(clearBackup), `path=${clearBackup}`);

    const restoredFrame = await waitForFrame(ownerWs, (f) => f.t === 'historyRestored' && f.channelId === clearChId, 10000, 'historyRestored', { t: 'undoClear', id: clearChId });
    record('c5', "① undoClear → {t:'historyRestored'} 브로드캐스트 수신", restoredFrame.t === 'historyRestored', JSON.stringify(restoredFrame));
    const restoredTexts = readJsonlLines(clearJsonl).map((m) => m.text);
    record('c6', '① undo 후 메시지 3개 원복(순서·내용 동일)', JSON.stringify(restoredTexts) === JSON.stringify(['clear-src-msg-1', 'clear-src-msg-2', 'clear-src-msg-3']), `texts=${JSON.stringify(restoredTexts)}`);
    record('c7', '① undo 후 백업 파일 소멸(rename 복원)', !fs.existsSync(clearBackup), `exists=${fs.existsSync(clearBackup)}`);

    await waitForFrame(ownerWs, (f) => f.t === 'historyCleared' && f.channelId === clearChId, 10000, '재-clearHistory', { t: 'clearHistory', id: clearChId });
    record('c8', '① 재-clear 후 백업 존재', fs.existsSync(clearBackup), `exists=${fs.existsSync(clearBackup)}`);

    // dropClearBackup은 응답 프레임이 없다 — 뒤이은 무해한 channels 왕복으로 처리 완료를 확인(self.adapter.spec.ts 관례).
    ownerWs.send(JSON.stringify({ t: 'dropClearBackup', id: clearChId }));
    await waitForFrame(ownerWs, (f) => f.t === 'channels', 10000, 'dropClearBackup 후 channels 왕복', { t: 'channels' });
    record('c9', '① dropClearBackup 후 백업 파일 소멸', !fs.existsSync(clearBackup), `exists=${fs.existsSync(clearBackup)}`);

    // 백업이 없으니 undoClear는 무동작(historyRestored 없음) — channels 왕복으로 처리는 확인, jsonl은 여전히 없음.
    ownerWs.send(JSON.stringify({ t: 'undoClear', id: clearChId }));
    await waitForFrame(ownerWs, (f) => f.t === 'channels', 10000, 'undoClear(백업없음) 후 channels 왕복', { t: 'channels' });
    record('c10', '① 백업 소멸 후 undoClear는 복원 없음(jsonl 여전히 없음)', !fs.existsSync(clearJsonl), `exists=${fs.existsSync(clearJsonl)}`);

    const wikiAfterClear = snapshotWikiFiles(wikiPagesDir);
    assertWikiInvariant('c11', '① /clear+undo 전 과정 동안 위키 완전 불변(대화 jsonl만 건드림)', wikiSnapshot, wikiAfterClear, []);
    wikiSnapshot = wikiAfterClear;

    // ══════════════════ ② /compact(위키 저장 + 위키 불변) ══════════════════
    const chFrame2 = await waitForFrame(ownerWs, (f) => f.t === 'channels' && f.list.some((c: any) => c.name === 'CompactTest'), 10000, 'CompactTest 채널 생성', { t: 'createChannel', name: 'CompactTest' });
    const compactChId: string = chFrame2.list.find((c: any) => c.name === 'CompactTest').id;
    await waitForFrame(ownerWs, (f) => f.t === 'channels', 10000, 'setRespondMode(mention)', { t: 'setRespondMode', id: compactChId, mode: 'mention' });
    const brainSetFrame = await waitForFrame(ownerWs, (f) => f.t === 'channels', 10000, 'setChannelBrain(mockbrain)', { t: 'setChannelBrain', id: compactChId, brain: 'mockbrain' });
    record('m1', '② 채널 브레인 = mockbrain 설정 확인', brainSetFrame.list.find((c: any) => c.id === compactChId)?.brain === 'mockbrain', JSON.stringify(brainSetFrame.list.find((c: any) => c.id === compactChId)));

    const compactJsonl = path.join(dataDir, 'state', 'chat', `${compactChId}.jsonl`);
    for (const text of ['compact-src-msg-1', 'compact-src-msg-2', 'compact-src-msg-3']) {
      await waitForFrame(ownerWs, (f) => f.t === 'msg' && f.channelId === compactChId && f.message?.text === text, 15000, `append '${text}'`, { t: 'send', channelId: compactChId, text });
    }
    record('m2', '② 채널에 메시지 3개 append 완료', readJsonlLines(compactJsonl).length === 3, `lines=${readJsonlLines(compactJsonl).length}`);

    const COMPACT_TITLE = 'Compact Smoke Alpha';
    const compactSummaryBody = `${COMPACT_TITLE}\n\n- Decided to adopt clear and compact commands\n- Learned the wiki save flow actually works`;
    mock.queue.push({ type: 'content', text: compactSummaryBody });
    const expectedSlug = slugifyMcpTitle(COMPACT_TITLE);

    const reqBeforeCompact = mock.requestLog.length;
    const wikiBeforeCompact = snapshotWikiFiles(wikiPagesDir);
    // 첫 위키 게시=RAG 임베더 콜드스타트 포함 가능(scripts/smoke-channel-brain.ts 관례 — 120s 상한).
    const compactedFrame = await waitForFrame(ownerWs, (f) => f.t === 'compacted' && f.channelId === compactChId, 120000, "compacted 프레임(브레인 요약+위키게시, 콜드스타트 포함 120s 상한)", { t: 'compact', id: compactChId });
    record('m3', "② compact → {t:'compacted', slug} 수신", compactedFrame.t === 'compacted' && typeof compactedFrame.slug === 'string', JSON.stringify(compactedFrame));
    record('m4', '② 반환된 slug가 제목 슬러그화 규칙과 일치', compactedFrame.slug === expectedSlug, `slug=${compactedFrame.slug} expected=${expectedSlug}`);
    record('m5', '② mockbrain http가 실제로 요청 1건을 받음(진짜 브레인 왕복)', mock.requestLog.length === reqBeforeCompact + 1, `before=${reqBeforeCompact} after=${mock.requestLog.length}`);

    const compactedPagePath = path.join(wikiPagesDir, `${compactedFrame.slug}.md`);
    const compactedPageRaw = fs.existsSync(compactedPagePath) ? fs.readFileSync(compactedPagePath, 'utf8') : '';
    record('m6', '★핵심: 위키에 요약 페이지가 실제로 생성됨(파일 존재)', fs.existsSync(compactedPagePath), `path=${compactedPagePath}`);
    record('m7', '★핵심: 페이지 본문에 요약 내용이 실림(브레인이 반환한 텍스트 그대로)', compactedPageRaw.includes('Decided to adopt clear and compact commands') && compactedPageRaw.includes('Learned the wiki save flow actually works'), compactedPageRaw.slice(0, 300));
    record('m8', '★핵심: 페이지 본문에 대화 원문은 없음(요약만 게시 — 원문 유출 아님)', !compactedPageRaw.includes('compact-src-msg-1') && !compactedPageRaw.includes('compact-src-msg-2') && !compactedPageRaw.includes('compact-src-msg-3'), compactedPageRaw.slice(0, 300));
    record('m9', "② 프론트매터 category='compact-summary'(수동 compact — auto 아님)", /category:\s*compact-summary/.test(compactedPageRaw), compactedPageRaw.slice(0, 200));

    const compactAnchorLines = readJsonlLines(compactJsonl);
    record('m10', '② compact 후 채널은 요약 앵커 메시지 1줄만 남음(원본 3줄은 clear됨)', compactAnchorLines.length === 1, `lines=${JSON.stringify(compactAnchorLines.map((m) => m.text))}`);
    record('m11', '② 앵커 메시지가 요약 본문 + 위키 slug 참조를 담음', typeof compactAnchorLines[0]?.text === 'string' && compactAnchorLines[0].text.includes(compactedFrame.slug) && compactAnchorLines[0].text.includes('Decided to adopt'), JSON.stringify(compactAnchorLines[0]));

    const wikiAfterCompact = snapshotWikiFiles(wikiPagesDir);
    assertWikiInvariant('m12', '★핵심: /compact은 새 요약 페이지 1개만 추가하고 기존 위키 페이지는 바이트 단위로 불변', wikiBeforeCompact, wikiAfterCompact, [`${compactedFrame.slug}.md`]);
    wikiSnapshot = wikiAfterCompact;

    // ══════════════════ ④ 권한 게이트: 비공개 채널의 비주인 소켓은 clearHistory/compact 무동작 ══════════════════
    const gateFrame = await waitForFrame(ownerWs, (f) => f.t === 'channels' && f.list.some((c: any) => c.name === 'GateTest'), 10000, 'GateTest(private) 채널 생성', { t: 'createChannel', name: 'GateTest', visibility: 'private' });
    const gateChId: string = gateFrame.list.find((c: any) => c.name === 'GateTest').id;
    const gateJsonl = path.join(dataDir, 'state', 'chat', `${gateChId}.jsonl`);
    await waitForFrame(ownerWs, (f) => f.t === 'msg' && f.channelId === gateChId && f.message?.text === 'gate-owner-msg', 15000, 'gate 채널에 owner 메시지 1개', { t: 'send', channelId: gateChId, text: 'gate-owner-msg' });
    record('g1', '④ 비공개 채널 생성 + owner 메시지 1개 확인', readJsonlLines(gateJsonl).length === 1, `lines=${readJsonlLines(gateJsonl).length}`);

    const intruderToken = await createApprovedMember(host, port, ownerToken, 'cca-intruder', cleanup);
    const intruderWs = await connectWs(host, port, 15000);
    cleanup.push(async () => { try { intruderWs.terminate(); } catch { /* 격리 */ } });
    const intruderAuth = await waitForFrame(intruderWs, (f) => f.t === 'authOk' || f.t === 'authErr', 8000, 'intruder ws 인증', { t: 'auth', token: intruderToken });
    record('g2', '④ intruder(승인된 일반 멤버, 채널 주인 아님) ws 인증 성공', intruderAuth.t === 'authOk', JSON.stringify(intruderAuth));

    intruderWs.send(JSON.stringify({ t: 'clearHistory', id: gateChId }));
    intruderWs.send(JSON.stringify({ t: 'compact', id: gateChId }));
    await waitForFrame(intruderWs, (f) => f.t === 'channels', 10000, 'intruder 시도 후 channels 왕복(처리 순서 확인)', { t: 'channels' });
    record('g3', '④ intruder의 clearHistory 시도 후에도 백업 없음(무동작)', !fs.existsSync(`${gateJsonl}.cleared`), `exists=${fs.existsSync(`${gateJsonl}.cleared`)}`);
    record('g4', '④ intruder의 clearHistory/compact 시도 후에도 jsonl 1줄 그대로(무동작)', readJsonlLines(gateJsonl).length === 1 && readJsonlLines(gateJsonl)[0]?.text === 'gate-owner-msg', `lines=${JSON.stringify(readJsonlLines(gateJsonl))}`);
    const wikiAfterGate = snapshotWikiFiles(wikiPagesDir);
    assertWikiInvariant('g5', '④ 게이트 시도가 위키에도 전혀 영향 없음(무단 compact가 요약·게시를 못 함)', wikiSnapshot, wikiAfterGate, []);
    wikiSnapshot = wikiAfterGate;

    // ══════════════════ ③a auto-compact ON(런타임 retention count:2 전환) ══════════════════
    const saveRetentionRes = await jsonFetch(`${base}/admin/api/server-settings`, {
      method: 'POST', headers: jsonHeaders(ownerToken), body: JSON.stringify({ retention: { mode: 'count', value: 2 } }),
    });
    record('u1', '③a retention count:2 런타임 저장(admin api, 재시작 없이 즉시 반영)', saveRetentionRes.status === 200 && saveRetentionRes.body.ok === true, `status=${saveRetentionRes.status} body=${saveRetentionRes.text}`);

    const autoChFrame = await waitForFrame(ownerWs, (f) => f.t === 'channels' && f.list.some((c: any) => c.name === 'AutoOnTest'), 10000, 'AutoOnTest 채널 생성', { t: 'createChannel', name: 'AutoOnTest' });
    const autoChId: string = autoChFrame.list.find((c: any) => c.name === 'AutoOnTest').id;
    await waitForFrame(ownerWs, (f) => f.t === 'channels', 10000, 'setRespondMode(mention)', { t: 'setRespondMode', id: autoChId, mode: 'mention' });
    await waitForFrame(ownerWs, (f) => f.t === 'channels', 10000, 'setChannelBrain(mockbrain)', { t: 'setChannelBrain', id: autoChId, brain: 'mockbrain' });

    const AUTO_TITLE = 'Auto Compact Smoke Beta';
    const autoSummaryBody = `${AUTO_TITLE}\n\n- Retention pruned the oldest message automatically\n- Summary published to the wiki without a manual command`;
    mock.queue.push({ type: 'content', text: autoSummaryBody });
    const expectedAutoSlug = slugifyMcpTitle(AUTO_TITLE);
    const autoPagePath = path.join(wikiPagesDir, `${expectedAutoSlug}.md`);
    const wikiBeforeAuto = snapshotWikiFiles(wikiPagesDir);

    const autoJsonl = path.join(dataDir, 'state', 'chat', `${autoChId}.jsonl`);
    for (const text of ['auto-src-msg-1', 'auto-src-msg-2', 'auto-src-msg-3']) {
      await waitForFrame(ownerWs, (f) => f.t === 'msg' && f.channelId === autoChId && f.message?.text === text, 15000, `append '${text}'`, { t: 'send', channelId: autoChId, text });
    }
    record('u2', '③a 채널에 메시지 3개 append 완료(프루닝 전 원시 3줄)', readJsonlLines(autoJsonl).length === 3, `lines=${readJsonlLines(autoJsonl).length}`);

    // 자동 compact는 chat-store 프루닝 훅에서 fire-and-forget으로 진행된다(ws 응답 프레임 없음) — 위키 페이지
    // 파일 등장을 직접 폴링해 기다린다(첫 위키 게시 콜드스타트 포함 최대 90s, scripts/smoke-channel-brain.ts 관례).
    await waitFor(() => fs.existsSync(autoPagePath), 90000, '자동 compact 위키 페이지 등장');
    await sleep(3000); // 안내 메시지 postToChannel(추가 appendMessage→pruneChannel 재유발) 정착 대기.

    record('u3', '★핵심: auto-compact가 위키 페이지를 실제로 생성함(수동 명령 없이)', fs.existsSync(autoPagePath), `path=${autoPagePath}`);
    const autoPageRaw = fs.readFileSync(autoPagePath, 'utf8');
    record('u4', '③a 페이지 본문에 요약 내용이 실림', autoPageRaw.includes('Retention pruned the oldest message automatically'), autoPageRaw.slice(0, 300));
    record('u5', "③a 프론트매터 category='auto-compact'(자동 경로 — 수동 compact와 구분)", /category:\s*auto-compact/.test(autoPageRaw), autoPageRaw.slice(0, 200));

    const autoFinalLines = readJsonlLines(autoJsonl);
    const autoFinalTexts = autoFinalLines.map((m) => m.text as string);
    // ★위 스크립트 상단 주석 참조: 안내 메시지 자체가 재프루닝을 유발해 "정확히 2줄"이 아니라 "kept+안내"로
    // 안착할 수 있음이 스파이크로 실증됨 — 그래서 "가장 오래된 원본이 사라짐" + "안내 앵커 등장"으로 단언한다.
    record('u6', '③a 가장 오래된 원본 메시지(auto-src-msg-1)는 더 이상 채널에 없음(실제로 정리됨)', !autoFinalTexts.includes('auto-src-msg-1'), `texts=${JSON.stringify(autoFinalTexts)}`);
    record('u7', '③a 채널에 자동 compact 안내 앵커(engram 작성, 위키 slug 참조)가 나타남', autoFinalLines.some((m) => m.authorId === 'engram' && typeof m.text === 'string' && m.text.includes(expectedAutoSlug)), `texts=${JSON.stringify(autoFinalTexts)}`);
    record('u8', '③a 채널 jsonl이 원시 3줄보다 실제로 줄어듦(프루닝이 raw 3줄을 그대로 방치하지 않음)', autoFinalLines.length <= 3, `finalLen=${autoFinalLines.length}`);

    const wikiAfterAuto = snapshotWikiFiles(wikiPagesDir);
    assertWikiInvariant('u9', '★핵심: auto-compact도 새 페이지 1개만 추가하고(② compact 페이지 포함) 기존 위키는 바이트 단위 불변', wikiBeforeAuto, wikiAfterAuto, [`${expectedAutoSlug}.md`]);

    if (getStderr().trim()) console.log('\n[server A stderr(tail, 참고용)]\n' + getStderr().slice(-2000));
  } catch (e) {
    record('boot-a', 'Boot A 프로브 전체 흐름 예외 없이 완료', false, String(e));
    const err = getStderr();
    if (err.trim()) console.log('\n[server A stderr(tail)]\n' + err.slice(-3000));
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// Boot B: autoCompact=false(부팅 시점 설정, 재시작 필요 — admin-http.ts 주석: "autoCompact는 retention과
// 달리 런타임 세터가 없다") + retention count:2. 훅이 아예 설치 안 되므로 pruneChannel은 raw 동기
// 삭제(S4 그대로) — 브레인 불필요. scripts/smoke-console-s4.ts의 retention-prune 검증과 동일한 결.
// ══════════════════════════════════════════════════════════════════════════════════════════
async function probeBootB(tmpBase: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  console.log('\n[Probe B] auto-compact OFF — raw 프루닝(S4)만, 위키 미생성');
  const dataDir = path.join(tmpBase, 'boot-b');
  fs.mkdirSync(dataDir, { recursive: true });
  const configDir = path.join(dataDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const port = getFreePortSync();
  const host = '127.0.0.1';

  fs.writeFileSync(path.join(configDir, 'chat.json'), JSON.stringify({
    enabled: true, role: 'server', retention: { mode: 'count', value: 2 }, autoCompact: false,
  }, null, 2));

  const { proc, getStderr } = spawnServer(dataDir, { ENGRAM_CHAT_PORT: String(port), ENGRAM_CHAT_BIND: '127.0.0.1' });
  cleanup.push(() => killProc(proc));

  try {
    await waitHealthy(host, port, 60000);
    console.log(`   [setup] 서버 healthy on :${port}`);
    const ownerToken = await setupOwner(host, port, dataDir, 'ccb-owner');

    const wikiPagesDir = path.join(dataDir, 'wiki', 'pages', 'default');
    fs.mkdirSync(wikiPagesDir, { recursive: true });
    const seedPage: WikiPage = {
      slug: 'smoke-clear-compact-baseline-b',
      frontmatter: { title: 'Clear-Compact Smoke Baseline B', category: 'smoke', status: 'published', sources: [], created: new Date().toISOString(), updated: new Date().toISOString() },
      body: 'Baseline page for Boot B — autoCompact:false means no new wiki page should ever appear here.',
    };
    fs.writeFileSync(path.join(wikiPagesDir, `${seedPage.slug}.md`), serializePage(seedPage));
    const wikiBefore = snapshotWikiFiles(wikiPagesDir);
    record('o0', '위키 기준선 시딩 확인(Boot B)', wikiBefore.size === 1, `files=${JSON.stringify([...wikiBefore.keys()])}`);

    const settingsRes = await jsonFetch(`http://${host}:${port}/admin/api/server-settings`, { headers: authHeaders(ownerToken) });
    record('o1', 'autoCompact=false가 부팅 설정에 반영됨(GET server-settings)', settingsRes.body.autoCompact === false && settingsRes.body.retention?.mode === 'count' && settingsRes.body.retention?.value === 2, settingsRes.text);

    const ws = await connectWs(host, port, 15000);
    cleanup.push(async () => { try { ws.terminate(); } catch { /* 격리 */ } });
    await waitForFrame(ws, (f) => f.t === 'authOk' || f.t === 'authErr', 8000, 'owner ws 인증', { t: 'auth', token: ownerToken });

    const chFrame = await waitForFrame(ws, (f) => f.t === 'channels' && f.list.some((c: any) => c.name === 'AutoOffTest'), 10000, 'AutoOffTest 채널 생성', { t: 'createChannel', name: 'AutoOffTest' });
    const chId: string = chFrame.list.find((c: any) => c.name === 'AutoOffTest').id;
    await waitForFrame(ws, (f) => f.t === 'channels', 10000, 'setRespondMode(mention)', { t: 'setRespondMode', id: chId, mode: 'mention' });

    const jsonlPath = path.join(dataDir, 'state', 'chat', `${chId}.jsonl`);
    for (const text of ['off-src-msg-1', 'off-src-msg-2', 'off-src-msg-3']) {
      await waitForFrame(ws, (f) => f.t === 'msg' && f.channelId === chId && f.message?.text === text, 15000, `append '${text}'`, { t: 'send', channelId: chId, text });
    }
    // raw 동기 프루닝(훅 미설치)이라 3번째 append의 msg 브로드캐스트 수신 시점엔 이미 완료돼 있다(console-s4와 동일 결).
    const finalLines = readJsonlLines(jsonlPath);
    record('o2', '★핵심: autoCompact=false → 채널 jsonl이 정확히 2줄로 raw 프루닝됨(S4 그대로)', finalLines.length === 2, `lines=${JSON.stringify(finalLines.map((m) => m.text))}`);
    record('o3', '가장 최근 2개(off-src-msg-2/3)만 남고 가장 오래된 건 사라짐', finalLines.map((m) => m.text).join(',') === 'off-src-msg-2,off-src-msg-3', JSON.stringify(finalLines.map((m) => m.text)));

    await sleep(3000); // 혹시 모를 비동기 위키 게시가 없다는 것을 확실히 하기 위한 정착 대기.
    const wikiAfter = snapshotWikiFiles(wikiPagesDir);
    assertWikiInvariant('o4', '★핵심: autoCompact=false면 위키에 새 페이지가 전혀 생기지 않음(순수 삭제만, S4와 동일)', wikiBefore, wikiAfter, []);

    if (getStderr().trim()) console.log('\n[server B stderr(tail, 참고용)]\n' + getStderr().slice(-2000));
  } catch (e) {
    record('boot-b', 'Boot B 프로브 전체 흐름 예외 없이 완료', false, String(e));
    const err = getStderr();
    if (err.trim()) console.log('\n[server B stderr(tail)]\n' + err.slice(-3000));
  }
}

async function main(): Promise<void> {
  checkStaleAndBuild();

  const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'engram-smoke-clear-compact-'));
  console.log(`[setup] temp base: ${tmpBase}`);
  const cleanup: Array<() => Promise<void>> = [];

  try {
    await probeBootA(tmpBase, cleanup);
    // Boot A 정리(포트/Lance 점유 해제) 후 Boot B 시작 — 자원 격리(태스크 브리프: "orphaned server holding
    // Lance/port breaks reruns"). 여기서 먼저 비워 Boot B가 깨끗한 상태에서 시작하게 한다.
    for (const task of cleanup.splice(0).reverse()) {
      try { await task(); } catch { /* 정리 실패는 무해 — 계속 진행 */ }
    }
    await probeBootB(tmpBase, cleanup);
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
