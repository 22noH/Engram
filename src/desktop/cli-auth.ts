import spawn from 'cross-spawn';
import type { Runner } from './claude-detect';

// CLI 두뇌(claude / codex)의 "로그인 상태"를 미리 확인해 사용자가 질문하기 전에 알려준다.
// 설계 원칙 — 오경보 금지: 파싱 실패·비JSON·불확실한 문구·타임아웃·미설치는 전부 'unknown'(경고 안 함).
// 확실히 로그아웃일 때만 'logged-out'. gemini-cli는 지원 대상이 아니다(사용자 확정 2026-07-25).
export type CliAuthProvider = 'claude-cli' | 'codex-cli';
export type CliAuthState = 'logged-in' | 'logged-out' | 'unknown';

export interface CliAuthResult {
  provider: CliAuthProvider;
  state: CliAuthState;
  detail?: string; // 로그인됨: 이메일/플랜 등 사람에게 보여줄 한 줄
}

interface Parsed {
  state: CliAuthState;
  detail?: string;
}

// 출력에서 첫 JSON 객체만 뽑는다(업데이트 경고 같은 잡음이 앞뒤에 섞이는 설치본 대비).
function firstJsonObject(stdout: string): Record<string, unknown> | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(stdout.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// claude 판정기 — 실측(2026-07-25): `claude auth status` → stdout JSON
// {"loggedIn":true,"authMethod":"claude.ai","email":"…","subscriptionType":"max"}, exit 0.
// 종료코드는 일부러 보지 않는다(로그아웃 시 비0으로 나오는 설치본이 있어 JSON이 더 믿을 만하다).
// JSON이 아니거나 loggedIn이 boolean이 아니면 unknown.
export function parseClaudeAuth(_code: number | null, stdout: string): Parsed {
  const json = firstJsonObject(stdout);
  if (!json || typeof json.loggedIn !== 'boolean') return { state: 'unknown' };
  if (!json.loggedIn) return { state: 'logged-out' };
  const email = typeof json.email === 'string' ? json.email : '';
  const plan = typeof json.subscriptionType === 'string' ? json.subscriptionType : '';
  const detail = [email, plan ? `(${plan})` : ''].filter(Boolean).join(' ');
  return detail ? { state: 'logged-in', detail } : { state: 'logged-in' };
}

// codex 판정기 — 실측(2026-07-25): `codex login status` → 평문 "Logged in using ChatGPT", exit 0.
// 부정 문구를 먼저 본다("Not logged in"이 "logged in"을 포함하므로 순서가 곧 정확성).
const CODEX_LOGGED_OUT = /(not\s+logged\s+in|not\s+authenticated|no\s+credentials|run\s+[`'"]?codex\s+login)/i;
const CODEX_LOGGED_IN = /logged\s+in/i;
export function parseCodexAuth(_code: number | null, stdout: string): Parsed {
  const text = stdout.trim();
  if (!text) return { state: 'unknown' };
  if (CODEX_LOGGED_OUT.test(text)) return { state: 'logged-out' };
  if (CODEX_LOGGED_IN.test(text)) {
    const line = text.split(/\r?\n/).find((l) => CODEX_LOGGED_IN.test(l))?.trim();
    return line ? { state: 'logged-in', detail: line } : { state: 'logged-in' };
  }
  return { state: 'unknown' };
}

// provider별 판정기를 하나의 인터페이스로 디스패치(상위는 이 표만 늘리면 된다).
const PROBES: Record<CliAuthProvider, { args: string[]; parse: (code: number | null, stdout: string) => Parsed }> = {
  'claude-cli': { args: ['auth', 'status'], parse: parseClaudeAuth },
  'codex-cli': { args: ['login', 'status'], parse: parseCodexAuth },
};

export const AUTH_PROBE_TIMEOUT_MS = 10000;

// 로그인 확인 1회. 외부 실행은 주입(테스트는 가짜 Runner). 실패·지연은 전부 unknown으로 강등.
export async function checkCliAuth(
  provider: CliAuthProvider,
  command: string,
  run: Runner,
  timeoutMs: number = AUTH_PROBE_TIMEOUT_MS,
): Promise<CliAuthResult> {
  const probe = PROBES[provider];
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref?.(); // 프로브가 앱 종료를 붙잡지 않게
    });
    // run은 여기서 절대 reject되지 않게 감싼다 — 타임아웃이 이겨도 뒤늦은 rejection이
    // unhandled로 새지 않도록(ENOENT 등 = 미설치/실행 불가 — 로그아웃으로 오인 금지).
    const attempt = run(command, probe.args).catch(() => 'failed' as const);
    const r = await Promise.race([attempt, timeout]);
    if (r === 'timeout' || r === 'failed') return { provider, state: 'unknown' };
    return { provider, ...probe.parse(r.code, r.stdout) };
  } catch {
    return { provider, state: 'unknown' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// provider 게이트: 지금 기본 두뇌가 CLI 두뇌일 때만 확인·경고한다(api 두뇌면 완전 무동작).
// brains.json에 provider가 없으면 brain.config.ts DEFAULTS와 같은 claude-cli로 본다.
export function defaultCliProvider(brains: Array<{ provider: string; isDefault: boolean }>): CliAuthProvider | null {
  const def = brains.find((b) => b.isDefault);
  if (!def) return null;
  const p = def.provider || 'claude-cli';
  return p === 'claude-cli' || p === 'codex-cli' ? p : null;
}

// 해결 안내: 복사해서 터미널에 붙여넣을 명령. claude는 실행 후 대화창에서 /login을 입력해야 해서
// 복사 대상은 `claude` 하나뿐(안내 문구는 UI가 로케일별로 붙인다).
export function authFixCommand(provider: CliAuthProvider): string {
  return provider === 'codex-cli' ? 'codex login' : 'claude';
}

export interface CliAuthPayload extends CliAuthResult {
  fixCommand: string;
}

// 렌더러/설정창으로 나가는 계약 형태(IPC engram:cli-auth-state · engram:cli-auth-changed).
export function toAuthPayload(r: CliAuthResult): CliAuthPayload {
  return { ...r, fixCommand: authFixCommand(r.provider) };
}

export const AUTH_ALERT_INTERVAL_MS = 24 * 60 * 60 * 1000;

// 알림 빈도 제한: 같은 사유(provider+로그아웃)로는 하루 1회만. 로그인 회복이 확인되면 리셋해
// 다시 풀렸을 때 즉시 알린다. unknown은 아무것도 하지 않는다(전송 실패로 리셋되면 안 됨).
export class AuthNotifyGate {
  private readonly lastAt = new Map<string, number>();

  shouldNotify(r: { provider: CliAuthProvider; state: CliAuthState }, now: number): boolean {
    const key = `${r.provider}:logged-out`;
    if (r.state === 'logged-in') {
      this.lastAt.delete(key);
      return false;
    }
    if (r.state !== 'logged-out') return false;
    const prev = this.lastAt.get(key);
    if (prev !== undefined && now - prev < AUTH_ALERT_INTERVAL_MS) return false;
    this.lastAt.set(key, now);
    return true;
  }
}

// 실제 러너(Electron 메인 전용): stdout·stderr를 함께 모으고(설치본에 따라 안내가 stderr로 나온다)
// 지연 시 프로세스를 죽인다. 테스트는 가짜 Runner를 주입한다.
export function spawnAuthRunner(timeoutMs: number = AUTH_PROBE_TIMEOUT_MS): Runner {
  return (cmd, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      const onData = (d: Buffer): void => { stdout += d.toString(); };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      const timer = setTimeout(() => { try { child.kill(); } catch { /* 이미 죽음 */ } }, timeoutMs);
      timer.unref?.();
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout }); });
    });
}
