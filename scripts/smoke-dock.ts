/**
 * 코드 독 패널 실기(Electron) 검증 — 스펙 2026-07-25 §검증의 "실기 확인 필수" 항목.
 *
 * jsdom 테스트로는 절대 확인할 수 없는 것만 본다:
 *   ① <webview>가 실제로 붙고 로드되는가(webviewTag가 채팅 창에 켜졌는가)
 *   ② 뒤로/앞으로가 진짜 동작하는가(iframe으로는 원천 불가했던 것)
 *   ③ 파티션 분리 — 게스트가 앱의 localStorage/preload 브리지에 못 닿는가
 *   ④ 안전 설정 강제 — nodeIntegration off·팝업 차단
 *   ⑤ 로컬 파일(file://) 로드
 *   ⑥ 두 칸(webview 2개) 동시 렌더
 *   ⑦ 종료 후 pty 고아 0
 *
 * 격리: ENGRAM_USERDATA_DIR(임시 폴더) + ENGRAM_CHAT_PORT(빈 포트) + ENGRAM_OPEN_CHAT=1.
 * 사용자의 실행 중인 설치판은 절대 건드리지 않는다(단일 인스턴스 락도 별도 userData라 무관).
 *
 * 실행: npx ts-node scripts/smoke-dock.ts
 */
import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import WebSocket from 'ws';

const ROOT = path.resolve(__dirname, '..');

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// 윈도우: 지금 살아있는 powershell.exe PID 집합(고아 검사용).
function shellPids(): Set<string> {
  if (process.platform !== 'win32') return new Set();
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq powershell.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
    return new Set(out.split('\n').map((l) => l.split('","')[1]).filter(Boolean));
  } catch { return new Set(); }
}

