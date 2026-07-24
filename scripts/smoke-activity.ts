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

// 실 스모크: 두뇌 활동 표시(brain-activity) — 실 서버 프로세스(node dist/src/main.js)를 거쳐 두뇌가
// 도구를 2회 쓰는 동안 휘발성 activity 프레임이 실시간으로 뜨고, 완료된 답에는 toolsUsed가 동봉되고,
// jsonl에는 activity 흔적이 전혀 없고(휘발 증거), 재시작 후에도 toolsUsed는 살아남는지(영속 증거)를
// 전부 실증한다. 패턴은 scripts/smoke-ask-user.ts 재사용(격리·waitFor·killProc 전부 동일 결).
//
// 두뇌 모킹 전략(문서화): "anthropic 호환" 대신 기존 스모크 관례인 openai-api 하네스(delta.tool_calls
// SSE)를 그대로 재사용한다 — anthropic-api·openai-api 둘 다 src/brain/tool-loop.ts의 같은 runToolLoop
// 를 거쳐 onTool을 발화하므로(activity 프레임 생성 경로는 provider 중립), 어느 쪽을 모킹해도 검증 대상
// (activity 프레임·toolsUsed 관통)은 완전히 동일하다. 기존에 실증된 SSE 모킹 패턴을 새로 짜지 않고 그대로
// 재사용하는 쪽이 더 단순하고 신뢰도가 높다(ponytail).
//
// 도구 선택(문서화): 실제 WEB_TOOL_DEFS 이름은 web_search/web_fetch다(plan 문서의 "fetch_url"은 존재하지
// 않는 이름 — tool-labels.ts의 KNOWN 매핑 키일 뿐, 실제 도구 정의는 아니다). web_search는 실행기가 항상
// 실 네트워크(DuckDuckGo 등)를 타 오프라인/네트워크 상태에 스모크가 좌우된다. 대신:
//   ①ask_brain — opts.delegate 미주입 상태라 runAskBrain이 즉시 동기 에러 문자열을 반환(네트워크 0,
//     tool-labels.ts KNOWN 매핑 보유 → 라벨 치환 경로 커버).
//   ②web_fetch — url을 사설 루프백(SSRF 가드 대상)으로 줘 isBlockedUrl이 네트워크 없이 즉시 차단
//     (KNOWN 매핑 없음 → "이름 그대로" 폴백 경로 커버).
// 둘 다 실제 도구 이름·실 실행기(executeWebTool/brain-tools.ts)를 그대로 타지만 네트워크에 전혀 기대지
// 않아 완전히 결정적이다. tool-loop의 onTool은 executeTool 성공/실패와 무관하게 항상 발화하므로 검증
// 목적(activity 프레임·toolsUsed)엔 영향이 없다.

const REPO_ROOT = path.resolve(__dirname, '..');
const CHAT_PORT = 47961; // 다른 스모크와 겹치지 않는 별도 포트

const FINAL_ANSWER = 'Checked with two tools, here is the summary.';

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

async function waitFor(pred: () => boolean, timeoutMs: number, label: string, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() >= deadline) throw new Error(`timeout(${timeoutMs}ms) waiting for ${label}`);
    await sleep(intervalMs);
  }
}

// ── HTTP 목(두뇌가 말 거는 상대). OpenAI 호환 chat/completions를 SSE로 흉내낸다.
// 호출 순번(n)에 따라 다른 응답: ①classify(평문, 도구 호출 없음) ②route 1턴(ask_brain 호출)
// ③route 2턴(web_fetch 호출) ④route 3턴(최종 텍스트, 도구 호출 없음 → 루프 종료). ──
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
      const n = requestLog.length + 1;
      requestLog.push({ n, body });

      let payload: Record<string, unknown>;
      if (n === 1) {
        // classify 호출 — 도구 호출 없는 평문(JSON 파싱 실패 → kind:'chat' 폴백, 정상 경로).
        payload = { choices: [{ delta: { content: '(chat)' } }] };
      } else if (n === 2) {
        payload = {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0, id: 'call_1', type: 'function',
                function: { name: 'ask_brain', arguments: JSON.stringify({ brain: 'other', task: 'help me' }) },
              }],
            },
          }],
        };
      } else if (n === 3) {
        payload = {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0, id: 'call_2', type: 'function',
                function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'http://127.0.0.1:9/blocked' }) },
              }],
            },
          }],
        };
      } else {
        // n===4(정상 경로) 및 그 이후(예상 밖 추가 호출 방어) 전부 최종 답으로 수렴 — 무한 도구루프 없음.
        payload = { choices: [{ delta: { content: FINAL_ANSWER } }] };
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  server.on('error', (err) => console.error('[mock] server error', err));
  return { server, port: 0, requestLog };
}

