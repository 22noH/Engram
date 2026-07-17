import { BASH_TOOL_DEF, runShellTool, MAX_SHELL_TIMEOUT_MS, SHELL_OUTPUT_LIMIT, CommandGuard } from './shell-tool';

const NO_ABORT = new AbortController().signal;
const allow: CommandGuard = () => {};
const cwd = process.cwd();

describe('BASH_TOOL_DEF', () => {
  it('name Bash, command 필수', () => {
    expect(BASH_TOOL_DEF.name).toBe('Bash');
    expect((BASH_TOOL_DEF.parameters as any).required).toEqual(['command']);
    expect(MAX_SHELL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SHELL_OUTPUT_LIMIT).toBeGreaterThan(0);
  });
});

describe('runShellTool (never-throw)', () => {
  it('정상 명령 → [exit 0] + stdout', async () => {
    const r = await runShellTool({ command: `node -e "console.log('hi')"` }, cwd, allow, NO_ABORT);
    expect(r).toContain('[exit 0]');
    expect(r).toContain('hi');
  });

  it('셸 기능(체이닝) 동작 — auto', async () => {
    const r = await runShellTool({ command: `node -e "console.log(1)" && node -e "console.log(2)"` }, cwd, allow, NO_ABORT);
    expect(r).toContain('1');
    expect(r).toContain('2');
  });

  it('비영 종료코드 → [exit N] (에러 아님)', async () => {
    const r = await runShellTool({ command: `node -e "process.exit(3)"` }, cwd, allow, NO_ABORT);
    expect(r).toContain('[exit 3]');
  });

  it('가드가 막으면 spawn 안 하고 blocked 텍스트', async () => {
    const deny: CommandGuard = (c) => { throw new Error(`denied ${c}`); };
    const r = await runShellTool({ command: `node -e "1"` }, cwd, deny, NO_ABORT);
    expect(r).toContain('Bash blocked');
  });

  it('오염 인자(command 누락) → 에러 텍스트', async () => {
    expect(await runShellTool({}, cwd, allow, NO_ABORT)).toContain('required');
    expect(await runShellTool(null, cwd, allow, NO_ABORT)).toContain('required');
  });

  it('abort 시 트리종료 + [timeout]', async () => {
    const ctrl = new AbortController();
    const p = runShellTool({ command: `node -e "setTimeout(()=>{}, 999999)"` }, cwd, allow, ctrl.signal);
    setTimeout(() => ctrl.abort(), 100);
    const r = await p;
    expect(r).toContain('[timeout]');
  });

  it('진입 시 이미 aborted면 즉시 종료 + 문자열 resolve(크래시 아님)', async () => {
    const ctrl = new AbortController();
    ctrl.abort(); // 호출 전에 이미 abort
    const r = await runShellTool({ command: `node -e "console.log('x')"` }, cwd, allow, ctrl.signal);
    expect(typeof r).toBe('string');
    expect(r).toContain('[timeout]');
  });

  // spawn()은 동기 throw 가능(Windows ENAMETOOLONG 등) — executor 안에서 안 잡으면 Promise가 reject되어
  // never-throw가 깨진다. 계약(=reject 안 하고 문자열 resolve)을 OS 무관하게 고정(Win은 'Bash error', 그 외는 정상실행).
  it('매우 긴 명령에도 reject 아님(never-throw)', async () => {
    const hugeCommand = `node -e "1" ` + '#'.repeat(60_000);
    const r = await runShellTool({ command: hugeCommand }, cwd, allow, NO_ABORT);
    expect(typeof r).toBe('string');
  });
});
