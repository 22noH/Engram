/**
 * 진행 카드 + 완료 보고서 실기(Electron) 검증 — 스펙 2026-07-25 §검증의 "실기 확인" 항목.
 *
 * jsdom으로는 못 보는 것만 본다:
 *   ① ★재시작 복원 — 앱을 새로 켰을 때(기록만 있는 상태) 진행 보고가 카드 한 장으로 묶여 있는가
 *      (휘발 상태로 묶었다면 여기서 낱개 진행 줄이 우르르 보인다)
 *   ② 접힘 → 클릭 → 펼침이 진짜 되는가(단계 목록·마커)
 *   ③ 끝난 실행은 완료 표시로 접혀 있고, 아직 도는 실행은 제목에 실제 shimmer가 걸리는가
 *      (getComputedStyle로 확인 — 진짜 브라우저에서만 가능)
 *   ④ 완료 보고서가 카드 아래에 보이는가
 *   ⑤ 표식 없는 옛 진행 메시지는 예전처럼 낱개 줄로 남는가(회귀 0)
 *
 * 격리: ENGRAM_USERDATA_DIR(임시 폴더) + ENGRAM_CHAT_PORT(빈 포트) + ENGRAM_OPEN_CHAT=1.
 * 사용자의 설치판·데이터는 절대 건드리지 않는다.
 *
 * 실행: npx ts-node scripts/smoke-progress-card.ts   (선행: npm run renderer:build && npx nest build)
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import WebSocket from 'ws';

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
        lastSeen = targets.map((t: any) => `${t.type} ${String(t.url).slice(0, 60)}`).join(' | ');
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

// ── 기록 심기(사람이 실제로 코딩을 한 번 돌린 뒤의 jsonl과 같은 모양) ──────────────
const ts = (secAgo: number): string => new Date(Date.now() - secAgo * 1000).toISOString();
const RUN = { id: 'run_smoke_done', title: '자율 코딩' };

function seed(userData: string): void {
  const chatDir = path.join(userData, 'state', 'chat');
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(path.join(chatDir, 'channels.json'), JSON.stringify([
    { id: 'ch-done', name: 'card-done', respondMode: 'mention', mode: 'chat' },
    { id: 'ch-run', name: 'card-running', respondMode: 'mention', mode: 'chat' },
    { id: 'ch-old', name: 'card-legacy', respondMode: 'mention', mode: 'chat' },
  ], null, 2));

  const done = [
    { id: 'u1', authorId: 'owner', text: '리뷰 붙여줘', ts: ts(400) },
    { id: 'd1', authorId: 'engram', text: '· 자율 코딩 시작할게요', ts: ts(330), progress: true, progressRun: RUN },
    { id: 'd2', authorId: 'engram', text: '· 분해 완료 — 작업 2개', ts: ts(310), progress: true, progressRun: RUN },
    { id: 'd3', authorId: 'engram', text: '· ✗ 실패: auto-review backend — 다시 시도합니다 (2번째 시도) [사용량 한도]', ts: ts(240), progress: true, progressRun: { ...RUN, kind: 'retry' } },
    { id: 'd4', authorId: 'engram', text: '· ✓ 착지: auto-review backend', ts: ts(120), progress: true, progressRun: RUN },
    { id: 'd5', authorId: 'engram', text: '· ✓ 완성조건 충족 — 완료', ts: ts(100), progress: true, progressRun: RUN },
    { id: 'd6', authorId: 'engram', completionReport: true, ts: ts(95), text: [
      '# 자동 리뷰 + 설정 UI 붙이기', '', 'pingo 저장소 · 격리 브랜치 `engram/proj_s` — 사람 머지 대기', '',
      '**무엇을 했나**', '- MR 감지 시 자동 리뷰가 돌고 댓글을 답니다', '',
      '**바뀐 파일**', '- `src/review/poller.ts` +341 −16', '',
      '**검증**', '- 테스트·빌드·타입 통과', '',
      '**남은 것 · 판단이 필요한 것**', '- 폴링이라 실시간이 아닙니다(최대 30초 지연)',
    ].join('\n') },
  ];
  const runId = { id: 'run_smoke_live', title: '자율 코딩' };
  const running = [
    { id: 'r1', authorId: 'engram', text: '· 자율 코딩 시작할게요', ts: ts(60), progress: true, progressRun: runId },
    { id: 'r2', authorId: 'engram', text: '· 완성조건 리뷰 중', ts: ts(41), progress: true, progressRun: runId },
  ];
  // 표식 없는 옛 진행 메시지(업그레이드 전 기록) — 예전처럼 낱개 줄로 남아야 한다.
  const legacy = [
    { id: 'o1', authorId: 'engram', text: '· 게이트 실행 중', ts: ts(50), progress: true },
    { id: 'o2', authorId: 'engram', text: '· ✓ 착지', ts: ts(40), progress: true },
  ];
  const write = (id: string, rows: unknown[]): void =>
    fs.writeFileSync(path.join(chatDir, `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  write('ch-done', done);
  write('ch-run', running);
  write('ch-old', legacy);
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// 채널 이름으로 사이드바 항목을 눌러 그 채널을 연다.
const OPEN_CHANNEL = (name: string): string => `
  const it = [...document.querySelectorAll('#channels *')].find((e) => e.textContent.trim() === '# ${name}' && e.children.length === 0);
  if (it) it.click();
  for (let i = 0; i < 60 && !document.querySelector('#msgs .msg, #msgs .progressCard'); i++) await new Promise((r) => setTimeout(r, 100));
  return document.querySelectorAll('#msgs .msg').length;
`;

async function main(): Promise<void> {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-card-'));
  seed(userData);
  const chatPort = await freePort();
  const cdpPort = await freePort();
  console.log(`[harness] userData=${userData} chatPort=${chatPort} cdpPort=${cdpPort}`);

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
  try {
    cdp = await Cdp.attach(cdpPort, (t) => t.type === 'page' && String(t.url).includes('renderer/dist/index.html'));
    console.log('[harness] 채팅 렌더러에 붙었다(새로 켠 앱 — 기록만 있는 상태)');

    // ① 재시작 복원 — 진행 보고 5개가 카드 한 장으로 묶여 접혀 있다
    await cdp.eval(OPEN_CHANNEL('card-done'));
    const restored = await cdp.eval<string>(`
      for (let i = 0; i < 60 && !document.querySelector('.progressCard'); i++) await new Promise((r) => setTimeout(r, 100));
      const card = document.querySelector('.progressCard');
      return JSON.stringify({
        cards: document.querySelectorAll('.progressCard').length,
        looseProgress: document.querySelectorAll('.msg.progress').length,
        collapsed: !document.querySelector('.pcSteps'),
        cls: card ? card.className : '(none)',
        head: card ? card.querySelector('.pcHead').textContent : '',
      });
    `);
    const r1 = JSON.parse(restored);
    check('① 재시작 후에도 진행 보고가 카드 한 장으로 복원(낱개 줄 0)',
      r1.cards === 1 && r1.looseProgress === 0, restored);
    check('③-a 끝난 실행은 완료 표시로 접혀 있다', r1.cls.includes('done') && r1.collapsed, r1.head);

    // ② 접힘 → 클릭 → 펼침(단계·마커)
    const expanded = await cdp.eval<string>(`
      document.querySelector('.pcHead').click();
      await new Promise((r) => setTimeout(r, 60));
      const marks = [...document.querySelectorAll('.pcMk')].map((e) => e.textContent);
      const first = document.querySelector('.pcTx').textContent;
      document.querySelector('.pcHead').click();
      await new Promise((r) => setTimeout(r, 60));
      return JSON.stringify({ steps: marks.length, marks, first, reCollapsed: !document.querySelector('.pcSteps') });
    `);
    const r2 = JSON.parse(expanded);
    check('② 눌러서 펼치면 단계 목록이 나오고 다시 누르면 접힌다',
      r2.steps === 5 && r2.reCollapsed === true, expanded);
    check('② 재시도 단계는 ↻ 마커로 남는다', r2.marks.includes('↻'), String(r2.marks));

    // ④ 완료 보고서
    const report = await cdp.eval<string>(`
      const el = document.querySelector('.msg.report');
      return JSON.stringify({ exists: !!el, hasLeft: !!el && el.textContent.includes('남은 것') });
    `);
    const r4 = JSON.parse(report);
    check('④ 완료 보고서가 카드 아래에 보인다(남은 것 절 포함)', r4.exists && r4.hasLeft, report);

    // ③-b 아직 도는 실행 — 제목에 진짜 shimmer가 걸린다
    await cdp.eval(OPEN_CHANNEL('card-running'));
    const live = await cdp.eval<string>(`
      for (let i = 0; i < 60 && !document.querySelector('.progressCard'); i++) await new Promise((r) => setTimeout(r, 100));
      const card = document.querySelector('.progressCard');
      const title = card && card.querySelector('.pcTitle');
      const anim = title ? getComputedStyle(title).animationName : '(none)';
      return JSON.stringify({ cls: card ? card.className : '(none)', anim, meta: card ? card.querySelector('.pcMeta').textContent : '' });
    `);
    const r3 = JSON.parse(live);
    check('③-b 도는 중인 카드는 running + 제목에 실제 shimmer',
      r3.cls.includes('running') && r3.anim === 'progressShimmer', live);
    check('③-b 접힌 줄에 경과 시간·단계 수가 보인다', /\d/.test(r3.meta), r3.meta);

    // ⑤ 표식 없는 옛 기록 — 예전 그대로 낱개 줄(회귀 0)
    await cdp.eval(OPEN_CHANNEL('card-legacy'));
    const legacy = await cdp.eval<string>(`
      for (let i = 0; i < 60 && !document.querySelector('#msgs .msg'); i++) await new Promise((r) => setTimeout(r, 100));
      return JSON.stringify({
        cards: document.querySelectorAll('.progressCard').length,
        rows: document.querySelectorAll('.msg.progress').length,
      });
    `);
    const r5 = JSON.parse(legacy);
    check('⑤ 표식 없는 옛 진행 메시지는 예전처럼 낱개 줄(회귀 0)', r5.cards === 0 && r5.rows === 2, legacy);
  } catch (err) {
    check('하네스', false, String(err));
    console.log('---- 앱 로그 ----\n' + log.slice(-4000));
  } finally {
    cdp?.close();
    child.kill();
    await sleep(1200);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* 임시 폴더 정리 실패는 무시 */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
}

void main();
