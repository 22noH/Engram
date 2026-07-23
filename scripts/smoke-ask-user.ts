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

// 실 스모크: 질문 카드(ask_user) 기능 — 두뇌 응답의 ```ask_user 펜스 블록이 진짜 서버 프로세스
// (node dist/src/main.js)를 거쳐 카드 게시(question 필드)로 바뀌고, ws 클라의 답(answersId)이
// 정상 재트리거·중복 차단·재시작 영속까지 전부 실증한다. 패턴은 scripts/smoke-channel-brain.ts 재사용.
// 우리 코드는 전혀 모킹하지 않는다 — 유일한 모킹은 openai-api 하네스가 말 거는 상대(외부 LLM API)뿐.
//
// 격리: ENGRAM_DATA_DIR를 임시 디렉터리로 못박아 실 사용자 데이터(%APPDATA%/engram)를 절대 건드리지 않는다.
// 모든 대기는 타임아웃 있음(하우스룰) — 무한 대기 없음. 자식 프로세스는 전부 'error' 리스너 보유.

const REPO_ROOT = path.resolve(__dirname, '..');
const CHAT_PORT = 47957; // 다른 스모크(47955 등)와 충돌 회피용 별도 포트

// 두뇌가 매 호출 항상 돌려주는 고정 응답 — 서두 문장 + ```ask_user 펜스 블록.
// classify()가 이 텍스트에서 JSON을 파싱해도 "kind" 키가 없어 기본 kind:'chat'으로 떨어진다(안전).
const ASK_USER_PAYLOAD = {
  questions: [
    {
      q: '정리 방식을 골라주세요',
      header: '정리 방식',
      options: [
        { label: '불릿 요약', desc: '짧고 간결하게', recommended: true },
        { label: '표로 정리' },
      ],
    },
  ],
};
const PREAMBLE = '몇 가지 확인이 필요해요.';
const FIXED_REPLY = `${PREAMBLE}\n\`\`\`ask_user\n${JSON.stringify(ASK_USER_PAYLOAD)}\n\`\`\``;

