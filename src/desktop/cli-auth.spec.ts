import {
  parseClaudeAuth,
  parseCodexAuth,
  checkCliAuth,
  defaultCliProvider,
  authFixCommand,
  toAuthPayload,
  AuthNotifyGate,
  AUTH_ALERT_INTERVAL_MS,
} from './cli-auth';
import type { Runner } from './claude-detect';

// 실측(2026-07-25, 이 머신): `claude auth status` → stdout에 JSON, exit 0.
const CLAUDE_IN = '{"loggedIn":true,"authMethod":"claude.ai","email":"eno931103@gmail.com","subscriptionType":"max"}';

describe('parseClaudeAuth (JSON 판정기)', () => {
  it('loggedIn:true면 로그인됨 + 이메일·플랜 detail', () => {
    expect(parseClaudeAuth(0, CLAUDE_IN)).toEqual({
      state: 'logged-in',
      detail: 'eno931103@gmail.com (max)',
    });
  });

  it('loggedIn:false면 로그아웃 — 이때만 경고한다', () => {
    expect(parseClaudeAuth(1, '{"loggedIn":false}')).toEqual({ state: 'logged-out' });
  });

  it('이메일·플랜이 없어도 loggedIn:true면 로그인됨(detail 없음)', () => {
    expect(parseClaudeAuth(0, '{"loggedIn":true}')).toEqual({ state: 'logged-in' });
  });

  it('앞뒤에 잡음이 섞여도 첫 JSON 객체를 읽는다', () => {
    expect(parseClaudeAuth(0, `warning: update available\n${CLAUDE_IN}\n`).state).toBe('logged-in');
  });

  it('비JSON 출력은 unknown — 오경보 금지', () => {
    expect(parseClaudeAuth(0, 'Claude Code v2.1.0\n')).toEqual({ state: 'unknown' });
  });

  it('JSON이지만 loggedIn 필드가 없으면 unknown', () => {
    expect(parseClaudeAuth(0, '{"authMethod":"claude.ai"}')).toEqual({ state: 'unknown' });
  });

  it('빈 출력 + exit≠0(구버전·미지원 서브커맨드)도 unknown', () => {
    expect(parseClaudeAuth(1, '')).toEqual({ state: 'unknown' });
    expect(parseClaudeAuth(null, '')).toEqual({ state: 'unknown' });
  });

  it('loggedIn이 boolean이 아니면(문자열 "true") unknown', () => {
    expect(parseClaudeAuth(0, '{"loggedIn":"true"}')).toEqual({ state: 'unknown' });
  });
});

describe('parseCodexAuth (평문 판정기)', () => {
  it('실측 출력 "Logged in using ChatGPT" + exit 0 → 로그인됨', () => {
    expect(parseCodexAuth(0, 'Logged in using ChatGPT\n')).toEqual({
      state: 'logged-in',
      detail: 'Logged in using ChatGPT',
    });
  });

  it('"Not logged in"은 부정 문구가 우선 — 로그아웃', () => {
    expect(parseCodexAuth(1, 'Not logged in\n')).toEqual({ state: 'logged-out' });
  });

  it('"Please run `codex login`" 안내도 로그아웃', () => {
    expect(parseCodexAuth(1, 'Please run `codex login` to authenticate.').state).toBe('logged-out');
  });

  it('빈 출력은 exit 0이어도 unknown', () => {
    expect(parseCodexAuth(0, '   \n')).toEqual({ state: 'unknown' });
  });

  it('exit≠0이지만 문구가 불확실하면 unknown — 오경보 금지', () => {
    expect(parseCodexAuth(1, "error: unrecognized subcommand 'login'")).toEqual({ state: 'unknown' });
  });

  it('깨진 바이너리 출력도 unknown', () => {
    expect(parseCodexAuth(null, '\u0000\ufffd\ufffd').state).toBe('unknown');
  });
});

describe('checkCliAuth (상위 디스패치)', () => {
  it('claude-cli는 `auth status`를 실행한다', async () => {
    const calls: Array<[string, string[]]> = [];
    const run: Runner = async (cmd, args) => {
      calls.push([cmd, args]);
      return { code: 0, stdout: CLAUDE_IN };
    };
    expect(await checkCliAuth('claude-cli', 'C:/x/claude.exe', run)).toEqual({
      provider: 'claude-cli',
      state: 'logged-in',
      detail: 'eno931103@gmail.com (max)',
    });
    expect(calls).toEqual([['C:/x/claude.exe', ['auth', 'status']]]);
  });

  it('codex-cli는 `login status`를 실행한다', async () => {
    const calls: Array<[string, string[]]> = [];
    const run: Runner = async (cmd, args) => {
      calls.push([cmd, args]);
      return { code: 0, stdout: 'Logged in using ChatGPT' };
    };
    expect((await checkCliAuth('codex-cli', 'codex', run)).state).toBe('logged-in');
    expect(calls).toEqual([['codex', ['login', 'status']]]);
  });

  it('spawn 자체가 throw(ENOENT)하면 unknown — 미설치를 로그아웃으로 오인하지 않는다', async () => {
    const run: Runner = async () => {
      throw new Error('ENOENT');
    };
    expect(await checkCliAuth('claude-cli', 'claude', run)).toEqual({ provider: 'claude-cli', state: 'unknown' });
  });

  it('응답이 늦으면 타임아웃 → unknown(경고 안 함)', async () => {
    const run: Runner = () => new Promise((resolve) => { setTimeout(() => resolve({ code: 0, stdout: '{"loggedIn":false}' }), 200); });
    expect(await checkCliAuth('claude-cli', 'claude', run, 10)).toEqual({ provider: 'claude-cli', state: 'unknown' });
  });
});

