import spawn from 'cross-spawn';
import { WebToolDef } from './web-tools';

// 명령 실행 도구(스펙 §6.1). shell:true로 실행 — 기본 auto(아무 명령이나). 안전은 타임아웃 트리종료·출력상한·never-throw.
export const MAX_SHELL_TIMEOUT_MS = 120_000; // 명령별 타임아웃
export const SHELL_OUTPUT_LIMIT = 20_000;    // 반환 출력 마지막 N자

// 명령 판정(막히면 throw). agent-layer가 fence.assertCommandAllowed를 바인딩해 주입. auto 모드면 사실상 no-op.
export type CommandGuard = (command: string) => void;

export const BASH_TOOL_DEF: WebToolDef = {
  name: 'Bash',
  description:
    'Run a shell command in the working directory and return its combined output and exit code. ' +
    'Use it to run tests, builds, linters, or any command needed to verify your changes.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string', description: 'The shell command to run' } },
    required: ['command'],
  },
};

// 프로세스 트리 강제종료(자식까지). Win=taskkill /T /F, POSIX=프로세스그룹 kill(detached로 그룹 생성).
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F']); } catch { /* best effort */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 종료 */ } }
  }
}

// 실행 — never-throw. 타임아웃/abort 시 트리종료, 출력 상한.
export function runShellTool(input: unknown, cwd: string, guard: CommandGuard, signal: AbortSignal): Promise<string> {
  const arg = (input ?? {}) as Record<string, unknown>;
  if (typeof arg.command !== 'string' || !arg.command.trim()) return Promise.resolve('Bash error: command(string) required');
  try { guard(arg.command); } catch (e) { return Promise.resolve(`Bash blocked: ${String(e)}`); }

  return new Promise<string>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(arg.command as string, [], {
        cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32', // POSIX: 자기 프로세스그룹 → -pid로 트리 kill
      });
    } catch (e) {
      // spawn()은 동기 throw 가능(예: 명령 과다 길이 → Windows ENAMETOOLONG). never-throw 유지 위해 여기서 흡수.
      resolve(`Bash error: ${String(e)}`);
      return;
    }
    let out = '';
    let done = false;
    const finish = (text: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(text);
    };
    const onAbort = (): void => { if (child.pid) killTree(child.pid); finish('[timeout] aborted'); };
    const timer = setTimeout(() => { if (child.pid) killTree(child.pid); finish(`[timeout] exceeded ${MAX_SHELL_TIMEOUT_MS}ms`); }, MAX_SHELL_TIMEOUT_MS);
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort);
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', (e) => finish(`Bash error: ${String(e)}`));
    child.on('close', (code) => finish(`[exit ${code ?? 1}]\n${out.slice(-SHELL_OUTPUT_LIMIT)}`));
  });
}
