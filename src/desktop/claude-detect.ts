import spawn from 'cross-spawn';

// claude CLI 설치 감지(스펙 §4 두뇌 연결). 로그인 여부는 실 API 콜 비용 때문에 감지하지 않는다.
export type Runner = (cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string }>;

export async function detectClaude(run: Runner): Promise<{ installed: boolean; version: string | null }> {
  try {
    const r = await run('claude', ['--version']);
    if (r.code === 0) return { installed: true, version: r.stdout.trim() || null };
  } catch {
    // ENOENT 등 = 미설치
  }
  return { installed: false, version: null };
}

// 공식 설치 명령(DESIGN.md §12) — 설정창의 "복사" 버튼 내용.
export function claudeInstallCommand(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? 'irm https://claude.ai/install.ps1 | iex'
    : 'curl -fsSL https://claude.ai/install.sh | bash';
}

// 실제 러너(Electron 메인 전용). 테스트는 가짜 Runner를 주입한다.
export const spawnRunner: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
