/**
 * AI 웹 조작(2단계) 실기(Electron) 검증 — 스펙 2026-07-25 §검증 "실기 확인 필수".
 *
 * 단위 테스트로는 절대 확인할 수 없는 것만 본다:
 *   ① 채널 정체성 바인딩 — MCP 도구 호출이 **그 채널의 화면**에만 닿는가(두 채널 동시)
 *   ② _channel 없는 호출은 아무것도 조작하지 않는가(추측 금지)
 *   ③ 스폰 env(ENGRAM_CHANNEL_ID) → 실제 mcp-bridge 프로세스 → 상주까지 정체성이 흐르는가
 *   ④ 실제 페이지에서 읽기·클릭·입력이 진짜 동작하는가(DOM이 실제로 바뀌는가)
 *   ⑤ 콘솔 오류를 두뇌가 읽는가(자가 수정 순환의 재료)
 *   ⑥ 비밀번호 칸 입력이 차단되는가(하드 규칙) — 그리고 값이 실제로 안 들어갔는가
 *   ⑦ 확인 단계: 외부 사이트 조작은 확인 줄이 뜨고, 허용해야만 실행되는가
 *   ⑧ 조작 허용 끄기 = 전면 거절
 *   ⑨ 스크린샷 파일이 실제로 생기는가
 *   ⑩ 이동 게이트 — 페이지 안 링크로 외부에 나가는 것을 메인이 막는가(1단계 잔여 구멍)
 *
 * 격리: ENGRAM_USERDATA_DIR(임시) + ENGRAM_CHAT_PORT(빈 포트) + ENGRAM_OPEN_CHAT=1.
 * 사용자의 설치판은 절대 건드리지 않는다.
 *
 * 실행: npx ts-node scripts/smoke-ai-browser.ts   (사전: npm run build && npm --prefix renderer run build)
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

function getJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// ---- 테스트용 페이지(진짜 로그인 폼: 평범한 칸 + 비밀번호 칸 + 콘솔 오류 + 외부 링크) ----
const PAGE = `<!doctype html><meta charset="utf-8"><title>Login smoke</title>
<h1>Sign in</h1>
<form id="f" onsubmit="return false">
  <input id="email" type="email" name="email" placeholder="Email" />
  <input id="pw" type="password" name="password" placeholder="Password" />
  <button id="go" type="button">Sign in</button>
</form>
<a id="ext" href="https://example.com/">Go to example.com</a>
<div id="out">idle</div>
<script>
  console.error("Cannot read property 'name' of undefined");
  document.getElementById('go').addEventListener('click', function () {
    document.getElementById('out').textContent = 'clicked:' + document.getElementById('email').value;
  });
  fetch('/data.json').catch(function(){});
</script>`;

function startPageServer(port: number): http.Server {
  const srv = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/data.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  srv.listen(port, '127.0.0.1');
  return srv;
}

/** 렌더러(채팅 창)에 붙어 임의의 JS를 돌리는 최소 CDP 클라이언트(smoke-dock.ts와 동형). */
class Cdp {
  private ws!: WebSocket;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  static async attach(port: number, match: (t: any) => boolean, timeoutMs = 240_000): Promise<Cdp> {
    const deadline = Date.now() + timeoutMs;
    let lastSeen = '';
    while (Date.now() < deadline) {
      try {
        const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
        lastSeen = targets.map((t: any) => `${t.type} ${t.url?.slice(0, 60)}`).join(' | ');
        const t = targets.find(match);
        if (t?.webSocketDebuggerUrl) {
          const c = new Cdp();
          await c.connect(t.webSocketDebuggerUrl);
          return c;
        }
      } catch { /* 아직 안 떴다 */ }
      await sleep(700);
    }
    throw new Error(`CDP 대상 못 찾음(마지막 목록: ${lastSeen})`);
  }

