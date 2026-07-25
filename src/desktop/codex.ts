import * as os from 'os';
import * as path from 'path';
import { resolveCli, Runner } from './claude-detect';
import { mergeBrainProfile } from './brains-file';

// Codex 도우미(설정 → 모델의 "Codex 추가" 원클릭 등록). ollama.ts와 같은 구조:
// detect*(감지) + add*Profile(brains.json 병합). 감지는 claude-detect.ts의 탐색 관례를 그대로 재사용
// (PATH → 잘 알려진 설치 위치). 실측(2026-07-25 이 머신): npm 전역 설치가 %APPDATA%\npm\codex.

function fallbackCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const home = env.USERPROFILE || os.homedir();
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    // npm 전역이 표준 설치 경로. 윈도우에서 실행 가능한 건 확장자 붙은 shim(codex.cmd)이다.
    return [path.join(appData, 'npm', 'codex.cmd'), path.join(home, '.local', 'bin', 'codex.exe')];
  }
  const home = env.HOME || os.homedir();
  return [path.join(home, '.local', 'bin', 'codex'), '/usr/local/bin/codex', '/opt/homebrew/bin/codex'];
}

export async function detectCodex(
  run: Runner,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<{ installed: boolean; version: string | null; command: string }> {
  return resolveCli('codex', run, fallbackCandidates(env, platform));
}

// 미설치 안내용 설치 명령(플랫폼 무관 — codex는 npm 전역 배포).
export function codexInstallCommand(): string {
  return 'npm install -g @openai/codex';
}

// brains.json 등록. cli에는 탐지된 경로를 그대로 넣는다(PATH로 잡혔으면 'codex').
// 같은 이름이면 덮어쓴다(ollama 추가와 동일 규칙 — UI가 버튼 라벨을 "덮어쓰기"로 바꿔 미리 알린다).
export function addCodexProfile(configDir: string, name: string, cli: string, setDefault = false): void {
  mergeBrainProfile(configDir, name, { provider: 'codex-cli', cli }, setDefault);
}
