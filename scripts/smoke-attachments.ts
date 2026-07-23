import 'reflect-metadata';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as http from 'http';
import { randomUUID } from 'crypto';
import { execSync, spawn, ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { WebSocket } from 'ws';
import { serializePage } from '../src/knowledge-core/wiki/page-serializer';
import type { WikiPage } from '../src/knowledge-core/wiki/page.types';

// 실 스모크: 채팅 첨부(플랜 docs/superpowers/plans/2026-07-23-chat-attachments-design.md,
// Task 5 브리프 .superpowers/sdd/task-5-brief.md). 진짜 node dist/src/main.js 서버 프로세스 +
// 진짜 http 업로드/다운로드 + 진짜 ws 클라이언트 + 진짜(격리) HTTP 두뇌 목(openai-api 하네스가
// 말 거는 상대만 모킹 — 다른 스모크들과 동일한 결)으로 검증한다. 우리 코드는 전혀 모킹하지 않는다.
// 하네스는 scripts/smoke-clear-compact.ts(부팅·목두뇌·위키 불변)와 scripts/smoke-console-s4.ts
// (retention 프루닝 실증)의 헬퍼를 그대로 재사용한다(신규 하네스 발명 금지).
//
// 인증: 두 부팅 모두 계정을 하나도 만들지 않는다 — accounts.count()===0 + 루프백 소켓/요청이면
// self.adapter.bypassAuth·AttachmentsHttp의 localFree가 전부 통과시킨다(무인증 모드, 기존 스모크
// 관례와 동일). isServer=true(role 미설정=기본 'server')라야 attachmentsDeps(HTTP 업로드/다운로드)가
// main.ts에서 배선된다 — role:'brain'을 쓰면 그 자체가 배선 안 됨(브리프 조사 항목이었던 부분).
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

// 부정 검증용: 프레임을 보내고 timeoutMs 동안 pred에 맞는 프레임이 하나라도 오면 잡아서 돌려준다.
// 안 오면(무반응) got=undefined로 resolve — 무한대기 없음(고정 창).
function sendAndExpectNone(ws: WebSocket, frame: unknown, pred: (f: any) => boolean, timeoutMs: number): Promise<{ got?: any }> {
  return new Promise((resolve) => {
    let got: any;
    function onMsg(raw: Buffer | string): void {
      let f: any;
      try { f = JSON.parse(String(raw)); } catch { return; }
      if (pred(f) && !got) got = f;
    }
    ws.on('message', onMsg);
    ws.send(JSON.stringify(frame));
    setTimeout(() => {
      ws.off('message', onMsg);
      resolve({ got });
    }, timeoutMs);
  });
}

// ── dist 신선도: 이 기능이 만지는 소스 목록을 대응 dist .js와 mtime 비교(scripts/smoke-console-s4.ts 관례). ──
function checkStaleAndBuild(): void {
  const files = [
    'main.ts',
    'edge/messenger/self.adapter.ts',
    'edge/messenger/chat-store.ts',
    'edge/messenger/chat.config.ts',
    'edge/messenger/attachment-store.ts',
    'edge/messenger/attachments-http.ts',
    'edge/messenger/channel-access.ts',
    'edge/messenger/messenger-bridge.ts',
    'edge/core-message.ts',
    'agent-layer/reader-agent.ts',
    'agent-layer/orchestrator.ts',
    'agent-layer/channel-brain-resolver.ts',
    'agent-layer/channel-policy.ts',
    'brain/openai-api.brain.ts',
    'brain/brain.port.ts',
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
  // shared/protocol.ts도 첨부 메타 타입을 담아 dist/shared로 별도 컴파일된다 — 함께 신선도 확인.
  const sharedSrc = path.join(REPO_ROOT, 'shared', 'protocol.ts');
  const sharedDist = path.join(REPO_ROOT, 'dist', 'shared', 'protocol.js');
  if (!stale && (!fs.existsSync(sharedDist) || fs.statSync(sharedSrc).mtimeMs > fs.statSync(sharedDist).mtimeMs)) stale = true;
  if (stale) {
    console.log('[setup] dist가 stale — npm run build 실행 중 …');
    execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
  } else {
    console.log('[setup] dist 최신 — 빌드 스킵');
  }
}

function getFreePortSync(): number {
  return 50000 + Math.floor(Math.random() * 10000);
}

function readJsonlLines(jsonlPath: string): any[] {
  if (!fs.existsSync(jsonlPath)) return [];
  return fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function snapshotWikiFiles(wikiPagesDir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(wikiPagesDir)) return out;
  for (const f of fs.readdirSync(wikiPagesDir)) {
    if (!f.endsWith('.md')) continue;
    out.set(f, fs.readFileSync(path.join(wikiPagesDir, f), 'utf8'));
  }
  return out;
}

function assertWikiInvariant(id: string, desc: string, before: Map<string, string>, after: Map<string, string>): void {
  const sameKeySet = before.size === after.size && [...before.keys()].every((k) => after.has(k));
  let unchanged = true;
  for (const [k, v] of before) if (after.get(k) !== v) unchanged = false;
  record(id, desc, sameKeySet && unchanged, `beforeKeys=${JSON.stringify([...before.keys()])} afterKeys=${JSON.stringify([...after.keys()])}`);
}

// ── 목 두뇌 http(scripts/smoke-clear-compact.ts의 createMockBrainServer 재사용). openai-api 하네스가
// 말 거는 OpenAI 호환 chat/completions를 SSE로 흉내낸다. 실제로 오간 요청 바디(멀티모달 content 배열
// 포함)를 그대로 requestLog에 남겨 ③(두뇌 관통) 단언에 쓴다. ──
interface MockRequest { n: number; body: { messages?: Array<{ role: string; content?: unknown }> } }
const MOCKBRAIN_FALLBACK = 'MOCKBRAIN-ACK';

function createMockBrainServer(): { server: http.Server; port: number; requestLog: MockRequest[] } {
  const requestLog: MockRequest[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('error', () => { try { res.destroy(); } catch { /* 격리 */ } });
    req.on('end', () => {
      let body: MockRequest['body'] = {};
      try { body = JSON.parse(raw); } catch { /* 손상 요청은 빈 바디로 기록 */ }
      requestLog.push({ n: requestLog.length + 1, body });
      const payload = { choices: [{ delta: { content: MOCKBRAIN_FALLBACK } }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  server.on('error', (err) => console.error('[mock] server error', err));
  return { server, port: 0, requestLog };
}

async function jsonFetch(url: string, opts: RequestInit = {}): Promise<{ status: number; body: any; text: string; headers: Headers }> {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  return { status: r.status, body, text, headers: r.headers };
}

// ── 첨부 테스트 데이터: 몇 바이트짜리가 아니라 실제로 유효한 1x1 투명 PNG(전형적인 최소 PNG,
// 헤더+IHDR+IDAT+IEND 전부 갖춤) + 인식 가능한 마커가 박힌 ~1KB 텍스트 파일. ──
const TEST_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const TEST_PNG_BUF = Buffer.from(TEST_PNG_BASE64, 'base64');
const TEXT_MARKER = 'ATTACH-SMOKE-TEXT-MARKER-7f3c9a';
const TEST_TEXT_BUF = Buffer.from(
  Array.from({ length: 20 }, (_, i) => `line ${i}: ${TEXT_MARKER} — recognizable smoke-test content padding to about one kilobyte.`).join('\n'),
  'utf8',
);

async function uploadAttachment(
  base: string, channelId: string, name: string, mime: string, data: Buffer,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}/attachments/${channelId}`, {
    method: 'POST',
    headers: { 'content-type': mime, 'x-attachment-name': encodeURIComponent(name) },
    body: new Uint8Array(data),
  });
  const text = await r.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  return { status: r.status, body };
}

async function downloadAttachment(base: string, channelId: string, id: string): Promise<{ status: number; buf: Buffer; headers: Headers }> {
  const r = await fetch(`${base}/attachments/${channelId}/${id}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, buf, headers: r.headers };
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// Boot A: 무제한 보존(retention 미설정) — ①업로드 ②send 스탬프 ③두뇌 관통 ④다운로드 바이트동일
// ⑤위조 id 무시 ⑦clear+dropClearBackup 첨부 운명공유 + 대용량 업로드 413. mockbrain 필요.
// ══════════════════════════════════════════════════════════════════════════════════════════
async function probeBootA(tmpBase: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  console.log('\n[Probe A] 업로드→send 스탬프→두뇌 관통→다운로드→위조 id 무시→clear 첨부 운명공유→대용량 413');
  const dataDir = path.join(tmpBase, 'boot-a');
  fs.mkdirSync(dataDir, { recursive: true });
  const configDir = path.join(dataDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const port = getFreePortSync();
  const host = '127.0.0.1';
  const base = `http://${host}:${port}`;

  const mock = createMockBrainServer();
  await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', () => resolve()));
  const mockAddr = mock.server.address();
  const mockPort = typeof mockAddr === 'object' && mockAddr ? mockAddr.port : 0;
  cleanup.push(() => new Promise<void>((r) => mock.server.close(() => r())));
  console.log(`   [setup] mockbrain http on 127.0.0.1:${mockPort}`);

  fs.writeFileSync(path.join(configDir, 'brains.json'), JSON.stringify({
    default: 'default',
    brains: {
      default: { provider: 'claude-cli', cli: 'engram-smoke-attach-nonexistent-cli-xyz', model: '', concurrency: 1, timeoutMs: 5000 },
      mockbrain: { provider: 'openai-api', baseUrl: `http://127.0.0.1:${mockPort}`, model: 'mock-model', concurrency: 1, timeoutMs: 30000, apiKey: 'test-key' },
    },
  }, null, 2));
  // role 미설정=기본 'server'(isServer=true) — attachmentsDeps(HTTP 업로드/다운로드)가 배선되려면 필수.
  // retention 미설정=unlimited 기본(이 부팅에선 프루닝이 끼어들면 안 됨).
  fs.writeFileSync(path.join(configDir, 'chat.json'), JSON.stringify({ enabled: true, role: 'server' }, null, 2));

  const { proc, getStderr } = spawnServer(dataDir, { ENGRAM_CHAT_PORT: String(port), ENGRAM_CHAT_BIND: '127.0.0.1' });
  cleanup.push(() => killProc(proc));

  try {
    await waitHealthy(host, port, 60000);
    console.log(`   [setup] 서버 healthy on :${port}(무인증 모드 — 계정 0개, 전 요청 루프백)`);

    const ws = await connectWs(host, port, 15000);
    cleanup.push(async () => { try { ws.terminate(); } catch { /* 격리 */ } });
    const chFrame0 = await waitForFrame(ws, (f) => f.t === 'channels', 10000, '초기 channels 프레임', { t: 'channels' });
    record('a0', '무인증 모드 초기 channels 프레임 수신(계정 없이도 ws 연결·프레임 왕복)', chFrame0.t === 'channels', JSON.stringify(chFrame0.list?.map((c: any) => c.id)));

    const chFrame = await waitForFrame(ws, (f) => f.t === 'channels' && f.list.some((c: any) => c.name === 'AttachSmoke'), 10000, 'AttachSmoke 채널 생성', { t: 'createChannel', name: 'AttachSmoke' });
    const channelId: string = chFrame.list.find((c: any) => c.name === 'AttachSmoke').id;
    console.log(`   [setup] 테스트 채널=${channelId}`);
    const brainSetFrame = await waitForFrame(ws, (f) => f.t === 'channels', 10000, 'setChannelBrain(mockbrain)', { t: 'setChannelBrain', id: channelId, brain: 'mockbrain' });
    record('a1', '채널 브레인 = mockbrain 설정 확인(무인증 모드에서도 canAdminChannel 통과)', brainSetFrame.list.find((c: any) => c.id === channelId)?.brain === 'mockbrain', JSON.stringify(brainSetFrame.list.find((c: any) => c.id === channelId)));

    // ══════════════════ ① HTTP 업로드(이미지+텍스트 파일) ══════════════════
    const upImg = await uploadAttachment(base, channelId, 'capture.png', 'image/png', TEST_PNG_BUF);
    record('1a', '① 이미지 업로드 → 200 + {id,name,mime,size} 메타', upImg.status === 200 && typeof upImg.body.id === 'string' && upImg.body.name === 'capture.png' && upImg.body.mime === 'image/png' && upImg.body.size === TEST_PNG_BUF.length, JSON.stringify(upImg));
    const imageId: string = upImg.body.id;

    const upTxt = await uploadAttachment(base, channelId, 'notes.txt', 'text/plain', TEST_TEXT_BUF);
    record('1b', '① 텍스트 파일 업로드(~1KB) → 200 + {id,name,mime,size} 메타', upTxt.status === 200 && typeof upTxt.body.id === 'string' && upTxt.body.name === 'notes.txt' && upTxt.body.mime === 'text/plain' && upTxt.body.size === TEST_TEXT_BUF.length, JSON.stringify(upTxt));
    const textId: string = upTxt.body.id;
    record('1c', '① 텍스트 파일이 실제로 대략 1KB(300~4000바이트 범위)', TEST_TEXT_BUF.length > 300 && TEST_TEXT_BUF.length < 4000, `size=${TEST_TEXT_BUF.length}`);

    // ══════════════════ ② send attachments:[imageId, textId] → 브로드캐스트 스탬프 확인 ══════════════════
    const reqBeforeSend2 = mock.requestLog.length;
    const sendMarker2 = 'attach-smoke-send-with-both';
    const userMsg2 = await waitForFrame(
      ws,
      (f) => f.t === 'msg' && f.channelId === channelId && f.message?.text === sendMarker2,
      10000,
      '② 사용자 메시지 브로드캐스트(첨부 스탬프)',
      { t: 'send', channelId, text: sendMarker2, attachments: [imageId, textId] },
    );
    const stampedAtts: any[] = userMsg2.message?.attachments ?? [];
    record('2a', '② 브로드캐스트된 메시지가 attachments 2건을 실음', Array.isArray(stampedAtts) && stampedAtts.length === 2, JSON.stringify(stampedAtts));
    const stampedImg = stampedAtts.find((a) => a.id === imageId);
    const stampedTxt = stampedAtts.find((a) => a.id === textId);
    record('2b', '② 스탬프된 이미지 메타(name/mime/size)가 업로드 응답과 일치', !!stampedImg && stampedImg.name === 'capture.png' && stampedImg.mime === 'image/png' && stampedImg.size === TEST_PNG_BUF.length, JSON.stringify(stampedImg));
    record('2c', '② 스탬프된 텍스트 메타(name/mime/size)가 업로드 응답과 일치', !!stampedTxt && stampedTxt.name === 'notes.txt' && stampedTxt.mime === 'text/plain' && stampedTxt.size === TEST_TEXT_BUF.length, JSON.stringify(stampedTxt));

    // ══════════════════ ③ mock 두뇌 수신: 텍스트 파일 내용(펜스 삽입) + 이미지 base64(vision 블록) ══════════════════
    const engramReply2 = await waitForFrame(
      ws,
      (f) => f.t === 'msg' && f.channelId === channelId && f.message?.authorId === 'engram',
      60000,
      '③ mock 두뇌 응답 브로드캐스트(classify+route 왕복)',
    );
    record('3a', '③ mock 두뇌 응답이 실제로 옴(engram 저자 메시지)', !!engramReply2, JSON.stringify(engramReply2?.message?.id));
    const newCalls = mock.requestLog.slice(reqBeforeSend2);
    record('3b', '③ 이 send 처리 중 mock 두뇌가 정확히 2회 호출됨(classify+route)', newCalls.length === 2, `count=${newCalls.length}`);
    const routeCall = newCalls.find((c) => Array.isArray(c.body.messages?.[0]?.content));
    record('3c', '③ 2회 중 하나(route)의 messages[0].content가 배열(멀티모달 — 텍스트+image_url)', !!routeCall, JSON.stringify(newCalls.map((c) => typeof c.body.messages?.[0]?.content)));
    const contentParts: any[] = Array.isArray(routeCall?.body.messages?.[0]?.content) ? (routeCall!.body.messages![0]!.content as any[]) : [];
    const textPart = contentParts.find((p) => p.type === 'text');
    const imagePart = contentParts.find((p) => p.type === 'image_url');
    record('3d', '③ 프롬프트 텍스트 파트에 업로드한 텍스트 파일 내용(펜스 삽입)이 그대로 실림', typeof textPart?.text === 'string' && textPart.text.includes(TEXT_MARKER), textPart?.text ? String(textPart.text).slice(0, 200) : undefined);
    record('3e', '③ 프롬프트 텍스트 파트에 이미지 첨부 마커([Image attached: capture.png)가 실림', typeof textPart?.text === 'string' && textPart.text.includes('[Image attached: capture.png'), textPart?.text ? String(textPart.text).slice(0, 400) : undefined);
    record('3f', '★핵심: 이미지 base64가 실제로 요청에 실려 두뇌에 전달됨(data:image/png;base64,<업로드한 바이트 그대로>)', imagePart?.image_url?.url === `data:image/png;base64,${TEST_PNG_BASE64}`, imagePart?.image_url?.url ? String(imagePart.image_url.url).slice(0, 80) + '…' : undefined);

    // ══════════════════ ④ GET 다운로드 두 개 → 바이트 동일 ══════════════════
    const downImg = await downloadAttachment(base, channelId, imageId);
    record('4a', '④ 이미지 다운로드 200 + 바이트 업로드와 동일', downImg.status === 200 && downImg.buf.equals(TEST_PNG_BUF), `status=${downImg.status} len=${downImg.buf.length} expected=${TEST_PNG_BUF.length}`);
    record('4b', '④ 이미지 Content-Type=image/png + inline 디스포지션', downImg.headers.get('content-type') === 'image/png' && (downImg.headers.get('content-disposition') ?? '').includes('inline'), `ct=${downImg.headers.get('content-type')} cd=${downImg.headers.get('content-disposition')}`);

    const downTxt = await downloadAttachment(base, channelId, textId);
    record('4c', '④ 텍스트 파일 다운로드 200 + 바이트 업로드와 동일', downTxt.status === 200 && downTxt.buf.equals(TEST_TEXT_BUF), `status=${downTxt.status} len=${downTxt.buf.length} expected=${TEST_TEXT_BUF.length}`);
    record('4d', '④ 텍스트 파일 Content-Type=text/plain + attachment 디스포지션', downTxt.headers.get('content-type') === 'text/plain' && (downTxt.headers.get('content-disposition') ?? '').includes('attachment'), `ct=${downTxt.headers.get('content-type')} cd=${downTxt.headers.get('content-disposition')}`);

    // ══════════════════ ⑤ 위조 id 포함 send → 메시지는 실재하는 것만 스탬프, error 프레임 없음 ══════════════════
    const forgedWellFormed = '11111111-1111-1111-1111-111111111111';
    const forgedGarbage = 'not-a-real-attachment-id';
    const sendMarker5 = 'attach-smoke-send-with-forged';
    const reqBeforeSend5 = mock.requestLog.length;
    const { got: userMsg5 } = await sendAndExpectNone(
      ws,
      { t: 'send', channelId, text: sendMarker5, attachments: [imageId, forgedWellFormed, forgedGarbage, textId] },
      (f) => f.t === 'msg' && f.channelId === channelId && f.message?.text === sendMarker5,
      8000,
    );
    record('5a', '⑤ 위조 id 섞인 send도 정상적으로 메시지 브로드캐스트됨(무시만 하지 통째로 드롭 안 함)', !!userMsg5, JSON.stringify(userMsg5?.message?.attachments));
    const stampedAtts5: any[] = userMsg5?.message?.attachments ?? [];
    record('5b', '⑤ 스탬프된 attachments가 실재하는 2건만(위조 2건은 조용히 제외)', stampedAtts5.length === 2 && stampedAtts5.some((a) => a.id === imageId) && stampedAtts5.some((a) => a.id === textId), JSON.stringify(stampedAtts5));
    record('5c', '⑤ 잘 만들어진(uuid 형태) 위조 id가 스탬프에 없음', !stampedAtts5.some((a) => a.id === forgedWellFormed), JSON.stringify(stampedAtts5));
    record('5d', '⑤ 형식부터 깨진 위조 id가 스탬프에 없음', !stampedAtts5.some((a) => a.id === forgedGarbage), JSON.stringify(stampedAtts5));

    const { got: errFrame5 } = await sendAndExpectNone(ws, undefined, (f) => f.t === 'error', 2000);
    record('5e', '⑤ 위조 id 포함 send 처리 중/후 error 프레임이 전혀 오지 않음', !errFrame5, JSON.stringify(errFrame5));

    // 두뇌 관통 회귀 확인 겸 소음 정리: ⑤도 브레인 응답을 트리거하므로 다음 단계로 넘어가기 전 소비.
    await waitForFrame(ws, (f) => f.t === 'msg' && f.channelId === channelId && f.message?.authorId === 'engram' && f.message?.id !== engramReply2.message.id, 60000, '⑤ 이후 mock 두뇌 응답(소음 정리)').catch(() => { /* 늦어도 이후 단언에 영향 없음 */ });
    void reqBeforeSend5;

    // ══════════════════ 대용량 업로드(21MB) → 413, 바운드된 시간 ══════════════════
    const oversizeBuf = Buffer.alloc(21 * 1024 * 1024, 0x61); // MAX_ATTACHMENT_BYTES(20MB) 초과
    const t0 = Date.now();
    const oversizeRes = await uploadAttachment(base, channelId, 'huge.bin', 'application/octet-stream', oversizeBuf);
    const elapsedMs = Date.now() - t0;
    record('ov1', '대용량(21MB > 20MB 상한) 업로드 → 413', oversizeRes.status === 413, JSON.stringify(oversizeRes));
    record('ov2', `대용량 업로드가 바운드된 시간(<10000ms) 안에 응답(실측 ${elapsedMs}ms — 전체 바디를 다 기다리지 않고 상한 초과 즉시 정착)`, elapsedMs < 10000, `elapsedMs=${elapsedMs}`);

    // ══════════════════ ⑦ /clear → 첨부 파일 존속(undo 창) → dropClearBackup → 첨부 파일 소멸 ══════════════════
    const chFrame7 = await waitForFrame(ws, (f) => f.t === 'channels' && f.list.some((c: any) => c.name === 'ClearAttachSmoke'), 10000, 'ClearAttachSmoke 채널 생성', { t: 'createChannel', name: 'ClearAttachSmoke' });
    const clearChId: string = chFrame7.list.find((c: any) => c.name === 'ClearAttachSmoke').id;
    // respondMode=mention: 멘션 없는 평문은 핸들러 미호출(브레인 소음·지연 회피 — smoke-console-s4/clear-compact 관례).
    await waitForFrame(ws, (f) => f.t === 'channels', 10000, 'ClearAttachSmoke setRespondMode(mention)', { t: 'setRespondMode', id: clearChId, mode: 'mention' });

    const upClear = await uploadAttachment(base, clearChId, 'clear-note.txt', 'text/plain', Buffer.from('clear fate-sharing smoke note', 'utf8'));
    record('c0', '⑦ clear 테스트용 첨부 업로드 성공', upClear.status === 200 && typeof upClear.body.id === 'string', JSON.stringify(upClear));
    const clearAttId: string = upClear.body.id;
    // AttachmentStore는 paths.getStateDir()(=dataDir/state) 기준 — main.ts: new AttachmentStore(paths.getStateDir()).
    const attachmentsBaseDir = path.join(dataDir, 'state', 'attachments', clearChId);
    const clearAttFile = path.join(attachmentsBaseDir, clearAttId);
    const clearAttMeta = path.join(attachmentsBaseDir, `${clearAttId}.json`);
    record('c1', '⑦ 업로드 직후 첨부 실파일+메타 둘 다 디스크에 존재', fs.existsSync(clearAttFile) && fs.existsSync(clearAttMeta), `file=${fs.existsSync(clearAttFile)} meta=${fs.existsSync(clearAttMeta)}`);

    await waitForFrame(ws, (f) => f.t === 'msg' && f.channelId === clearChId && f.message?.text === 'clear-src-with-attachment', 10000, '⑦ 첨부 실린 메시지 append', { t: 'send', channelId: clearChId, text: 'clear-src-with-attachment', attachments: [clearAttId] });

    const clearedFrame = await waitForFrame(ws, (f) => f.t === 'historyCleared' && f.channelId === clearChId, 10000, "⑦ clearHistory → {t:'historyCleared'}", { t: 'clearHistory', id: clearChId });
    record('c2', "⑦ clearHistory → {t:'historyCleared'} 브로드캐스트 수신", clearedFrame.t === 'historyCleared', JSON.stringify(clearedFrame));

    const clearJsonl = path.join(dataDir, 'state', 'chat', `${clearChId}.jsonl`);
    record('c3', '⑦ clear 후 jsonl 없음(history 빈 것)', !fs.existsSync(clearJsonl), `exists=${fs.existsSync(clearJsonl)}`);
    record('c4', '⑦ clear 후 `.cleared` 백업 파일 존재(undo 창)', fs.existsSync(`${clearJsonl}.cleared`), `exists=${fs.existsSync(`${clearJsonl}.cleared`)}`);
    record('c5', '★핵심: clear 직후(undo 유예 동안)는 첨부 실파일이 여전히 디스크에 존재(운명공유는 dropClearBackup 시점)', fs.existsSync(clearAttFile) && fs.existsSync(clearAttMeta), `file=${fs.existsSync(clearAttFile)} meta=${fs.existsSync(clearAttMeta)}`);

    // dropClearBackup은 응답 프레임이 없다 — 뒤이은 무해한 channels 왕복으로 처리 완료를 확인(smoke-clear-compact 관례).
    ws.send(JSON.stringify({ t: 'dropClearBackup', id: clearChId }));
    await waitForFrame(ws, (f) => f.t === 'channels', 10000, 'dropClearBackup 후 channels 왕복', { t: 'channels' });
    record('c6', '⑦ dropClearBackup 후 백업 파일 소멸', !fs.existsSync(`${clearJsonl}.cleared`), `exists=${fs.existsSync(`${clearJsonl}.cleared`)}`);
    record('c7', '★핵심: dropClearBackup 이후 첨부 실파일이 실제로 삭제됨(운명공유 확정)', !fs.existsSync(clearAttFile) && !fs.existsSync(clearAttMeta), `file=${fs.existsSync(clearAttFile)} meta=${fs.existsSync(clearAttMeta)}`);

    if (getStderr().trim()) console.log('\n[server A stderr(tail, 참고용)]\n' + getStderr().slice(-2000));
  } catch (e) {
    record('boot-a', 'Boot A 프로브 전체 흐름 예외 없이 완료', false, String(e));
    const err = getStderr();
    if (err.trim()) console.log('\n[server A stderr(tail)]\n' + err.slice(-3000));
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// Boot B: retention count:2(부팅 시점 chat.json) — ⑥프루닝 시 첨부 실파일 삭제 실증 + 위키 불변.
// 브레인 불필요(respondMode=mention으로 비멘션 append는 핸들러 미호출 — S4/clear-compact 관례).
// ══════════════════════════════════════════════════════════════════════════════════════════
async function probeBootB(tmpBase: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  console.log('\n[Probe B] retention count:2 프루닝 → 첨부 실파일 삭제 실증(운명공유) + 위키 불변');
  const dataDir = path.join(tmpBase, 'boot-b');
  fs.mkdirSync(dataDir, { recursive: true });
  const configDir = path.join(dataDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const port = getFreePortSync();
  const host = '127.0.0.1';

  // autoCompact:false — clear-compact Task 5(main.ts)가 설치하는 자동 요약 훅을 꺼서 순수 raw 동기
  // 프루닝(S4 그대로)으로 떨어뜨린다. 켜져 있으면(기본값) 비동기 "요약→위키 게시 성공 후에만 삭제"
  // 경로를 타 브레인 왕복이 끼어들고(브레인 미배선이면 실제 CLI를 찾으려 들 수도 있음), 이 항목이
  // 검증하려는 "즉시·동기 삭제" 실증이 레이스가 된다(smoke-clear-compact Boot B와 동일한 결).
  fs.writeFileSync(path.join(configDir, 'chat.json'), JSON.stringify({
    enabled: true, role: 'server', retention: { mode: 'count', value: 2 }, autoCompact: false,
  }, null, 2));

  const { proc, getStderr } = spawnServer(dataDir, { ENGRAM_CHAT_PORT: String(port), ENGRAM_CHAT_BIND: '127.0.0.1' });
  cleanup.push(() => killProc(proc));

  try {
    await waitHealthy(host, port, 60000);
    console.log(`   [setup] 서버 healthy on :${port}`);

    // 위키 불변 증거의 기준선(0이면 무의미한 증명 — smoke-console-s4 관례).
    const wikiPagesDir = path.join(dataDir, 'wiki', 'pages', 'default');
    fs.mkdirSync(wikiPagesDir, { recursive: true });
    const seedPage: WikiPage = {
      slug: 'smoke-attachments-retention-baseline',
      frontmatter: { title: 'Attachments Retention Smoke Baseline', category: 'smoke', status: 'published', sources: [], created: new Date().toISOString(), updated: new Date().toISOString() },
      body: 'Baseline page — must survive attachment retention-prune untouched (byte-identical).',
    };
    fs.writeFileSync(path.join(wikiPagesDir, `${seedPage.slug}.md`), serializePage(seedPage));
    const wikiBefore = snapshotWikiFiles(wikiPagesDir);
    record('b0', '위키 기준선 시딩 확인(≥1 페이지)', wikiBefore.size === 1, `files=${JSON.stringify([...wikiBefore.keys()])}`);

    const ws = await connectWs(host, port, 15000);
    cleanup.push(async () => { try { ws.terminate(); } catch { /* 격리 */ } });
    await waitForFrame(ws, (f) => f.t === 'channels', 10000, '초기 channels 프레임', { t: 'channels' });

    const chFrame = await waitForFrame(ws, (f) => f.t === 'channels' && f.list.some((c: any) => c.name === 'RetentionAttach'), 10000, 'RetentionAttach 채널 생성', { t: 'createChannel', name: 'RetentionAttach' });
    const channelId: string = chFrame.list.find((c: any) => c.name === 'RetentionAttach').id;
    await waitForFrame(ws, (f) => f.t === 'channels', 10000, 'setRespondMode(mention)', { t: 'setRespondMode', id: channelId, mode: 'mention' });

    const base = `http://${host}:${port}`;
    const up1 = await jsonFetch(`${base}/attachments/${channelId}`, {
      method: 'POST', headers: { 'content-type': 'text/plain', 'x-attachment-name': encodeURIComponent('retain1.txt') }, body: 'oldest message attachment — must be pruned away',
    });
    record('b1', '⑥ 프루닝 대상 메시지(가장 오래될 메시지1)용 첨부 업로드 성공', up1.status === 200 && typeof up1.body.id === 'string', up1.text);
    const prunedAttId: string = up1.body.id;
    const attDir = path.join(dataDir, 'state', 'attachments', channelId);
    const prunedAttFile = path.join(attDir, prunedAttId);
    const prunedAttMeta = path.join(attDir, `${prunedAttId}.json`);
    record('b2', '⑥ 업로드 직후 첨부 실파일+메타 존재', fs.existsSync(prunedAttFile) && fs.existsSync(prunedAttMeta), `file=${fs.existsSync(prunedAttFile)} meta=${fs.existsSync(prunedAttMeta)}`);

    await waitForFrame(ws, (f) => f.t === 'msg' && f.channelId === channelId && f.message?.text === 'retention-msg-1', 15000, "append 'retention-msg-1'(첨부 실림)", { t: 'send', channelId, text: 'retention-msg-1', attachments: [prunedAttId] });
    // 뒤이은 필러 메시지 2개(첨부 없음) — count:2 정책이 msg1을 밀어낸다. 매 append 직후 pruneChannel이
    // 동기 호출되므로(chat-store.ts), 3번째 브로드캐스트 수신 시점엔 이미 프루닝이 끝나 있다(S4와 동일 결).
    await waitForFrame(ws, (f) => f.t === 'msg' && f.channelId === channelId && f.message?.text === 'retention-msg-2', 15000, "append 'retention-msg-2'", { t: 'send', channelId, text: 'retention-msg-2' });
    await waitForFrame(ws, (f) => f.t === 'msg' && f.channelId === channelId && f.message?.text === 'retention-msg-3', 15000, "append 'retention-msg-3'", { t: 'send', channelId, text: 'retention-msg-3' });

    const jsonlPath = path.join(dataDir, 'state', 'chat', `${channelId}.jsonl`);
    const finalLines = readJsonlLines(jsonlPath);
    record('b3', '⑥ 채널 jsonl이 정확히 2줄만 남음(retention count=2 프루닝 실증)', finalLines.length === 2, `lines=${JSON.stringify(finalLines.map((m) => m.text))}`);
    record('b4', '⑥ 남은 2줄이 최신 메시지(msg2·msg3) — 첨부 실린 msg1은 프루닝되어 사라짐', finalLines.map((m) => m.text).join(',') === 'retention-msg-2,retention-msg-3', JSON.stringify(finalLines.map((m) => m.text)));

    record('b5', '★핵심: retention 프루닝으로 msg1이 사라지면서 그 첨부 실파일도 디스크에서 삭제됨(운명공유)', !fs.existsSync(prunedAttFile), `exists=${fs.existsSync(prunedAttFile)}`);
    record('b6', '★핵심: 첨부 사이드카 메타(.json)도 함께 삭제됨', !fs.existsSync(prunedAttMeta), `exists=${fs.existsSync(prunedAttMeta)}`);

    const wikiAfter = snapshotWikiFiles(wikiPagesDir);
    assertWikiInvariant('b7', '★핵심: 첨부 운명공유 프루닝이 위키에는 전혀 손대지 않음(대화·첨부만 정리)', wikiBefore, wikiAfter);

    if (getStderr().trim()) console.log('\n[server B stderr(tail, 참고용)]\n' + getStderr().slice(-2000));
  } catch (e) {
    record('boot-b', 'Boot B 프로브 전체 흐름 예외 없이 완료', false, String(e));
    const err = getStderr();
    if (err.trim()) console.log('\n[server B stderr(tail)]\n' + err.slice(-3000));
  }
}

async function runOnce(): Promise<number> {
  results.length = 0;
  const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'engram-smoke-attach-'));
  console.log(`[setup] temp base: ${tmpBase}`);
  const cleanup: Array<() => Promise<void>> = [];

  try {
    await probeBootA(tmpBase, cleanup);
    // Boot A 정리(포트/자원 해제) 후 Boot B 시작(smoke-clear-compact 관례) — 자원 격리.
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
  return failures;
}

async function main(): Promise<void> {
  checkStaleAndBuild();

  const runs = Number(process.env.SMOKE_RUNS ?? '1');
  let totalFailures = 0;
  for (let i = 1; i <= runs; i++) {
    console.log(`\n########## RUN ${i}/${runs} ##########`);
    totalFailures += await runOnce();
  }
  process.exitCode = totalFailures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exitCode = 1;
});
