import type { BrowserOp, BrowserOpResult } from '../../../shared/browser-ops';
import { CREDENTIAL_BLOCK_MESSAGE, credentialBlockReason, needsConfirm, type ConfirmMode } from '../../../shared/site-gate';
import { clickScript, inspectScript, networkScript, readScript, typeScript } from './agent-page';

// AI 웹 조작 1건의 실행 — 안전 판정 → (필요하면) 사람 확인 → 실제 조작 → 행동 로그.
//
// 이 파일이 안전 모델의 집행 지점이다(스펙 §안전 모델):
//  ① 조작 허용이 꺼져 있으면 아무것도 안 한다.
//  ② 로그인·결제 칸 입력은 **어떤 설정에서도** 거절한다 — 확인 창을 띄우지도 않는다(하드 규칙).
//  ③ 자동 확인 3단계에 따라 물어본다(기본: 내 컴퓨터는 자동, 외부 사이트는 매번).
//  ④ 무엇을 했는지 반드시 로그에 남긴다(차단·건너뛰기 포함 — 사후 추적).
// never-throw: 어떤 실패도 예외가 아니라 ok:false 텍스트다(두뇌가 읽고 다음 수를 정한다).

const READ_CHARS = 20_000;
const READ_ELEMENTS = 60;
const NETWORK_MAX = 40;

/** 실행에 필요한 최소 webview 표면(테스트가 가짜를 넣을 수 있게 좁힌 타입). */
export interface AgentView {
  getURL?(): string;
  executeJavaScript(code: string): Promise<unknown>;
  capturePage?(): Promise<{ toPNG(): Uint8Array }>;
}

export interface AgentCtx {
  channelId: string;
  view: AgentView | null;
  /** 지금 보고 있는 주소(view가 아직 attach 전일 수도 있어 별도로 받는다). */
  currentUrl: string;
  prefs: { agentEnabled: boolean; confirmMode: ConfirmMode };
  /** 주소 이동은 레이아웃(탭)을 건드리므로 소유자(App)가 수행한다. */
  navigate: (url: string) => void;
  confirm: (label: string, url: string) => Promise<boolean>;
  log: (e: { label: string; status: 'ok' | 'fail' | 'blocked' | 'skipped'; detail?: string }) => void;
  /** 그 탭의 콘솔 링버퍼(BrowserView가 모은다). */
  consoleLines: () => string[];
  /** 스크린샷 저장(경로 반환). 데스크톱이 아니면 null. */
  saveShot: (png: ArrayBuffer) => Promise<string | null>;
}

/** 확인 줄·로그에 쓸 한 줄 요약(사람이 읽는 문구). */
export function describeOp(op: BrowserOp): string {
  switch (op.kind) {
    case 'navigate': return `Open ${op.url}`;
    case 'click': return `Click ${op.target}`;
    case 'type': return `Type into ${op.target}`;
    case 'read': return op.selector ? `Read ${op.selector}` : 'Read the page';
    case 'console': return 'Read console messages';
    case 'network': return 'Read network requests';
    case 'screenshot': return 'Take a screenshot';
  }
}

/** 사람 확인이 필요한 조작인가 — 화면을 **바꾸는** 것만. 읽기는 되돌릴 게 없어 묻지 않는다. */
function isAction(op: BrowserOp): boolean {
  return op.kind === 'navigate' || op.kind === 'click' || op.kind === 'type';
}

function fail(ctx: AgentCtx, label: string, detail: string, status: 'fail' | 'blocked' | 'skipped' = 'fail'): BrowserOpResult {
  ctx.log({ label, status, detail });
  return { ok: false, text: `browser error: ${detail}` };
}

type PageResult = Record<string, unknown> & { ok?: boolean; error?: string };

async function run(view: AgentView, code: string): Promise<PageResult> {
  const r = await view.executeJavaScript(code);
  return (r && typeof r === 'object' ? r : { ok: false, error: 'no result' }) as PageResult;
}

const NOT_FOUND_HINT = 'element not found — call browser_read first and use one of the selectors it returns';

