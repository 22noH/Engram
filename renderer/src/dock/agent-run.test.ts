import type { BrowserOp } from '../../../shared/browser-ops';
import type { ConfirmMode } from '../../../shared/site-gate';
import { runBrowserOp, type AgentCtx } from './agent-run';

// AI 웹 조작의 안전 모델 집행 — 확인 단계별 차단, 로그인·결제 입력 거부, 행동 로그.
// 스크립트가 페이지에서 무엇을 하는지는 agent-page.test.ts가 실 DOM으로 본다. 여기선 "실행 전에
// 무엇을 막는가"를 본다.

type LogEntry = { label: string; status: string; detail?: string };

function ctx(over: Partial<AgentCtx> & { pageResult?: Record<string, unknown> } = {}) {
  const logs: LogEntry[] = [];
  const navigated: string[] = [];
  const asked: Array<{ label: string; url: string }> = [];
  const executed: string[] = [];
  const pageResult = over.pageResult ?? { ok: true, name: 'Sign in', selector: '#go' };
  const base: AgentCtx = {
    channelId: 'c1',
    currentUrl: 'http://localhost:5173/login',
    prefs: { agentEnabled: true, confirmMode: 'local' as ConfirmMode },
    view: {
      executeJavaScript: async (code: string) => { executed.push(code); return pageResult; },
    },
    navigate: (u) => navigated.push(u),
    confirm: async (label, url) => { asked.push({ label, url }); return true; },
    log: (e) => logs.push(e),
    consoleLines: () => ['error: boom'],
    saveShot: async () => 'C:/tmp/shot.png',
    ...over,
  };
  return { c: base, logs, navigated, asked, executed };
}

const CLICK: BrowserOp = { kind: 'click', target: '#go' };

describe('① 조작 허용 스위치', () => {
  it('꺼져 있으면 아무것도 실행하지 않고 로그에 남긴다', async () => {
    const h = ctx({ prefs: { agentEnabled: false, confirmMode: 'auto' } });
    const r = await runBrowserOp(CLICK, h.c);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/turned off/);
    expect(h.executed).toEqual([]);
    expect(h.logs[0].status).toBe('blocked');
  });
});

describe('② 로그인·결제 입력 — 어떤 설정에서도 거절', () => {
  const typeOp: BrowserOp = { kind: 'type', target: '#pw', text: 'hunter2' };

  it.each<[ConfirmMode]>([['auto'], ['local'], ['ask']])('confirmMode=%s 라도 비밀번호 칸은 차단', async (mode) => {
    const h = ctx({
      prefs: { agentEnabled: true, confirmMode: mode },
      pageResult: { ok: true, field: { type: 'password', name: 'pw' }, selector: '#pw' },
    });
    const r = await runBrowserOp(typeOp, h.c);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/never types sign-in credentials/);
    expect(h.executed).toHaveLength(1); // 정체 조회만 하고 입력 스크립트는 안 돌았다
    expect(h.asked).toEqual([]);        // 확인조차 띄우지 않는다
    expect(h.logs[0].status).toBe('blocked');
  });

  it('결제 칸도 차단', async () => {
    const h = ctx({ pageResult: { ok: true, field: { autocomplete: 'cc-number' } } });
    const r = await runBrowserOp({ kind: 'type', target: '#card', text: '4111' }, h.c);
    expect(r.text).toMatch(/never types payment details/);
  });

  it('차단 로그에 입력하려던 값이 남지 않는다(비밀이 로그로 새면 안 된다)', async () => {
    const h = ctx({ pageResult: { ok: true, field: { type: 'password' } } });
    await runBrowserOp(typeOp, h.c);
    expect(JSON.stringify(h.logs)).not.toContain('hunter2');
  });

  it('평범한 칸은 통과해서 실제로 입력된다', async () => {
    const h = ctx({ pageResult: { ok: true, field: { type: 'email', name: 'email' }, selector: '#email' } });
    const r = await runBrowserOp({ kind: 'type', target: '#email', text: 'a@b.com' }, h.c);
    expect(r.ok).toBe(true);
    expect(h.executed).toHaveLength(2); // 정체 조회 + 입력
  });
});