/** 렌더러(채팅 창)에 붙어 임의의 JS를 돌리는 최소 CDP 클라이언트. */
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
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} 응답 없음(60s)`));
      }, 60_000);
    });
  }

  /** await 가능한 JS 표현식을 렌더러에서 평가하고 값을 돌려준다. */
  async eval<T = unknown>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 실패');
    return r.result.value as T;
  }

  close(): void { try { this.ws.close(); } catch { /* 무시 */ } }
}

/**
 * 백엔드에 WS로 코드 채널 하나를 만들고 폴더를 묶는다(사람이 UI로 하는 것과 같은 프레임).
 * 그리고 그 채널에 html 코드펜스 메시지를 하나 남긴다 — "크게 보기" 카드가 뜨게.
 */
function makeCodeChannel(chatPort: number, repoPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${chatPort}`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('채널 생성 타임아웃')); }, 30_000);
    let created = false;
    ws.on('open', () => ws.send(JSON.stringify({ t: 'createChannel', name: 'dock-smoke', mode: 'code' })));
    ws.on('message', (raw) => {
      let f: any;
      try { f = JSON.parse(String(raw)); } catch { return; }
      if (f.t !== 'channels' || created) return;
      const ch = (f.list ?? []).find((c: any) => c.name === 'dock-smoke');
      if (!ch) return;
      created = true;
      ws.send(JSON.stringify({ t: 'setRepoPath', id: ch.id, repoPath }));
      // HTML 카드가 뜨도록 메시지 한 줄(두뇌를 부르지 않게 respondMode는 건드리지 않는다).
      ws.send(JSON.stringify({ t: 'send', channelId: ch.id, text: '```html\n<h1>dock smoke</h1>\n```' }));
      setTimeout(() => { clearTimeout(timer); ws.close(); resolve(); }, 1500);
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-dock-'));
  const chatPort = await freePort();
  const cdpPort = await freePort();
  const beforeShells = shellPids();
  console.log(`[harness] userData=${userData} chatPort=${chatPort} cdpPort=${cdpPort}`);

  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(
    fs.existsSync(electron) ? electron : 'npx',
    (fs.existsSync(electron) ? [] : ['electron']).concat(['.', `--remote-debugging-port=${cdpPort}`]),
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ENGRAM_USERDATA_DIR: userData,
        ENGRAM_CHAT_PORT: String(chatPort),
        ENGRAM_OPEN_CHAT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  let cdp: Cdp | null = null;
  try {
    // 채팅 창의 렌더러(file:// index.html)에 붙는다 — 자식(백엔드)이 리슨할 때까지 기다린다.
    cdp = await Cdp.attach(cdpPort, (t) => t.type === 'page' && String(t.url).includes('renderer/dist/index.html'));
    console.log('[harness] 채팅 렌더러에 붙었다');

    // ① webviewTag가 채팅 창에 켜져 있는가 + 실제 로드
    const appUrl = `http://127.0.0.1:${chatPort}/`;
    const setup = await cdp.eval<string>(`
      window.__mk = (partition, src) => new Promise((resolve) => {
        const v = document.createElement('webview');
        v.setAttribute('partition', partition);
        v.setAttribute('webpreferences', 'contextIsolation=yes,nodeIntegration=no,sandbox=yes');
        v.style.cssText = 'position:absolute;left:0;top:0;width:400px;height:300px';
        v.src = src;
        v.addEventListener('dom-ready', () => resolve(v), { once: true });
        document.body.appendChild(v);
      });
      const v = await window.__mk('engram-preview', ${JSON.stringify(appUrl)});
      window.__v = v;
      return typeof v.loadURL === 'function' ? 'upgraded:' + v.getURL() : 'NOT-UPGRADED';
    `);
    check('① webviewTag 켜짐 + webview 실제 로드', setup.startsWith('upgraded:'), setup);

    // ② 뒤로/앞으로 — iframe으로는 원천 불가했던 것
    const nav = await cdp.eval<string>(`
      const v = window.__v;
      const wait = (ev) => new Promise((r) => v.addEventListener(ev, r, { once: true }));
      const p = wait('did-navigate');
      v.loadURL(${JSON.stringify(appUrl + 'chat.html')});
      await p;
      const second = v.getURL();
      const back = wait('did-navigate');
      v.goBack();
      await back;
      const afterBack = v.getURL();
      const fwd = wait('did-navigate');
      v.goForward();
      await fwd;
      return JSON.stringify({ second, afterBack, afterForward: v.getURL(), canGoBack: v.canGoBack() });
    `);
    const navObj = JSON.parse(nav);
    check('② 뒤로/앞으로가 실제로 동작', navObj.afterBack === appUrl && navObj.afterForward === navObj.second, nav);

    // ③ 파티션 분리 — 앱 페이지와 같은 file:// 문서를 게스트로 띄워도 앱 저장소가 안 보인다
    const iso = await cdp.eval<string>(`
      localStorage.setItem('__dockProbe', 'app-only');
      const appFile = location.href;
      const g = await window.__mk('engram-preview', appFile);
      const seen = await g.executeJavaScript('localStorage.getItem("__dockProbe")');
      const bridge = await g.executeJavaScript('typeof window.engramDesktop');
      g.remove();
      return JSON.stringify({ seen, bridge });
    `);
    const isoObj = JSON.parse(iso);
    check('③ 파티션 분리 — 앱 localStorage·preload 브리지 미노출',
      isoObj.seen === null && isoObj.bridge === 'undefined', iso);

    // ④ 안전 설정 강제 — nodeIntegration off · 팝업 차단
    const safety = await cdp.eval<string>(`
      const v = window.__v;
      const req = await v.executeJavaScript('typeof require');
      const proc = await v.executeJavaScript('typeof process');
      const popup = await v.executeJavaScript('String(window.open("https://example.com/"))');
      return JSON.stringify({ req, proc, popup });
    `);
    const safeObj = JSON.parse(safety);
    check('④ nodeIntegration off(require/process 없음) + 팝업 차단',
      safeObj.req === 'undefined' && safeObj.proc === 'undefined' && safeObj.popup === 'null', safety);

    // ⑤ 로컬 파일(file://) — iframe이 못 하던 것
    const localFile = path.join(userData, 'dock-probe.html');
    fs.writeFileSync(localFile, '<title>DOCKFILE</title><h1>local</h1>', 'utf8');
    const fileUrl = 'file:///' + localFile.replace(/\\/g, '/').replace(/^\/+/, '');
    const fileRes = await cdp.eval<string>(`
      const v = await window.__mk('engram-preview', ${JSON.stringify(fileUrl)});
      const t = await v.executeJavaScript('document.title');
      const h = await v.executeJavaScript('document.querySelector("h1").textContent');
      v.remove();
      return JSON.stringify({ t, h });
    `);
    check('⑤ 로컬 파일 file:// 로드', JSON.parse(fileRes).t === 'DOCKFILE', fileRes);

    // ⑥ 두 칸 동시 렌더 — webview 2개가 같이 살아 있다
    const two = await cdp.eval<string>(`
      const a = await window.__mk('engram-preview', ${JSON.stringify(appUrl)});
      const b = await window.__mk('engram-preview', ${JSON.stringify(fileUrl)});
      const urlA = a.getURL(); const urlB = b.getURL();
      const ok = !!urlA && !!urlB && a.getWebContentsId() !== b.getWebContentsId();
      const n = document.querySelectorAll('webview').length;
      a.remove(); b.remove();
      return JSON.stringify({ ok, n, a: urlA, b: urlB });
    `);
    check('⑥ 두 칸 동시 렌더(webview 2개 각자 로드)', JSON.parse(two).ok === true, two);

    // ⑦ pty 세션을 여러 개 띄우고 종료 후 고아 0
    const pty = await cdp.eval<string>(`
      const api = window.engramDesktop;
      const cwd = ${JSON.stringify(ROOT)};
      const r1 = await api.ptyStart('smoke#t1', cwd);
      const r2 = await api.ptyStart('smoke#t2', cwd);
      const r3 = await api.ptyStart('smoke#srv', cwd);
      const alive = await api.ptyAlive(['smoke#t1', 'smoke#t2', 'smoke#srv', 'smoke#none']);
      await api.ptyKillKey('smoke#t2');
      const after = await api.ptyAlive(['smoke#t1', 'smoke#t2', 'smoke#srv']);
      return JSON.stringify({ created: [r1.created, r2.created, r3.created], alive, after });
    `);
    const ptyObj = JSON.parse(pty);
    check('⑦-a 탭마다 별도 세션 + killKey로 그 세션만 정리',
      ptyObj.alive.length === 3 && ptyObj.after.length === 2 && !ptyObj.after.includes('smoke#t2'), pty);
    const duringShells = shellPids();
    const spawned = [...duringShells].filter((p) => !beforeShells.has(p));
    console.log(`[harness] 이 하네스가 띄운 셸 ${spawned.length}개`);

    // ---- 여기부터는 합성 webview가 아니라 **실제 독 UI**를 눌러서 확인한다 ----
    // 코드 채널이 있어야 독이 뜬다 → 백엔드에 WS로 직접 채널을 만들고 폴더를 묶는다(사람이 하는 것과 같은 경로).
    await makeCodeChannel(chatPort, ROOT);
    await cdp.eval(`
      window.__click = (el) => { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); el.click(); };
      window.__glyph = (g, root) => Array.from((root || document).querySelectorAll('button')).find((b) => b.textContent === g);
      window.__wait = async (fn, ms = 8000) => { const end = Date.now() + ms;
        while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
        throw new Error('타임아웃: ' + fn.toString().slice(0, 80)); };
      return 1;
    `);
    const opened = await cdp.eval<string>(`
      // Code 탭 → 그 채널 선택 → 독 아이콘(터미널)
      const codeTab = await window.__wait(() => Array.from(document.querySelectorAll('*'))
        .find((e) => e.children.length === 0 && e.textContent === 'Code'));
      window.__click(codeTab);
      const chan = await window.__wait(() => Array.from(document.querySelectorAll('#channels .ch'))
        .find((e) => /dock-smoke/.test(e.textContent || '')), 20000);
      window.__click(chan);
      const icons = await window.__wait(() => document.querySelectorAll('.chhdrIcons .codeIconBtn').length === 3
        && document.querySelectorAll('.chhdrIcons .codeIconBtn'));
      window.__click(icons[0]); // 터미널 칸
      await window.__wait(() => document.querySelector('.dockPanel'));
      return JSON.stringify({ panes: document.querySelectorAll('.dockPane').length });
    `);
    check('⑧ 실제 독 UI가 코드 채널에서 열린다', JSON.parse(opened).panes === 1, opened);

    // ③' 분할(상하·좌우) 후 두 칸이 실제 크기를 갖고 동시에 그려지는가
    const split = await cdp.eval<string>(`
      const icons = document.querySelectorAll('.chhdrIcons .codeIconBtn');
      window.__click(icons[1]); // 브라우저 칸 → 아래로 분할(col)
      await window.__wait(() => document.querySelectorAll('.dockPane').length === 2);
      const colBox = document.querySelector('.dockSplit.col').getBoundingClientRect();
      const colKids = Array.from(document.querySelectorAll('.dockSplit.col > .dockSplitChild'))
        .map((e) => Math.round(e.getBoundingClientRect().height));
      // 좌우 분할도 만든다(⊞)
      const tabs = document.querySelectorAll('.dockTabs');
      window.__click(window.__glyph('⊞', tabs[tabs.length - 1]));
      await window.__wait(() => document.querySelectorAll('.dockPane').length === 3);
      const rowKids = Array.from(document.querySelectorAll('.dockSplit.row > .dockSplitChild'))
        .map((e) => Math.round(e.getBoundingClientRect().width));
      return JSON.stringify({ colH: Math.round(colBox.height), colKids, rowKids,
        panes: document.querySelectorAll('.dockPane').length });
    `);
    const sp = JSON.parse(split);
    check('③-a 상하·좌우 분할 후 세 칸이 모두 실제 크기를 갖는다',
      sp.panes === 3 && sp.colKids.every((h: number) => h > 20) && sp.rowKids.every((w: number) => w > 20), split);

    // ③-b 경계 드래그로 크기 조절(rAF 갱신 + 마우스업 확정)
    const drag = await cdp.eval<string>(`
      const box = document.querySelector('.dockSplit.col');
      const kid = box.querySelector(':scope > .dockSplitChild');
      const before = kid.getBoundingClientRect().height;
      const div = box.querySelector(':scope > .dockDivider');
      const r = div.getBoundingClientRect();
      div.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 2, clientY: r.top + 2 }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + 2, clientY: r.top - 60 }));
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const during = kid.getBoundingClientRect().height;
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + 2, clientY: r.top - 60 }));
      await new Promise((res) => setTimeout(res, 200));
      const after = kid.getBoundingClientRect().height;
      // 확정이 실제로 저장됐는지 — 저장된 트리를 파싱해 첫 col 분할의 비율을 꺼낸다.
      const map = JSON.parse(localStorage.getItem('engram.dock.layout') || '{}');
      const tree = JSON.parse(map[Object.keys(map)[0]] || '{}');
      const firstCol = (n) => !n || n.kind !== 'split' ? null
        : (n.dir === 'col' ? n : (firstCol(n.children[0]) || firstCol(n.children[1])));
      const col = firstCol(tree.root);
      return JSON.stringify({ before: Math.round(before), during: Math.round(during), after: Math.round(after),
        savedRatio: col ? col.sizes[0] : null, domRatio: during / (box.getBoundingClientRect().height) });
    `);
    const dg = JSON.parse(drag);
    check('③-b 경계 드래그로 크기가 바뀌고 마우스업에 확정·저장된다',
      dg.during < dg.before - 20 && Math.abs(dg.after - dg.during) < 8
      && dg.savedRatio !== null && Math.abs(dg.savedRatio - dg.domRatio) < 0.06, drag);

    // ①' 브라우저 칸 주소창으로 실제 http 렌더 + 로컬 파일 경로 입력 + URL 드롭
    const browser = await cdp.eval<string>(`
      const addr = await window.__wait(() => document.querySelector('.dockAddr'));
      const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
      set(addr, ${JSON.stringify(appUrl)});
      addr.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const view = await window.__wait(() => document.querySelector('.dockViews webview'));
      await window.__wait(() => { try { return view.getURL(); } catch { return null; } }, 15000);
      const httpUrl = view.getURL();
      // 로컬 파일 경로를 그대로 입력(윈도우 경로) → file:// 로 열린다
      const addr2 = document.querySelector('.dockAddr');
      set(addr2, ${JSON.stringify(localFile)});
      addr2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 1200));
      const fileLoaded = await window.__wait(() => {
        const v = document.querySelector('.dockViews webview.active');
        try { return v && v.getURL().startsWith('file://') ? v.getURL() : null; } catch { return null; }
      }, 15000);
      // 드롭(텍스트 URL) → 새 탭
      const dt = new DataTransfer();
      dt.setData('text/plain', 'http://127.0.0.1:${chatPort}/chat.html');
      const before = document.querySelectorAll('.dockTab').length;
      document.querySelector('.dockBrowser').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
      await new Promise((r) => setTimeout(r, 400));
      return JSON.stringify({ httpUrl, fileLoaded, tabsBefore: before, tabsAfter: document.querySelectorAll('.dockTab').length });
    `);
    const br = JSON.parse(browser);
    check('①-a 주소창 → http 실제 렌더', br.httpUrl?.startsWith('http://127.0.0.1'), br.httpUrl);
    check('⑥-a 주소창에 로컬 파일 경로 → file:// 로 열림', !!br.fileLoaded, br.fileLoaded);
    check('⑥-b 드롭(URL) → 새 탭', br.tabsAfter > br.tabsBefore, `탭 ${br.tabsBefore}→${br.tabsAfter}`);

    // ⑦' HTML 카드 "크게 보기" → 브라우저 칸 새 탭(data: URL)
    const expand = await cdp.eval<string>(`
      const card = document.querySelector('.htmlCardExpand');
      if (!card) return JSON.stringify({ skipped: '메시지에 html 카드 없음' });
      const before = document.querySelectorAll('.dockTab').length;
      window.__click(card);
      await new Promise((r) => setTimeout(r, 600));
      const v = document.querySelector('.dockViews webview.active');
      let url = ''; try { url = v ? v.getURL() : ''; } catch {}
      return JSON.stringify({ before, after: document.querySelectorAll('.dockTab').length, url: url.slice(0, 30) });
    `);
    check('⑨ HTML 카드 크게 보기 → 브라우저 칸 새 탭',
      !!JSON.parse(expand).after && JSON.parse(expand).after > JSON.parse(expand).before, expand);

    // ⑤' 실제 UI로 세션 정리 규칙: 탭 여러 개 → 탭 닫기 → 접기 → 세션 유지
    const sessions = await cdp.eval<string>(`
      const api = window.engramDesktop;
      // 터미널 칸을 찾아 탭을 2개로 만든다
      const termPane = await window.__wait(() => Array.from(document.querySelectorAll('.dockPane'))
        .find((p) => p.querySelector('.codeTerm')));
      const tabsEl = termPane.querySelector('.dockTabs');
      window.__click(window.__glyph('＋', tabsEl));
      await new Promise((r) => setTimeout(r, 1500));
      const ids = JSON.parse(localStorage.getItem('engram.dock.layout'))[Object.keys(
        JSON.parse(localStorage.getItem('engram.dock.layout')))[0]];
      const layout = JSON.parse(ids);
      const findTerm = (n) => n.kind === 'pane' ? (n.tool === 'terminal' ? [n] : [])
        : [...findTerm(n.children[0]), ...findTerm(n.children[1])];
      const chan = Object.keys(JSON.parse(localStorage.getItem('engram.dock.layout')))[0];
      const keys = findTerm(layout.root).flatMap((p) => p.tabs.map((t) => chan + '#' + t.id));
      const aliveBefore = await api.ptyAlive(keys);
      // (a) 탭 하나 닫기 → 그 세션만 죽는다
      const tabEls = termPane.querySelectorAll('.dockTab');
      const closed = tabEls[tabEls.length - 1];
      closed.querySelector('.x').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 800));
      const aliveAfterTabClose = await api.ptyAlive(keys);
      // (b) 패널 접기 → 남은 세션은 살아 있어야 한다
      const rail = document.querySelectorAll('.dockRailBtn');
      window.__click(rail[rail.length - 1]);
      await new Promise((r) => setTimeout(r, 600));
      const aliveAfterCollapse = await api.ptyAlive(keys);
      return JSON.stringify({ keys, aliveBefore, aliveAfterTabClose, aliveAfterCollapse,
        dockGone: !document.querySelector('.dockPanel') });
    `);
    const ss = JSON.parse(sessions);
    check('⑤-a 터미널 탭 2개 → 각각 별도 세션', ss.aliveBefore.length === 2, JSON.stringify(ss.aliveBefore));
    check('⑤-b 탭을 닫으면 그 세션만 죽는다', ss.aliveAfterTabClose.length === 1, JSON.stringify(ss.aliveAfterTabClose));
    check('⑤-c 패널을 접어도 세션은 유지된다',
      ss.dockGone && ss.aliveAfterCollapse.length === 1, JSON.stringify(ss.aliveAfterCollapse));

    cdp.close();
    cdp = null;

    // 종료 — before-quit killAll이 남은 세션(t1·srv)을 전부 정리해야 한다.
    child.kill();
    await new Promise<void>((r) => { child.on('exit', () => r()); setTimeout(r, 15_000); });
    await sleep(2500);
    const leftover = [...shellPids()].filter((p) => spawned.includes(p));
    check('⑦-b 종료 후 pty 고아 0', leftover.length === 0, `남은 셸 PID: ${leftover.join(',') || '없음'}`);
  } catch (e) {
    check('하네스 실행', false, e instanceof Error ? e.message : String(e));
    console.log('--- 앱 로그(마지막 2000자) ---\n' + log.slice(-2000));
  } finally {
    cdp?.close();
    try { child.kill(); } catch { /* 무시 */ }
    if (process.platform === 'win32' && child.pid) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 무시 */ }
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 실기 검증: ${results.length - failed.length}/${results.length} 통과 ===`);
  process.exit(failed.length ? 1 : 0);
}

void main();
