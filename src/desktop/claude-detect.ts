import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import spawn from 'cross-spawn';

// claude CLI 설치 감지(스펙 §4 두뇌 연결). 로그인 여부는 실 API 콜 비용 때문에 감지하지 않는다.
export type Runner = (cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string }>;

// 잘 알려진 설치 위치 폴백 후보(실사고: 설치 직후 PATH 미상속 머신). 존재 순서대로 시도.
// win32: 공식 설치기(irm install.ps1) → ~/.local/bin/claude.exe, npm 전역 → %APPDATA%/npm/claude.cmd.
// darwin/linux: 공식 설치기 → ~/.local/bin/claude, 기타 일반적 PATH 밖 설치 위치.
function fallbackCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const home = env.USERPROFILE || os.homedir();
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return [path.join(home, '.local', 'bin', 'claude.exe'), path.join(appData, 'npm', 'claude.cmd')];
  }
  const home = env.HOME || os.homedir();
  return [path.join(home, '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'];
}

// claude를 실행 가능한 명령으로 해소(설치 직후 PATH 미상속 머신 대응). 먼저 PATH의 'claude'를
// 시도하고(기존 동작 그대로), 실패하면 잘 알려진 설치 위치를 존재확인(fs) 후 순서대로 --version
// 실행해본다. 처음으로 종료코드 0인 후보의 절대경로가 command. 전부 실패하면 installed:false
// (이때 command는 'claude' — 호출부가 그대로 써도 기존 미설치 동작과 동일).
export async function resolveClaude(
  run: Runner,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<{ installed: boolean; version: string | null; command: string }> {
  try {
    const r = await run('claude', ['--version']);
    if (r.code === 0) return { installed: true, version: r.stdout.trim() || null, command: 'claude' };
  } catch {
    // ENOENT 등 = PATH에 없음 — 폴백 후보 탐색으로 진행
  }
  for (const candidate of fallbackCandidates(env, platform)) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const r = await run(candidate, ['--version']);
      if (r.code === 0) return { installed: true, version: r.stdout.trim() || null, command: candidate };
    } catch {
      // 이 후보도 실행 실패 — 다음 후보 계속
    }
  }
  return { installed: false, version: null, command: 'claude' };
}

// 후방호환 얇은 래퍼 — 기존 호출부(설정창 등)는 installed/version만 필요했다.
export async function detectClaude(run: Runner): Promise<{ installed: boolean; version: string | null }> {
  const { installed, version } = await resolveClaude(run);
  return { installed, version };
}

// 서버 자식 프로세스(startChild)가 물려받을 env 패치(순수, 부작용 없음). 사용자가 이미
// ENGRAM_BRAIN_CLI를 지정했으면 절대 건드리지 않는다(런타임 오버레이만, brains.json 재작성 없음).
// resolveClaude가 PATH가 아니라 잘 알려진 설치 위치에서 찾았을 때만(command !== 'claude') 그
// 절대경로를 반환 — brain.config.ts의 resolve()가 이미 ENGRAM_BRAIN_CLI를 profile.cli보다
// 우선시키는 기존 훅을 그대로 재사용한다(새 주입 경로를 만들지 않음).
export function claudeCliEnvOverride(
  currentEnv: NodeJS.ProcessEnv,
  resolved: { installed: boolean; command: string },
): string | undefined {
  if (currentEnv.ENGRAM_BRAIN_CLI) return undefined;
  if (!resolved.installed || resolved.command === 'claude') return undefined;
  return resolved.command;
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