interface MockRequest {
  n: number;
  body: { messages?: Array<{ role: string; content?: string | null }> };
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

// ── HTTP 목(두뇌가 말 거는 상대). OpenAI 호환 chat/completions를 SSE로 흉내낸다.
// 매 요청 항상 FIXED_REPLY(ask_user 펜스 블록 포함)를 돌려준다 — classify든 route(reader)든 동일. ──
function createMockBrainServer(): { server: http.Server; port: number; requestLog: MockRequest[] } {
  const requestLog: MockRequest[] = [];
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
      const payload = { choices: [{ delta: { content: FIXED_REPLY } }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  server.on('error', (err) => console.error('[mock] server error', err));
  return { server, port: 0, requestLog };
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

// 부정 검증용: 프레임을 보내고 timeoutMs 동안 이 채널로 'msg' 프레임이 하나라도 오면 그걸 잡아서 돌려준다.
// 안 오면(무반응) got=undefined로 resolve — 무한대기 없음(고정 창).
function sendAndExpectSilence(ws: WebSocket, frame: unknown, channelId: string, timeoutMs: number): Promise<{ got?: any }> {
  return new Promise((resolve) => {
    let got: any;
    function onMsg(raw: Buffer | string): void {
      let f: any;
      try { f = JSON.parse(String(raw)); } catch { return; }
      if (f.t === 'msg' && f.channelId === channelId && !got) got = f;
    }
    ws.on('message', onMsg);
    ws.send(JSON.stringify(frame));
    setTimeout(() => {
      ws.off('message', onMsg);
      resolve({ got });
    }, timeoutMs);
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
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'engram-smoke-au-'));
  const configDir = path.join(base, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  const mock = createMockBrainServer();
  await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', () => resolve()));
  const addr = mock.server.address();
  mock.port = typeof addr === 'object' && addr ? addr.port : 0;
  console.log(`[setup] mockbrain http on 127.0.0.1:${mock.port}`);

  // brains.json: default=오프라인(존재하지 않는 CLI, DI 주입 BRAIN이 이걸 하드와이어로 쓴다) +
  // mockbrain=격리 목 서버(openai-api) — 채널에 setChannelBrain으로 명시 지정해야 provider가 실제로
  // 존중된다(주입 BRAIN은 brains.json의 provider와 무관하게 항상 ClaudeCliBrain, 기존 스모크 관례와 동일).
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

    const chFrame = await sendAndWait(ws, { t: 'channels' }, (f) => f.t === 'channels', 10000, 'initial channels frame');
    const general = chFrame.list.find((c: any) => c.id === 'general' || c.name === 'general');
    record('setup', "기본 채널 'general' 존재", !!general, JSON.stringify(chFrame.list?.map((c: any) => c.id)));
    const channelId: string = general ? general.id : 'general';

    // 이 채널을 mockbrain(격리 목 서버)으로 지정 — 주입 BRAIN(하드와이어 ClaudeCliBrain)을 우회.
    const fSet = await sendAndWait(ws, { t: 'setChannelBrain', id: channelId, brain: 'mockbrain' }, (f) => f.t === 'channels', 10000, 'setChannelBrain(general, mockbrain) ack');
    const afterSet = fSet.list.find((c: any) => c.id === channelId);
    record('setup', 'general 채널이 mockbrain으로 지정됨', afterSet?.brain === 'mockbrain', JSON.stringify(afterSet));

    // ① send "정리해줘" → 두뇌 응답(ask_user 펜스 블록)이 question 필드 달린 msg 프레임으로 게시됨.
    const reqBefore1 = mock.requestLog.length;
    const card = await sendAndWait(
      ws,
      { t: 'send', channelId, text: '정리해줘' },
      (f) => f.t === 'msg' && f.channelId === channelId && f.message?.authorId === 'engram' && !!f.message?.question,
      60000,
      '① 카드 게시(question 필드 달린 engram 메시지)',
    );
    record('1a', '카드 메시지가 question.questions 보유', Array.isArray(card.message.question?.questions) && card.message.question.questions.length === 1, JSON.stringify(card.message.question));
    const cardQ = card.message.question.questions[0];
    record('1b', '질문 텍스트·옵션 2개 보존', cardQ?.q === ASK_USER_PAYLOAD.questions[0].q && Array.isArray(cardQ?.options) && cardQ.options.length === 2, JSON.stringify(cardQ));
    record('1c', '카드 text에 펜스 블록(```ask_user)이 노출되지 않음', typeof card.message.text === 'string' && !card.message.text.includes('```ask_user') && !card.message.text.includes('"questions"'), card.message.text);
    const reqAfter1 = mock.requestLog.length;
    record('1d', '① 처리 중 mock 두뇌가 classify+route 2회 호출됨', reqAfter1 - reqBefore1 === 2, `before=${reqBefore1} after=${reqAfter1}`);
    const cardMsgId: string = card.message.id;

    // ② answersId 실어 답 send → 정상 브로드캐스트(사용자 답 메시지 저장) + 두뇌 재트리거(mock 호출 2회: classify+route).
    const reqBefore2 = mock.requestLog.length;
    const reply2 = await sendAndWait(
      ws,
      { t: 'send', channelId, text: '불릿 요약으로 해주세요', answersId: cardMsgId },
      (f) => f.t === 'msg' && f.channelId === channelId && f.message?.authorId === 'engram' && f.message?.id !== cardMsgId,
      60000,
      '② 답 이후 두뇌 재트리거 응답',
    );
    record('2a', '② 답변 후 새 engram 응답 수신(재트리거 증거)', !!reply2, JSON.stringify(reply2?.message?.id));
    const reqAfter2 = mock.requestLog.length;
    record('2b', '② 처리 중 mock 두뇌가 정확히 2회 호출됨(classify+route)', reqAfter2 - reqBefore2 === 2, `before=${reqBefore2} after=${reqAfter2}`);

    const hist2 = await sendAndWait(ws, { t: 'history', channelId }, (f) => f.t === 'history' && f.channelId === channelId, 10000, 'history after ②');
    const answerMsg = (hist2.messages as any[]).find((m) => m.answersId === cardMsgId);
    record('2c', 'history에 answersId===cardMsgId인 답 메시지가 정확히 1건', !!answerMsg && (hist2.messages as any[]).filter((m) => m.answersId === cardMsgId).length === 1, JSON.stringify(answerMsg));
    const histLenAfter2 = (hist2.messages as any[]).length;

    // ③ 같은 answersId 재전송 → 무반응(메시지 수 불변·mock 재호출 없음).
    const reqBefore3 = mock.requestLog.length;
    const { got: dupGot } = await sendAndExpectSilence(ws, { t: 'send', channelId, text: '같은 답 다시 보냄(중복)', answersId: cardMsgId }, channelId, 3000);
    record('3a', '③ 중복 answersId 재전송에 아무 msg 프레임도 오지 않음', !dupGot, dupGot ? JSON.stringify(dupGot) : undefined);
    const reqAfter3 = mock.requestLog.length;
    record('3b', '③ 중복 재전송이 mock 두뇌를 재호출하지 않음', reqAfter3 === reqBefore3, `before=${reqBefore3} after=${reqAfter3}`);

    const hist3 = await sendAndWait(ws, { t: 'history', channelId }, (f) => f.t === 'history' && f.channelId === channelId, 10000, 'history after ③');
    record('3c', '③ 이후 history 메시지 수 불변', (hist3.messages as any[]).length === histLenAfter2, `before=${histLenAfter2} after=${(hist3.messages as any[]).length}`);

    // ④ 서버 재시작 → history에 question·answersId 왕복 보존.
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
    const hist4 = await sendAndWait(ws, { t: 'history', channelId }, (f) => f.t === 'history' && f.channelId === channelId, 10000, 'history after restart');
    const cardAfterRestart = (hist4.messages as any[]).find((m) => m.id === cardMsgId);
    record('4a', '재시작 후 카드 메시지의 question이 왕복 보존', JSON.stringify(cardAfterRestart?.question) === JSON.stringify(card.message.question), JSON.stringify(cardAfterRestart?.question));
    const answerAfterRestart = (hist4.messages as any[]).find((m) => m.answersId === cardMsgId);
    record('4b', '재시작 후 답 메시지의 answersId가 왕복 보존', answerAfterRestart?.answersId === cardMsgId, JSON.stringify(answerAfterRestart));
    record('4c', '재시작 후에도 메시지 수 불변(중복 재전송이 실제로 무기록이었음을 재확인)', (hist4.messages as any[]).length === histLenAfter2, `expected=${histLenAfter2} actual=${(hist4.messages as any[]).length}`);

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