  private connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      });
    });
  }

  send(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} 응답 없음(60s)`)); }, 60_000);
    });
  }

  async eval<T = unknown>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 실패');
    return r.result.value as T;
  }

  close(): void { try { this.ws.close(); } catch { /* 무시 */ } }
}

/** 백엔드에 WS로 코드 채널을 만들고 폴더를 묶는다(사람이 UI로 하는 것과 같은 프레임). */
function makeCodeChannels(chatPort: number, repoPath: string, names: string[]): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${chatPort}`);
    const ids: Record<string, string> = {};
    const timer = setTimeout(() => { ws.close(); reject(new Error('채널 생성 타임아웃')); }, 30_000);
    ws.on('open', () => { for (const n of names) ws.send(JSON.stringify({ t: 'createChannel', name: n, mode: 'code' })); });
    ws.on('message', (raw) => {
      let f: any;
      try { f = JSON.parse(String(raw)); } catch { return; }
      if (f.t !== 'channels') return;
      for (const n of names) {
        const ch = (f.list ?? []).find((c: any) => c.name === n);
        if (ch && !ids[n]) { ids[n] = ch.id; ws.send(JSON.stringify({ t: 'setRepoPath', id: ch.id, repoPath })); }
      }
      if (Object.keys(ids).length === names.length) {
        setTimeout(() => { clearTimeout(timer); ws.close(); resolve(ids); }, 1200);
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** 상주의 /mcp에 붙어 browser_* 도구를 부르는 클라이언트(= 두뇌가 MCP로 부르는 것과 같은 경로). */
async function mcpClient(chatPort: number): Promise<Client> {
  const c = new Client({ name: 'smoke', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${chatPort}/mcp`)));
  return c;
}

function textOf(r: any): string {
  return (r?.content ?? []).map((x: any) => x.text ?? '').join('\n');
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`);
}

async function main(): Promise<void> {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-aib-'));
  const chatPort = await freePort();
  const cdpPort = await freePort();
  const pagePort = await freePort();
  const pageUrl = `http://localhost:${pagePort}/`;
  console.log(`[harness] userData=${userData} chatPort=${chatPort} cdpPort=${cdpPort} page=${pageUrl}`);
  const pageServer = startPageServer(pagePort);

  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(
    fs.existsSync(electron) ? electron : 'npx',
    (fs.existsSync(electron) ? [] : ['electron']).concat(['.', `--remote-debugging-port=${cdpPort}`]),
    {
      cwd: ROOT,
      env: { ...process.env, ENGRAM_USERDATA_DIR: userData, ENGRAM_CHAT_PORT: String(chatPort), ENGRAM_OPEN_CHAT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  let cdp: Cdp | null = null;
  let mcp: Client | null = null;
  try {
    cdp = await Cdp.attach(cdpPort, (t) => t.type === 'page' && String(t.url).includes('renderer/dist/index.html'));
    console.log('[harness] 채팅 렌더러에 붙었다');

    const ids = await makeCodeChannels(chatPort, ROOT, ['aib-one', 'aib-two']);
    console.log(`[harness] 채널: ${JSON.stringify(ids)}`);

    // 렌더러 조작 헬퍼 + 코드 채널 aib-one을 열고 브라우저 칸을 띄운다.
    await cdp.eval(`
      window.__click = (el) => { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); el.click(); };
      window.__wait = async (fn, ms = 15000) => { const end = Date.now() + ms;
        while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
        throw new Error('타임아웃: ' + fn.toString().slice(0, 90)); };
      return 1;
    `);
    const opened = await cdp.eval<string>(`
      const codeTab = await window.__wait(() => Array.from(document.querySelectorAll('*'))
        .find((e) => e.children.length === 0 && e.textContent === 'Code'));
      window.__click(codeTab);
      const chan = await window.__wait(() => Array.from(document.querySelectorAll('#channels .ch'))
        .find((e) => /aib-one/.test(e.textContent || '')), 25000);
      window.__click(chan);
      const icons = await window.__wait(() => document.querySelectorAll('.chhdrIcons .codeIconBtn').length === 3
        && document.querySelectorAll('.chhdrIcons .codeIconBtn'));
      window.__click(icons[1]); // 브라우저 칸
      await window.__wait(() => document.querySelector('.dockBrowser'));
      return JSON.stringify({ panes: document.querySelectorAll('.dockPane').length });
    `);
    check('준비: 코드 채널 aib-one에서 독 브라우저 칸이 열렸다', JSON.parse(opened).panes >= 1, opened);

    mcp = await mcpClient(chatPort);
    const tools = await mcp.listTools();
    const names = tools.tools.map((t) => t.name).filter((n) => n.startsWith('browser_'));
    check('browser 도구 7종이 /mcp에 노출된다', names.length === 7, names.join(','));

    const A = ids['aib-one'];
    const B = ids['aib-two'];
    const call = (name: string, args: Record<string, unknown>) =>
      mcp!.callTool({ name, arguments: args }).then((r) => ({ text: textOf(r), isError: !!r.isError }));

    // ② _channel 없는 호출 — 아무것도 조작하지 않는다
    const noChan = await call('browser_navigate', { url: pageUrl });
    check('② _channel 없는 MCP 호출은 조작 없이 정직하게 실패', noChan.isError && /no channel identity/.test(noChan.text), noChan.text);

    // ① 채널 바인딩 — B(창에 안 열린 채널)로 조작하면 A의 화면이 절대 안 바뀐다
    const beforeUrl = await cdp.eval<string>(`
      const v = document.querySelector('.dockViews webview.active');
      try { return v ? v.getURL() : ''; } catch { return ''; }
    `);
    const wrongChan = await call('browser_navigate', { url: pageUrl, _channel: B });
    const afterWrong = await cdp.eval<string>(`
      const v = document.querySelector('.dockViews webview.active');
      try { return v ? v.getURL() : ''; } catch { return ''; }
    `);
    check('① 다른 채널(B)의 조작은 A 화면을 건드리지 않는다',
      wrongChan.isError && afterWrong === beforeUrl, `${wrongChan.text} / url=${afterWrong}`);

    // ④ 이동 → 읽기 → 클릭 → 입력(진짜 DOM이 바뀌는가)
    const nav = await call('browser_navigate', { url: pageUrl, _channel: A });
    await sleep(2500);
    check('④-a browser_navigate — 실제 페이지가 열린다', !nav.isError, nav.text);
    const loaded = await cdp.eval<string>(`
      const v = await window.__wait(() => {
        const w = document.querySelector('.dockViews webview.active');
        try { return w && w.getURL().indexOf('localhost:${pagePort}') !== -1 ? w : null; } catch { return null; }
      }, 20000);
      return v.getURL();
    `);
    check('④-b 그 주소가 브라우저 칸에 실제로 로드됐다', loaded.includes(`localhost:${pagePort}`), loaded);

    const read = await call('browser_read', { _channel: A });
    check('④-c browser_read — 본문 + 조작 가능한 요소·선택자를 돌려준다',
      !read.isError && /Sign in/.test(read.text) && /#email/.test(read.text) && /#go/.test(read.text),
      read.text.replace(/\n/g, ' ').slice(0, 200));

    const typed = await call('browser_type', { target: '#email', text: 'test@a.com', _channel: A });
    const emailVal = await cdp.eval<string>(`
      const v = document.querySelector('.dockViews webview.active');
      return await v.executeJavaScript('document.getElementById("email").value');
    `);
    check('④-d browser_type — 평범한 칸엔 값이 실제로 들어간다', !typed.isError && emailVal === 'test@a.com', `${typed.text} / value=${emailVal}`);

    const clicked = await call('browser_click', { target: 'text=Sign in', _channel: A });
    await sleep(400);
    const out = await cdp.eval<string>(`
      const v = document.querySelector('.dockViews webview.active');
      return await v.executeJavaScript('document.getElementById("out").textContent');
    `);
    check('④-e browser_click — 페이지가 실제로 반응한다(핸들러 실행)',
      !clicked.isError && out === 'clicked:test@a.com', `${clicked.text} / out=${out}`);

    // ⑥ 비밀번호 칸 — 차단 + 값이 실제로 안 들어감
    const pw = await call('browser_type', { target: '#pw', text: 'hunter2', _channel: A });
    const pwVal = await cdp.eval<string>(`
      const v = document.querySelector('.dockViews webview.active');
      return await v.executeJavaScript('document.getElementById("pw").value');
    `);
    check('⑥ 비밀번호 칸 입력 차단 + 값이 실제로 안 들어갔다',
      pw.isError && /never types sign-in credentials/.test(pw.text) && pwVal === '', `${pw.text} / value="${pwVal}"`);

    // ⑤ 콘솔 — 페이지가 낸 오류를 두뇌가 읽는다
    const con = await call('browser_console', { _channel: A });
    check('⑤ browser_console — 페이지 콘솔 오류를 그대로 읽는다',
      !con.isError && /Cannot read property 'name'/.test(con.text), con.text.slice(0, 160));

    // 네트워크
    const netRes = await call('browser_network', { _channel: A });
    check('browser_network — 요청 목록을 돌려준다', !netRes.isError && /data\.json|localhost/.test(netRes.text), netRes.text.slice(0, 160));

    // ⑨ 스크린샷 — 실제 파일이 생긴다.
    // ★실측: 창이 가려져 있으면 capturePage()가 영원히 안 풀린다(프레임이 안 그려진다) — 사람이
    // 보고 있는 상태와 같게 창을 앞으로 꺼내고 확인한다. 가려진 경우는 8초 뒤 명확한 안내로 끊긴다.
    await cdp.send('Page.bringToFront');
    await sleep(600);
    const shot = await call('browser_screenshot', { _channel: A }).catch((e) => ({ text: `CALL-FAILED ${String(e)}`, isError: true }));
    console.log('[diag] alive after shot:', await cdp.eval('return "yes"').catch((e) => `renderer stuck: ${String(e)}`));
    console.log('[diag] log rows:', await cdp.eval(`
      return JSON.stringify(Array.from(document.querySelectorAll('.dockAgentLogRow')).map((r) => r.textContent).slice(-4));
    `).catch(() => 'n/a'));
    const shotPath = (/screenshot saved: (.+)$/m.exec(shot.text) ?? [])[1]?.trim();
    check('⑨ browser_screenshot — PNG 파일이 실제로 생성된다',
      !!shotPath && fs.existsSync(shotPath) && fs.statSync(shotPath).size > 1000, shot.text);

    // ③ 스폰 env → 실제 mcp-bridge 프로세스 → 상주(채널 정체성이 프로세스 경계를 넘는가)
    const bridge = new Client({ name: 'smoke-bridge', version: '1.0.0' });
    await bridge.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'dist', 'src', 'mcp-bridge.js'), '--port', String(chatPort)],
      env: { ...process.env, ENGRAM_CHANNEL_ID: A } as Record<string, string>,
    }));
    const viaBridge = await bridge.callTool({ name: 'browser_read', arguments: {} });
    check('③ 스폰 env(ENGRAM_CHANNEL_ID) → 실제 브리지 프로세스 → 그 채널 화면',
      !viaBridge.isError && /Sign in/.test(textOf(viaBridge)), textOf(viaBridge).replace(/\n/g, ' ').slice(0, 160));
    const bridgeNoEnv = new Client({ name: 'smoke-bridge2', version: '1.0.0' });
    await bridgeNoEnv.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'dist', 'src', 'mcp-bridge.js'), '--port', String(chatPort)],
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ENGRAM_CHANNEL_ID')) as Record<string, string>,
    }));
    const noEnv = await bridgeNoEnv.callTool({ name: 'browser_click', arguments: { target: '#go' } });
    check('③-b env 없는 브리지(사람이 직접 띄운 MCP)는 조작하지 않는다',
      !!noEnv.isError && /no channel identity/.test(textOf(noEnv)), textOf(noEnv).slice(0, 160));
    await bridge.close();
    await bridgeNoEnv.close();

    // ⑦ 확인 단계 — 외부 사이트는 확인 줄이 뜨고, 허용해야만 실행된다.
    // (외부 접속 없이 검증하려고 '매번 묻기'로 바꿔 localhost에서 확인 줄을 띄운다.)
    await cdp.eval(`
      const p = JSON.parse(localStorage.getItem('engram.dock.prefs') || '{}');
      p.confirmMode = 'ask'; p.agentEnabled = true;
      localStorage.setItem('engram.dock.prefs', JSON.stringify(p));
      return 1;
    `);
    const pendingClick = call('browser_click', { target: '#go', _channel: A });
    await sleep(1200);
    // 버튼 문구는 앱 로케일을 따른다(한국어 환경이면 허용/건너뛰기) — 문구가 아니라 구조로 본다.
    const bar = await cdp.eval<string>(`
      const b = document.querySelector('.dockAgentBar');
      return JSON.stringify({ text: b ? b.textContent : '', buttons: b ? b.querySelectorAll('button').length : 0 });
    `);
    const barObj = JSON.parse(bar);
    check('⑦-a 확인 줄(🤖)이 뜨고 조작이 대기한다',
      /Click/.test(barObj.text) && barObj.buttons === 2, bar);
    await cdp.eval(`
      const btns = document.querySelectorAll('.dockAgentBar button');
      window.__click(btns[btns.length - 1]); // 허용
      return 1;
    `);
    const afterAllow = await pendingClick;
    check('⑦-b [허용]을 누르면 그제서야 실행된다', !afterAllow.isError, afterAllow.text.slice(0, 120));

    const pendingSkip = call('browser_click', { target: '#go', _channel: A });
    await sleep(1000);
    await cdp.eval(`
      const btns = document.querySelectorAll('.dockAgentBar button');
      window.__click(btns[0]); // 건너뛰기
      return 1;
    `);
    const skipped = await pendingSkip;
    check('⑦-c [건너뛰기]를 누르면 실행되지 않는다', skipped.isError && /skipped/.test(skipped.text), skipped.text.slice(0, 120));

    // 행동 로그가 실제로 남았는가
    const logRows = await cdp.eval<string>(`
      const rows = Array.from(document.querySelectorAll('.dockAgentLogRow')).map((r) => r.className);
      return JSON.stringify({ statuses: rows, n: rows.length });
    `);
    const lr = JSON.parse(logRows);
    check('행동 로그에 성공·차단·건너뛰기가 모두 남는다(사후 추적)',
      lr.statuses.some((c: string) => c.includes('ok'))
      && lr.statuses.some((c: string) => c.includes('blocked'))
      && lr.statuses.some((c: string) => c.includes('skipped')), logRows);

    // ⑧ 조작 허용 끄기 = 전면 거절
    await cdp.eval(`
      const p = JSON.parse(localStorage.getItem('engram.dock.prefs') || '{}');
      p.agentEnabled = false; p.confirmMode = 'auto';
      localStorage.setItem('engram.dock.prefs', JSON.stringify(p));
      return 1;
    `);
    const offRes = await call('browser_click', { target: '#go', _channel: A });
    check('⑧ "조작 허용" 끄면 전부 거절된다', offRes.isError && /turned off/.test(offRes.text), offRes.text.slice(0, 140));
    await cdp.eval(`
      const p = JSON.parse(localStorage.getItem('engram.dock.prefs') || '{}');
      p.agentEnabled = true; p.confirmMode = 'local';
      localStorage.setItem('engram.dock.prefs', JSON.stringify(p));
      return 1;
    `);

    // ⑩ 이동 게이트 — 페이지 안 링크로 외부에 나가려는 시도를 메인이 막는다(1단계 잔여 구멍)
    const navGate = await cdp.eval<string>(`
      const v = document.querySelector('.dockViews webview.active');
      const before = v.getURL();
      await v.executeJavaScript('document.getElementById("ext").click()');
      await new Promise((r) => setTimeout(r, 2500));
      const after = v.getURL();
      const warn = Array.from(document.querySelectorAll('.dockBar.warn')).map((e) => e.textContent).join(' | ');
      return JSON.stringify({ before, after, warn });
    `);
    const ng = JSON.parse(navGate);
    check('⑩-a 허용 목록 밖 링크 클릭 — 이동이 차단된다', ng.after === ng.before, `${ng.before} → ${ng.after}`);
    check('⑩-b 차단 사실을 사용자에게 알린다(조용한 차단 금지)', /example\.com/.test(ng.warn), ng.warn);
  } catch (e) {
    check('하네스 자체 실패', false, e instanceof Error ? e.message : String(e));
  } finally {
    try { await mcp?.close(); } catch { /* 무시 */ }
    cdp?.close();
    child.kill();
    await sleep(1500);
    pageServer.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) {
    console.log(failed.map((f) => `FAIL ${f.name} — ${f.detail}`).join('\n'));
    console.log('\n--- electron log tail ---\n' + log.slice(-2500));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
