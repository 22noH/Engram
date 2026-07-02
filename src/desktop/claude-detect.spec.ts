import { detectClaude, claudeInstallCommand, Runner } from './claude-detect';

describe('detectClaude', () => {
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