export async function runBrowserOp(op: BrowserOp, ctx: AgentCtx): Promise<BrowserOpResult> {
  const label = describeOp(op);
  // ① 조작 허용 스위치(⋮ 메뉴). 꺼져 있으면 여기서 끝.
  if (!ctx.prefs.agentEnabled) {
    return fail(ctx, label, 'web control is turned off for this panel (⋮ menu → Allow AI control)', 'blocked');
  }

  const url = op.kind === 'navigate' ? op.url : ctx.currentUrl;

  // ② 로그인·결제 입력 하드 차단 — 확인조차 띄우지 않는다. 대상 칸의 정체를 먼저 페이지에서 읽어온다.
  if (op.kind === 'type') {
    if (!ctx.view) return fail(ctx, label, 'no page is open in the browser pane — use browser_navigate first');
    let info: PageResult;
    try {
      info = await run(ctx.view, inspectScript(op.target));
    } catch (e) {
      return fail(ctx, label, `could not inspect the field (${e instanceof Error ? e.message : String(e)})`);
    }
    if (!info.ok) {
      return fail(ctx, label, info.error === 'not-found' ? NOT_FOUND_HINT : `cannot type here (${String(info.error)})`);
    }
    const reason = credentialBlockReason((info.field ?? {}) as Record<string, string>);
    if (reason) {
      const msg = CREDENTIAL_BLOCK_MESSAGE[reason];
      // 무엇을 입력하려 했는지는 **남기지 않는다**(비밀이 로그로 새면 차단한 의미가 없다).
      ctx.log({ label, status: 'blocked', detail: msg });
      return { ok: false, text: msg };
    }
  }

  // ③ 자동 확인 3단계.
  if (isAction(op) && needsConfirm(ctx.prefs.confirmMode, url)) {
    const allowed = await ctx.confirm(label, url);
    if (!allowed) {
      ctx.log({ label, status: 'skipped', detail: 'the user skipped this step' });
      return { ok: false, text: 'browser: the user skipped this action' };
    }
  }

  try {
    return await perform(op, ctx, label, url);
  } catch (e) {
    return fail(ctx, label, e instanceof Error ? e.message : String(e));
  }
}

async function perform(op: BrowserOp, ctx: AgentCtx, label: string, url: string): Promise<BrowserOpResult> {
  // 이동만 view 없이도 된다(칸/탭을 여는 것 자체가 이동이다).
  if (op.kind === 'navigate') {
    ctx.navigate(op.url);
    ctx.log({ label, status: 'ok' });
    return { ok: true, text: `opened ${op.url} in the browser pane` };
  }

  if (op.kind === 'console') {
    const lines = ctx.consoleLines();
    ctx.log({ label, status: 'ok', detail: `${lines.length} message(s)` });
    return { ok: true, text: lines.length ? lines.join('\n') : 'no console messages since this page was opened' };
  }

  const view = ctx.view;
  if (!view) return fail(ctx, label, 'no page is open in the browser pane — use browser_navigate first');

  if (op.kind === 'screenshot') {
    if (!view.capturePage) return fail(ctx, label, 'screenshots are only available in the Engram desktop app');
    const img = await view.capturePage();
    const png = img.toPNG();
    const buf = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
    const saved = await ctx.saveShot(buf);
    if (!saved) return fail(ctx, label, 'could not save the screenshot');
    ctx.log({ label, status: 'ok', detail: saved });
    return { ok: true, text: `screenshot saved: ${saved}` };
  }

  if (op.kind === 'click') {
    const r = await run(view, clickScript(op.target, 'Click'));
    if (!r.ok) return fail(ctx, label, r.error === 'not-found' ? NOT_FOUND_HINT : `click failed (${String(r.error)})`);
    ctx.log({ label: `Click · ${String(r.name ?? op.target)}`, status: 'ok' });
    return { ok: true, text: `clicked ${String(r.name ?? op.target)} (${String(r.selector ?? op.target)}) on ${url}` };
  }

  if (op.kind === 'type') {
    const r = await run(view, typeScript(op.target, op.text, op.submit === true, 'Type'));
    if (!r.ok) return fail(ctx, label, r.error === 'not-found' ? NOT_FOUND_HINT : `typing failed (${String(r.error)})`);
    ctx.log({ label, status: 'ok', detail: op.submit ? 'submitted' : undefined });
    return { ok: true, text: `typed into ${String(r.selector ?? op.target)}${op.submit ? ' and submitted' : ''}` };
  }

  if (op.kind === 'network') {
    const r = await run(view, networkScript(NETWORK_MAX));
    if (!r.ok) return fail(ctx, label, `could not read network requests (${String(r.error)})`);
    const reqs = (r.requests ?? []) as Array<{ url: string; kind: string; ms: number; bytes: number }>;
    ctx.log({ label, status: 'ok', detail: `${reqs.length} request(s)` });
    if (!reqs.length) return { ok: true, text: 'no network requests recorded for this page' };
    return {
      ok: true,
      text: reqs.map((q) => `${q.kind || '-'} ${q.url} — ${q.ms}ms, ${q.bytes}B`).join('\n'),
    };
  }

  // read
  const r = await run(view, readScript(op.selector, READ_CHARS, READ_ELEMENTS));
  if (!r.ok) return fail(ctx, label, r.error === 'not-found' ? NOT_FOUND_HINT : `could not read the page (${String(r.error)})`);
  const els = (r.elements ?? []) as Array<{ kind: string; name: string; selector: string }>;
  ctx.log({ label, status: 'ok' });
  const parts = [
    `URL: ${String(r.url ?? url)}`,
    `TITLE: ${String(r.title ?? '')}`,
    '',
    String(r.text ?? ''),
  ];
  if (els.length) {
    parts.push('', 'INTERACTIVE ELEMENTS (use these selectors):');
    parts.push(...els.map((e) => `- ${e.kind} ${e.name ? `"${e.name}" ` : ''}→ ${e.selector}`));
  }
  return { ok: true, text: parts.join('\n') };
}