// ── ws 헬퍼(smoke-ask-user.ts와 동일 결): 프레임을 보내고 predicate에 맞는 응답을 기다린다. ──
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

// send 프레임을 보내고, 최종 프레임(matchFinal)이 올 때까지 도중에 지나가는 activity 프레임(matchSide)도
// 순서대로 전부 모아둔다 — 도착 즉시 소비되는 activity는 sendAndWait 하나로는 못 잡는다(휘발 프레임이라
// 최종 답이 온 뒤엔 재조회 불가).
function sendAndCollect(
  ws: WebSocket,
  sendFrame: unknown,
  matchSide: (f: any) => boolean,
  matchFinal: (f: any) => boolean,
  timeoutMs: number,
  label: string,
): Promise<{ final: any; side: any[] }> {
  return new Promise((resolve, reject) => {
    const side: any[] = [];
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timeout(${timeoutMs}ms) waiting for ${label} (collected ${side.length} side frames so far)`));
    }, timeoutMs);
    function onMsg(raw: Buffer | string): void {
      let f: any;
      try { f = JSON.parse(String(raw)); } catch { return; }
      if (matchSide(f)) side.push(f);
      if (matchFinal(f)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve({ final: f, side });
      }
    }
    ws.on('message', onMsg);
    ws.send(JSON.stringify(sendFrame));
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
        const { execSync } = await import('child_process');
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      } catch { /* 이미 죽었거나 taskkill 실패 — 무시 */ }
    }
  }
}

async function main(): Promise<void> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'engram-smoke-act-'));
  const configDir = path.join(base, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  // 격리: main.ts 부팅 시 mirrorClaudeMcp(paths.getConfigDir(), readClaudeMcpServers())가 실행돼
  // <home>/.claude.json(+설치된 플러그인의 .mcp.json)을 이 채널 두뇌의 configDir(mcp.json)로 그대로
  // 미러한다(클로드 MCP 패리티 기능, main.ts:86) — 이 머신의 진짜 홈에는 notion/vercel/context7 등
  // 실 MCP 서버가 잔뜩 등록돼 있어, 미러된 그 서버들에 매 brain.complete() 호출마다(McpSession.connect
  // 루프) 실제로 접속을 시도해 초 단위 지연·비결정성을 만든다(관찰: engram MCP만 10s 타임아웃).
  // readClaudeMcpServers는 os.homedir() 기준이라(third arg 없음) HOME/USERPROFILE을 빈 임시 폴더로
  // 가리키면 .claude.json이 없어 미러할 게 없다(빈 배열) — mock 두뇌 호출이 우리가 만든 mock 서버
  // 외의 어떤 외부 프로세스도 건드리지 않는다는 격리 보장이 완전해진다.
  const fakeHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'engram-smoke-act-home-'));

  const mock = createMockBrainServer();
  await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', () => resolve()));
  const addr = mock.server.address();
  mock.port = typeof addr === 'object' && addr ? addr.port : 0;
  console.log(`[setup] mockbrain http on 127.0.0.1:${mock.port}`);

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
    ENGRAM_CHAT_ROLE: 'brain', // 무인증 모드 — 기존 스모크 관례와 동일 결
    ENGRAM_CHAT_PORT: String(CHAT_PORT),
    ENGRAM_CHAT_BIND: '127.0.0.1',
    // ENGRAM_LANG 의도적 미설정 — configuredLang() 기본값 'en'에 라벨 기대값을 고정(결정적 검증).
    USERPROFILE: fakeHome, // Windows os.homedir() 근거 — 클로드 MCP 미러 격리(위 주석)
    HOME: fakeHome,        // POSIX 계열(os.homedir()) 대비 동시 세팅
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

    const fSet = await sendAndWait(ws, { t: 'setChannelBrain', id: channelId, brain: 'mockbrain' }, (f) => f.t === 'channels', 10000, 'setChannelBrain(general, mockbrain) ack');
    const afterSet = fSet.list.find((c: any) => c.id === channelId);
    record('setup', 'general 채널이 mockbrain으로 지정됨', afterSet?.brain === 'mockbrain', JSON.stringify(afterSet));

    // ① send → 두뇌가 도구 2회(ask_brain→web_fetch) 쓰는 동안 activity 프레임이 실시간으로 뜨고,
    // 최종 engram 메시지에 toolsUsed가 동봉된다.
    const { final: answerFrame, side: activityFrames } = await sendAndCollect(
      ws,
      { t: 'send', channelId, text: '도구 좀 써서 확인해줘' },
      (f) => f.t === 'activity' && f.channelId === channelId,
      (f) => f.t === 'msg' && f.channelId === channelId && f.message?.authorId === 'engram' && Array.isArray(f.message?.toolsUsed),
      60000,
      '① 도구 2회 사용 응답(activity 프레임 + toolsUsed 동봉)',
    );

    // ①-1: activity 프레임 ≥2, 순서대로 정확한 라벨(로케일 en 기본치) + 원시 이름 보유.
    record('1a', '① activity 프레임이 정확히 2건 수신됨', activityFrames.length === 2, `count=${activityFrames.length}`);
    const expectedLabels = [
      'Delegating to another model · ask_brain', // 매핑 도구(ask_brain, seq=1 — 서수 접미사 없음)
      'web_fetch · tool #2',                     // 미지 도구(web_fetch, seq=2 — "이름 그대로" + 서수 접미사)
    ];
    record(
      '1b',
      '① activity 라벨이 순서대로 정확히 일치(로케일 en 기본치)',
      JSON.stringify(activityFrames.map((f: any) => f.label)) === JSON.stringify(expectedLabels),
      JSON.stringify(activityFrames.map((f: any) => f.label)),
    );
    record(
      '1c',
      '① activity 프레임에 원시 도구 이름이 라벨 문자열 안에 그대로 보존됨(ask_brain·web_fetch)',
      activityFrames.every((f: any, i: number) => f.label.includes(['ask_brain', 'web_fetch'][i])),
      JSON.stringify(activityFrames.map((f: any) => f.label)),
    );

    // ①-2: 최종 msg의 toolsUsed가 정확한 이름·순서.
    record(
      '1d',
      '① 최종 engram 메시지의 toolsUsed가 정확히 ["ask_brain","web_fetch"]',
      JSON.stringify(answerFrame.message.toolsUsed) === JSON.stringify(['ask_brain', 'web_fetch']),
      JSON.stringify(answerFrame.message.toolsUsed),
    );
    record('1e', '① 최종 답 텍스트 보존', typeof answerFrame.message.text === 'string' && answerFrame.message.text.includes(FINAL_ANSWER), answerFrame.message.text);
    record('1f', '① mock 두뇌가 정확히 4회 호출됨(classify+도구턴2+최종턴)', mock.requestLog.length === 4, `count=${mock.requestLog.length}`);
    const answerMsgId: string = answerFrame.message.id;

    // ② jsonl 파일에 activity 흔적이 전혀 없음(휘발성 증거 — appendMessage를 거치지 않는 별도 브로드캐스트 경로).
    const jsonlPath = path.join(base, 'state', 'chat', `${channelId}.jsonl`);
    const jsonlRaw = fs.readFileSync(jsonlPath, 'utf8');
    const jsonlLines = jsonlRaw.split('\n').filter((l) => l.trim().length > 0);
    record('2a', '② jsonl 파일이 존재하고 최소 1줄 이상(메시지 저장 자체는 정상)', jsonlLines.length > 0, `lines=${jsonlLines.length}`);
    record('2b', '② jsonl 원문에 activity 문자열이 전혀 없음(휘발 증거)', !jsonlRaw.includes('activity'), jsonlRaw.length > 500 ? jsonlRaw.slice(0, 500) + '…' : jsonlRaw);
    const parsedLines = jsonlLines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
    record('2c', "② 모든 jsonl 줄이 파싱 가능하고 t:'activity' 필드를 가진 줄이 0건", parsedLines.every((m) => m !== null) && parsedLines.filter((m: any) => m?.t === 'activity').length === 0, `parsed=${parsedLines.length}`);
    const savedAnswer = parsedLines.find((m: any) => m?.id === answerMsgId);
    record('2d', '② jsonl에 저장된 답 메시지의 toolsUsed도 정확히 왕복 보존', JSON.stringify(savedAnswer?.toolsUsed) === JSON.stringify(['ask_brain', 'web_fetch']), JSON.stringify(savedAnswer?.toolsUsed));

    // ③ 서버 재시작 → history에 toolsUsed 왕복 보존.
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
    const hist = await sendAndWait(ws, { t: 'history', channelId }, (f) => f.t === 'history' && f.channelId === channelId, 10000, 'history after restart');
    const answerAfterRestart = (hist.messages as any[]).find((m) => m.id === answerMsgId);
    record('3a', '③ 재시작 후 답 메시지가 history에 존재', !!answerAfterRestart, JSON.stringify(answerAfterRestart?.id));
    record(
      '3b',
      '③ 재시작 후 toolsUsed가 정확히 왕복 보존(["ask_brain","web_fetch"])',
      JSON.stringify(answerAfterRestart?.toolsUsed) === JSON.stringify(['ask_brain', 'web_fetch']),
      JSON.stringify(answerAfterRestart?.toolsUsed),
    );

    try { ws.close(); } catch { /* 격리 */ }
  } finally {
    await killProc(serverProc);
    await new Promise<void>((r) => mock.server.close(() => r()));
    if (serverErr.trim()) console.log('\n[server stderr(tail)]\n' + serverErr.slice(-4000));
    await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(fakeHome, { recursive: true, force: true }).catch(() => {});
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
