import 'reflect-metadata';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as http from 'http';
import { spawn, ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { WebSocket } from 'ws';

type ServerProc = ChildProcessByStdio<null, Readable, Readable>;

// 실 스모크: 채널별 두뇌 지정 기능(ws `setChannelBrain` → ChatStore.brain 영속 → 채널 이벤트에
// 실려 agent-layer가 이름→두뇌 캐시로 요청 한정 해소 → ask_brain 자기위임 배제)을 진짜 서버 프로세스
// (node dist/src/main.js) + 진짜 ws 클라이언트 + 진짜(격리) HTTP 두뇌 목로 검증한다.
// 우리 코드는 전혀 모킹하지 않는다 — 유일한 모킹은 openai-api 하네스가 말 거는 상대(외부 LLM API)뿐.
//
// 격리: ENGRAM_DATA_DIR를 임시 디렉터리로 못박아 실 사용자 데이터(%APPDATA%/engram)를 절대 건드리지 않는다.
// 모든 대기는 타임아웃 있음(하우스룰) — 무한 대기 없음. 자식 프로세스는 전부 'error' 리스너 보유.

const REPO_ROOT = path.resolve(__dirname, '..');
const CHAT_PORT = 47955; // 실 앱 기본(47800)과 충돌 회피용 별도 포트
const MOCKBRAIN_SAYS = 'MOCKBRAIN-SAYS';

type ScriptedResponse =
  | { type: 'content'; text: string }
  | { type: 'toolCall'; name: string; args: Record<string, unknown> };

interface MockRequest {
  n: number;
  body: { messages?: Array<{ role: string; content?: string | null; tool_calls?: unknown }> };
}

interface Result {
  id: string;
  desc: string;
  pass: boolean;
  detail?: string;
}
const results: Result[] = [];
function record(id: string, desc: string, pass: boolean, detail?: string): void {
  results.push({ id, desc, pass, detail });
  console.log(`   ${pass ? '✓' : '✗ FAIL'} (${id}) ${desc}${detail ? ' — ' + detail : ''}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 조건이 참이 될 때까지 폴링(무한대기 금지 — timeoutMs 초과 시 throw).
async function waitFor(pred: () => boolean, timeoutMs: number, label: string, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() >= deadline) throw new Error(`timeout(${timeoutMs}ms) waiting for ${label}`);
    await sleep(intervalMs);
  }
}

// ── HTTP 목(mockbrain 두뇌가 말 거는 상대). OpenAI 호환 chat/completions를 SSE로 흉내낸다. ──
function createMockBrainServer(): {
  server: http.Server;
  port: number;
  requestLog: MockRequest[];
  queue: ScriptedResponse[];
} {
  const requestLog: MockRequest[] = [];
  const queue: ScriptedResponse[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('error', () => {
      try { res.destroy(); } catch { /* 격리 */ }
    });
    req.on('end', () => {
      let body: MockRequest['body'] = {};
      try { body = JSON.parse(raw); } catch { /* 손상 요청은 빈 바디로 기록 */ }
      requestLog.push({ n: requestLog.length + 1, body });
      const item = queue.shift();
      let payload: unknown;
      if (!item || item.type === 'content') {
        payload = { choices: [{ delta: { content: item ? item.text : MOCKBRAIN_SAYS } }] };
      } else {
        payload = {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: `call_${requestLog.length}`, function: { name: item.name, arguments: JSON.stringify(item.args) } },
                ],
              },
            },
          ],
        };
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  server.on('error', (err) => console.error('[mock] server error', err));
  return { server, port: 0, requestLog, queue };
}

// ── ws 헬퍼: 프레임을 보내고 predicate에 맞는 응답을 기다린다(타임아웃 있음, race 없음 — send 전에 리스너부터 건다). ──
function sendAndWait<T = any>(ws: WebSocket, frame: unknown, pred: (f: any) => boolean, timeoutMs: number, label: string): Promise<T> {
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
    if (frame !== undefined) ws.send(JSON.stringify(frame));
  });
}

async function killProc(proc: ServerProc | undefined): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  const pid = proc.pid;
  proc.kill();
  try {
    await waitFor(() => proc.exitCode !== null, 8000, 'server process exit');
  } catch {
    // 정상 종료 실패 — Windows에서 강제 종료 폴백
    if (pid) {
      try {
        const { execSync } = await import('child_process');
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      } catch { /* 이미 죽었거나 taskkill 실패 — 무시 */ }
    }
  }
}

async function main(): Promise<void> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'engram-smoke-cb-'));
  const configDir = path.join(base, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  const mock = createMockBrainServer();
  await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', () => resolve()));
  const addr = mock.server.address();
  mock.port = typeof addr === 'object' && addr ? addr.port : 0;
  console.log(`[setup] mockbrain http on 127.0.0.1:${mock.port}`);

  // brains.json: default=오프라인(존재하지 않는 CLI, 네트워크 0) + mockbrain=격리 목 서버(openai-api).
  fs.writeFileSync(
    path.join(configDir, 'brains.json'),
    JSON.stringify(
      {
        default: 'default',
        brains: {
          default: { provider: 'claude-cli', cli: 'engram-smoke-nonexistent-cli-xyz', model: '', concurrency: 1, timeoutMs: 5000 },
          mockbrain: { provider: 'openai-api', baseUrl: `http://127.0.0.1:${mock.port}`, model: 'mock-model', concurrency: 1, timeoutMs: 20000, apiKey: 'test-key' },
        },
      },
      null,
      2,
    ),
  );

  const spawnEnv = {
    ...process.env,
    ENGRAM_DATA_DIR: base,
    ENGRAM_CHAT_ROLE: 'brain', // 무인증 모드(계정 배선 없이 채널 API 전체 사용 가능) — 기존 스모크 관례와 동일 결
    ENGRAM_CHAT_PORT: String(CHAT_PORT),
    ENGRAM_CHAT_BIND: '127.0.0.1',
  };

  let serverProc: ServerProc | undefined;
  let serverOut = '';
  let serverErr = '';
  function spawnServer(): ServerProc {
    const p = spawn(process.execPath, [path.join(REPO_ROOT, 'dist', 'src', 'main.js')], {
      cwd: REPO_ROOT,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ServerProc;
    p.on('error', (err) => console.error('[server] spawn error', err));
    p.stdout.on('data', (d) => (serverOut += d.toString()));
    p.stderr.on('data', (d) => (serverErr += d.toString()));
    return p;
  }

  async function waitHealthy(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${CHAT_PORT}/`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          const j = (await r.json()) as { ok?: boolean };
          if (j.ok) return;
        }
      } catch { /* 아직 리슨 전 — 재시도 */ }
      if (Date.now() >= deadline) throw new Error(`timeout(${timeoutMs}ms) waiting for server health`);
      await sleep(300);
    }
  }

  try {
    console.log('[setup] booting server (node dist/src/main.js) …');
    serverProc = spawnServer();
    await waitHealthy(60000);
    console.log(`[setup] server healthy on :${CHAT_PORT}`);

    let ws = new WebSocket(`ws://127.0.0.1:${CHAT_PORT}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    // (a) channels 프레임에 brainNames·defaultBrain이 실려온다.
    const chFrame = await sendAndWait(ws, { t: 'channels' }, (f) => f.t === 'channels', 10000, 'initial channels frame');
    record('a', 'channels frame에 brainNames가 mockbrain을 포함', Array.isArray(chFrame.brainNames) && chFrame.brainNames.includes('mockbrain'), JSON.stringify(chFrame.brainNames));
    record('a', 'channels frame에 defaultBrain 문자열', typeof chFrame.defaultBrain === 'string' && chFrame.defaultBrain.length > 0, JSON.stringify(chFrame.defaultBrain));

    // 채널 A·B 생성
    const fA = await sendAndWait(ws, { t: 'createChannel', name: 'SmokeA' }, (f) => f.t === 'channels' && f.list.some((c: any) => c.name === 'SmokeA'), 10000, 'channel A created');
    const idA: string = fA.list.find((c: any) => c.name === 'SmokeA').id;
    const fB = await sendAndWait(ws, { t: 'createChannel', name: 'SmokeB' }, (f) => f.t === 'channels' && f.list.some((c: any) => c.name === 'SmokeB'), 10000, 'channel B created');
    const idB: string = fB.list.find((c: any) => c.name === 'SmokeB').id;
    console.log(`[setup] channels A=${idA} B=${idB}`);

    // (b) setChannelBrain B→mockbrain
    const fSet = await sendAndWait(ws, { t: 'setChannelBrain', id: idB, brain: 'mockbrain' }, (f) => f.t === 'channels', 10000, 'setChannelBrain(B, mockbrain) ack');
    const bAfterSet = fSet.list.find((c: any) => c.id === idB);
    const aAfterSet = fSet.list.find((c: any) => c.id === idA);
    record('b', 'B.brain=mockbrain으로 브로드캐스트', bAfterSet?.brain === 'mockbrain', JSON.stringify(bAfterSet));
    record('b', 'A는 brain 미설정 유지', aAfterSet?.brain === undefined, JSON.stringify(aAfterSet));

    // (c) 미등록 이름 'ghost' → 조용히 무시
    const fGhost = await sendAndWait(ws, { t: 'setChannelBrain', id: idB, brain: 'ghost' }, (f) => f.t === 'channels', 10000, 'setChannelBrain(B, ghost) ack');
    const bAfterGhost = fGhost.list.find((c: any) => c.id === idB);
    record('c', "미등록 'ghost' 지정은 무시됨(B는 mockbrain 유지)", bAfterGhost?.brain === 'mockbrain', JSON.stringify(bAfterGhost));

    // (d) null → 해제, 그 다음 다시 mockbrain
    const fNull = await sendAndWait(ws, { t: 'setChannelBrain', id: idB, brain: null }, (f) => f.t === 'channels', 10000, 'setChannelBrain(B, null) ack');
    const bAfterNull = fNull.list.find((c: any) => c.id === idB);
    record('d', 'brain:null → 필드 해제', bAfterNull?.brain === undefined, JSON.stringify(bAfterNull));
    const fReset = await sendAndWait(ws, { t: 'setChannelBrain', id: idB, brain: 'mockbrain' }, (f) => f.t === 'channels', 10000, 're-set(B, mockbrain) ack');
    const bAfterReset = fReset.list.find((c: any) => c.id === idB);
    record('d', '재지정 후 B.brain=mockbrain', bAfterReset?.brain === 'mockbrain', JSON.stringify(bAfterReset));

    // (e) 실 라우팅: B는 mockbrain 응답(마커 포함)을 받고, mock이 요청을 받는다. A는 mock에 트래픽이 없어야 한다.
    const reqBefore = mock.requestLog.length;
    let replyB: any;
    try {
      replyB = await sendAndWait(ws, { t: 'send', channelId: idB, text: '스모크 라우팅 확인 메시지' }, (f) => f.t === 'msg' && f.channelId === idB && f.message?.authorId === 'engram', 120000, 'B engram reply (첫 호출=RAG 임베더 콜드스타트 포함)');
      record('e', 'B 응답이 MOCKBRAIN-SAYS 포함', typeof replyB.message.text === 'string' && replyB.message.text.includes(MOCKBRAIN_SAYS), replyB.message.text?.slice(0, 200));
    } catch (err) {
      record('e', 'B 응답 수신(엔그램 reply)', false, String(err));
    }
    record('e', 'mock 서버가 B 처리 중 요청을 실제로 받음(≥1)', mock.requestLog.length > reqBefore, `before=${reqBefore} after=${mock.requestLog.length}`);

    const reqBeforeA = mock.requestLog.length;
    try {
      await sendAndWait(ws, { t: 'send', channelId: idA, text: '스모크 라우팅 확인 메시지 A' }, (f) => f.t === 'msg' && f.channelId === idA && f.message?.authorId === 'engram', 20000, 'A engram reply (기본 두뇌 — 오프라인 폴백 예상)');
    } catch {
      console.log('   [info] A 채널 응답 미수신(기본 두뇌가 존재하지 않는 CLI라 실패/타임아웃 — 정상, 라우팅 격리가 핵심 증거)');
    }
    record('e', 'A 처리 중 mock 서버에 새 요청 없음(기본 두뇌 사용 확인)', mock.requestLog.length === reqBeforeA, `before=${reqBeforeA} after=${mock.requestLog.length}`);

    // (f) 데드락 프로브: mock 첫 응답=ask_brain(mockbrain 자기자신) 툴콜, 이후=정상 완료.
    // 실제 요청 순서: classify(1) → reader turn1=툴콜(2) → reader turn2=정상완료(3).
    mock.queue.push({ type: 'content', text: '{"kind":"chat","team":[]}' }); // classify: chat으로 분류시켜 route()로 흘려보냄
    mock.queue.push({ type: 'toolCall', name: 'ask_brain', args: { brain: 'mockbrain', task: 'ping self' } }); // reader turn1
    mock.queue.push({ type: 'content', text: `${MOCKBRAIN_SAYS} after delegate reject` }); // reader turn2
    const reqBeforeF = mock.requestLog.length;
    let deadlockReply: any;
    let deadlockErr: unknown;
    try {
      deadlockReply = await sendAndWait(ws, { t: 'send', channelId: idB, text: '자기위임 데드락 프로브' }, (f) => f.t === 'msg' && f.channelId === idB && f.message?.authorId === 'engram', 60000, 'F 데드락 프로브 응답(60s 상한)');
    } catch (err) {
      deadlockErr = err;
    }
    record('f', '턴이 60s 안에 완료됨(행 없음)', !!deadlockReply, deadlockErr ? String(deadlockErr) : undefined);
    if (deadlockReply) {
      record('f', '최종 응답이 위임-이후 텍스트를 포함', typeof deadlockReply.message.text === 'string' && deadlockReply.message.text.includes('after delegate reject'), deadlockReply.message.text?.slice(0, 200));
    }
    const fReqs = mock.requestLog.slice(reqBeforeF);
    const toolResultReq = fReqs.find((r) =>
      (r.body.messages ?? []).some((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('unknown brain "mockbrain"')),
    );
    record(
      'f',
      '자기위임 거부 결과가 다음 요청의 tool 메시지로 왕복됨(그레이스풀 거부 증거)',
      !!toolResultReq,
      toolResultReq ? JSON.stringify((toolResultReq.body.messages ?? []).find((m) => m.role === 'tool')) : `요청 ${fReqs.length}건 중 못 찾음: ${JSON.stringify(fReqs.map((r) => r.body.messages?.map((m) => m.role)))}`,
    );

    // (g) 영속성: 서버 재시작 후에도 B.brain=mockbrain 유지.
    try { ws.close(); } catch { /* 격리 */ }
    await killProc(serverProc);
    console.log('[restart] server killed, respawning …');
    serverProc = spawnServer();
    await waitHealthy(60000);
    ws = new WebSocket(`ws://127.0.0.1:${CHAT_PORT}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const fRestart = await sendAndWait(ws, { t: 'channels' }, (f) => f.t === 'channels', 10000, 'channels after restart');
    const bAfterRestart = fRestart.list.find((c: any) => c.id === idB);
    record('g', '재시작 후에도 B.brain=mockbrain 영속', bAfterRestart?.brain === 'mockbrain', JSON.stringify(bAfterRestart));

    try { ws.close(); } catch { /* 격리 */ }
  } finally {
    await killProc(serverProc);
    await new Promise<void>((r) => mock.server.close(() => r()));
    if (serverErr.trim()) console.log('\n[server stderr(tail)]\n' + serverErr.slice(-4000));
    await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
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