describe('③ 자동 확인 3단계', () => {
  it('내 컴퓨터에서만(기본): localhost는 안 묻는다', async () => {
    const h = ctx({ currentUrl: 'http://localhost:5173/x' });
    await runBrowserOp(CLICK, h.c);
    expect(h.asked).toEqual([]);
  });

  it('내 컴퓨터에서만(기본): 외부 사이트는 매 조작 묻는다', async () => {
    const h = ctx({ currentUrl: 'https://example.com/x' });
    await runBrowserOp(CLICK, h.c);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0].url).toBe('https://example.com/x');
  });

  it('매번 묻기: localhost도 묻는다', async () => {
    const h = ctx({ prefs: { agentEnabled: true, confirmMode: 'ask' } });
    await runBrowserOp(CLICK, h.c);
    expect(h.asked).toHaveLength(1);
  });

  it('항상 자동: 외부 사이트도 안 묻는다', async () => {
    const h = ctx({ prefs: { agentEnabled: true, confirmMode: 'auto' }, currentUrl: 'https://example.com' });
    await runBrowserOp(CLICK, h.c);
    expect(h.asked).toEqual([]);
  });

  it('사용자가 건너뛰면 조작이 실행되지 않는다', async () => {
    const h = ctx({ currentUrl: 'https://example.com', confirm: async () => false });
    const r = await runBrowserOp(CLICK, h.c);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/skipped/);
    expect(h.executed).toEqual([]);
    expect(h.logs[0].status).toBe('skipped');
  });

  it('읽기(read/console/network/screenshot)는 되돌릴 게 없어 묻지 않는다', async () => {
    const h = ctx({ currentUrl: 'https://example.com', pageResult: { ok: true, text: 'hi', elements: [] } });
    await runBrowserOp({ kind: 'read' }, h.c);
    await runBrowserOp({ kind: 'console' }, h.c);
    expect(h.asked).toEqual([]);
  });

  it('이동은 목적지 주소로 판정한다(외부로 나갈 때 물어본다)', async () => {
    const h = ctx({ currentUrl: 'http://localhost:5173' });
    await runBrowserOp({ kind: 'navigate', url: 'https://example.com' }, h.c);
    expect(h.asked).toHaveLength(1);
    expect(h.navigated).toEqual(['https://example.com']);
  });
});

describe('④ 결과·로그', () => {
  it('콘솔은 그 탭의 메시지를 그대로 돌려준다(두뇌가 오류를 스스로 본다)', async () => {
    const h = ctx();
    const r = await runBrowserOp({ kind: 'console' }, h.c);
    expect(r.text).toContain('error: boom');
  });

  it('요소를 못 찾으면 read부터 하라고 안내한다(추측 유도 금지)', async () => {
    const h = ctx({ pageResult: { ok: false, error: 'not-found' } });
    const r = await runBrowserOp(CLICK, h.c);
    expect(r.text).toMatch(/browser_read first/);
    expect(h.logs[0].status).toBe('fail');
  });

  it('페이지가 없으면 navigate부터 하라고 안내한다', async () => {
    const h = ctx({ view: null });
    const r = await runBrowserOp(CLICK, h.c);
    expect(r.text).toMatch(/browser_navigate first/);
  });

  it('실행이 던져도 예외가 새지 않는다(도구 루프가 안 죽는다)', async () => {
    const h = ctx({ view: { executeJavaScript: async () => { throw new Error('detached'); } } });
    const r = await runBrowserOp(CLICK, h.c);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('detached');
  });

  it('스크린샷은 저장 경로를 돌려준다(두뇌가 그 파일을 읽는다)', async () => {
    const h = ctx({
      view: {
        executeJavaScript: async () => ({ ok: true }),
        capturePage: async () => ({ toPNG: () => new Uint8Array([1, 2, 3]) }),
      },
    });
    const r = await runBrowserOp({ kind: 'screenshot' }, h.c);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('C:/tmp/shot.png');
  });
});