describe('defaultCliProvider (provider 게이트)', () => {
  it('기본 두뇌가 claude-cli면 확인 대상', () => {
    expect(defaultCliProvider([
      { provider: 'anthropic-api', isDefault: false },
      { provider: 'claude-cli', isDefault: true },
    ])).toBe('claude-cli');
  });

  it('기본 두뇌가 codex-cli면 확인 대상', () => {
    expect(defaultCliProvider([{ provider: 'codex-cli', isDefault: true }])).toBe('codex-cli');
  });

  it('provider 생략(빈 문자열)은 brains.json 기본값 claude-cli로 본다', () => {
    expect(defaultCliProvider([{ provider: '', isDefault: true }])).toBe('claude-cli');
  });

  it('api provider가 기본이면 null — 완전 무동작(회귀 0)', () => {
    expect(defaultCliProvider([
      { provider: 'claude-cli', isDefault: false },
      { provider: 'anthropic-api', isDefault: true },
    ])).toBeNull();
    expect(defaultCliProvider([{ provider: 'openai-api', isDefault: true }])).toBeNull();
  });

  it('gemini-cli는 지원 대상이 아니다', () => {
    expect(defaultCliProvider([{ provider: 'gemini-cli', isDefault: true }])).toBeNull();
  });

  it('기본이 없거나 목록이 비면 null', () => {
    expect(defaultCliProvider([])).toBeNull();
    expect(defaultCliProvider([{ provider: 'claude-cli', isDefault: false }])).toBeNull();
  });
});

describe('AuthNotifyGate (같은 사유로 하루 1회)', () => {
  const out = { provider: 'claude-cli', state: 'logged-out' } as const;

  it('첫 로그아웃은 알린다', () => {
    expect(new AuthNotifyGate().shouldNotify(out, 1000)).toBe(true);
  });

  it('같은 사유 재확인은 24시간 안에는 안 알린다', () => {
    const g = new AuthNotifyGate();
    expect(g.shouldNotify(out, 0)).toBe(true);
    expect(g.shouldNotify(out, 30 * 60 * 1000)).toBe(false);
    expect(g.shouldNotify(out, AUTH_ALERT_INTERVAL_MS - 1)).toBe(false);
    expect(g.shouldNotify(out, AUTH_ALERT_INTERVAL_MS)).toBe(true);
  });

  it('로그인 회복이 끼면 리셋 — 다시 풀리면 즉시 알린다', () => {
    const g = new AuthNotifyGate();
    expect(g.shouldNotify(out, 0)).toBe(true);
    expect(g.shouldNotify({ provider: 'claude-cli', state: 'logged-in' }, 60_000)).toBe(false);
    expect(g.shouldNotify(out, 120_000)).toBe(true);
  });

  it('unknown은 알리지도, 리셋하지도 않는다', () => {
    const g = new AuthNotifyGate();
    expect(g.shouldNotify(out, 0)).toBe(true);
    expect(g.shouldNotify({ provider: 'claude-cli', state: 'unknown' }, 60_000)).toBe(false);
    expect(g.shouldNotify(out, 120_000)).toBe(false); // 리셋 안 됨 — 하루 제한 유지
  });

  it('provider가 다르면 각각 센다', () => {
    const g = new AuthNotifyGate();
    expect(g.shouldNotify(out, 0)).toBe(true);
    expect(g.shouldNotify({ provider: 'codex-cli', state: 'logged-out' }, 0)).toBe(true);
  });
});

describe('해결 안내', () => {
  it('claude는 `claude` 실행 후 /login, codex는 `codex login`', () => {
    expect(authFixCommand('claude-cli')).toBe('claude');
    expect(authFixCommand('codex-cli')).toBe('codex login');
  });

  it('렌더러 페이로드에 복사용 명령이 붙는다', () => {
    expect(toAuthPayload({ provider: 'codex-cli', state: 'logged-out' })).toEqual({
      provider: 'codex-cli', state: 'logged-out', fixCommand: 'codex login',
    });
    expect(toAuthPayload({ provider: 'claude-cli', state: 'logged-in', detail: 'a@b.com (max)' })).toEqual({
      provider: 'claude-cli', state: 'logged-in', detail: 'a@b.com (max)', fixCommand: 'claude',
    });
  });
});
