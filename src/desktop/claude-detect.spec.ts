import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectClaude, resolveClaude, claudeCliEnvOverride, claudeInstallCommand, Runner } from './claude-detect';

describe('detectClaude(후방호환 래퍼)', () => {
  it('종료코드 0이면 설치됨 + 버전 문자열', async () => {
    const run: Runner = async () => ({ code: 0, stdout: '1.2.3 (Claude Code)\n' });
    expect(await detectClaude(run)).toEqual({ installed: true, version: '1.2.3 (Claude Code)' });
  });

  it('종료코드 비0이면 미설치', async () => {
    const run: Runner = async () => ({ code: 1, stdout: '' });
    expect(await detectClaude(run)).toEqual({ installed: false, version: null });
  });

  it('spawn 자체가 throw(ENOENT)해도 미설치로 강등', async () => {
    const run: Runner = async () => {
      throw new Error('ENOENT');
    };
    expect(await detectClaude(run)).toEqual({ installed: false, version: null });
  });

  it('설치 명령: win32=PowerShell, 그 외=curl', () => {
    expect(claudeInstallCommand('win32')).toBe('irm https://claude.ai/install.ps1 | iex');
    expect(claudeInstallCommand('darwin')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(claudeInstallCommand('linux')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
  });
});

describe('resolveClaude(PATH 미상속 머신 폴백)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-claude-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('PATH의 claude가 바로 되면 command=claude(기존 동작 그대로)', async () => {
    const run: Runner = async (cmd) => {
      if (cmd === 'claude') return { code: 0, stdout: '1.2.3\n' };
      throw new Error('unexpected cmd ' + cmd);
    };
    expect(await resolveClaude(run, {}, 'win32')).toEqual({ installed: true, version: '1.2.3', command: 'claude' });
  });

  it('PATH 미스 + 첫 폴백 후보(~/.local/bin/claude.exe)가 존재&동작 → 절대경로 command', async () => {
    const exe = path.join(dir, '.local', 'bin', 'claude.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '');
    const run: Runner = async (cmd) => {
      if (cmd === 'claude') throw new Error('ENOENT');
      if (cmd === exe) return { code: 0, stdout: '2.0.0\n' };
      throw new Error('unexpected cmd ' + cmd);
    };
    expect(await resolveClaude(run, { USERPROFILE: dir }, 'win32')).toEqual({
      installed: true, version: '2.0.0', command: exe,
    });
  });

  it('첫 후보 파일은 있지만 --version 실패(존재하지만 깨짐) → 다음 후보(npm .cmd)로 계속 탐색', async () => {
    const badExe = path.join(dir, '.local', 'bin', 'claude.exe');
    fs.mkdirSync(path.dirname(badExe), { recursive: true });
    fs.writeFileSync(badExe, '');
    const appData = path.join(dir, 'AppData', 'Roaming');
    const npmCmd = path.join(appData, 'npm', 'claude.cmd');
    fs.mkdirSync(path.dirname(npmCmd), { recursive: true });
    fs.writeFileSync(npmCmd, '');
    const run: Runner = async (cmd) => {
      if (cmd === 'claude') throw new Error('ENOENT');
      if (cmd === badExe) return { code: 1, stdout: '' };
      if (cmd === npmCmd) return { code: 0, stdout: '3.0.0\n' };
      throw new Error('unexpected cmd ' + cmd);
    };
    expect(await resolveClaude(run, { USERPROFILE: dir, APPDATA: appData }, 'win32')).toEqual({
      installed: true, version: '3.0.0', command: npmCmd,
    });
  });

  it('모든 후보 실패(파일 자체가 없음) → installed:false, command은 claude로 안전 폴백', async () => {
    const run: Runner = async () => {
      throw new Error('ENOENT');
    };
    expect(await resolveClaude(run, { USERPROFILE: dir, APPDATA: path.join(dir, 'AppData', 'Roaming') }, 'win32')).toEqual({
      installed: false, version: null, command: 'claude',
    });
  });

  it('darwin/linux 후보 경로(~/.local/bin, /usr/local/bin, /opt/homebrew/bin) 순서로 탐색', async () => {
    const localBin = path.join(dir, '.local', 'bin', 'claude');
    fs.mkdirSync(path.dirname(localBin), { recursive: true });
    fs.writeFileSync(localBin, '');
    const run: Runner = async (cmd) => {
      if (cmd === 'claude') throw new Error('ENOENT');
      if (cmd === localBin) return { code: 0, stdout: '4.0.0\n' };
      throw new Error('unexpected cmd ' + cmd);
    };
    expect(await resolveClaude(run, { HOME: dir }, 'darwin')).toEqual({
      installed: true, version: '4.0.0', command: localBin,
    });
  });
});

describe('claudeCliEnvOverride(순수 — 자식 프로세스 env 패치)', () => {
  it('사용자가 이미 ENGRAM_BRAIN_CLI를 지정했으면 손대지 않는다', () => {
    expect(
      claudeCliEnvOverride({ ENGRAM_BRAIN_CLI: '/custom/claude' }, { installed: true, command: 'C:/x/claude.exe' }),
    ).toBeUndefined();
  });

  it('PATH에서 바로 잡힌 경우(command=claude)는 오버라이드 불필요', () => {
    expect(claudeCliEnvOverride({}, { installed: true, command: 'claude' })).toBeUndefined();
  });

  it('미설치면 오버라이드하지 않는다', () => {
    expect(claudeCliEnvOverride({}, { installed: false, command: 'claude' })).toBeUndefined();
  });

  it('폴백 절대경로로 찾았으면 그 경로를 반환한다', () => {
    expect(claudeCliEnvOverride({}, { installed: true, command: 'C:/Users/x/.local/bin/claude.exe' })).toBe(
      'C:/Users/x/.local/bin/claude.exe',
    );
  });
});
