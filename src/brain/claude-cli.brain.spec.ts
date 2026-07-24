import { EventEmitter } from 'events';
jest.mock('cross-spawn');
jest.mock('./claude-mcp-import');
import spawn from 'cross-spawn';
import { ClaudeCliBrain } from './claude-cli.brain';
import { BrainProfile } from './brain.config';
import { readClaudeMcpServers } from './claude-mcp-import';

const mockReadClaudeMcpServers = readClaudeMcpServers as jest.Mock;

const PROFILE: BrainProfile = { provider: 'claude-cli', cli: 'claude', model: '', concurrency: 1, timeoutMs: 1000, extraArgs: [] };

function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

describe('ClaudeCliBrain', () => {
  beforeEach(() => mockReadClaudeMcpServers.mockReturnValue([]));
  afterEach(() => jest.clearAllMocks());

  it('stream-json을 파싱해 텍스트 델타·최종 결과·비용을 정규화한다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new ClaudeCliBrain(PROFILE);
    const chunks: string[] = [];
    const p = brain.complete('q', (t) => chunks.push(t));
    child.stdout.emit('data', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '안녕' }] } }) + '\n');
    child.stdout.emit('data', JSON.stringify({ type: 'result', is_error: false, result: '안녕하세요', total_cost_usd: 0.01 }) + '\n');
    child.emit('close', 0);
    const r = await p;
    expect(chunks.join('')).toBe('안녕');
    expect(r.text).toBe('안녕하세요');
    expect(r.costUsd).toBe(0.01);
    expect(r.isError).toBe(false);
  });

  it('여러 data 청크에 걸친 JSON 줄을 버퍼링한다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new ClaudeCliBrain(PROFILE);
    const p = brain.complete('q');
    const line = JSON.stringify({ type: 'result', is_error: false, result: '쪼개진답', total_cost_usd: 0 }) + '\n';
    child.stdout.emit('data', line.slice(0, 10));
    child.stdout.emit('data', line.slice(10));
    child.emit('close', 0);
    const r = await p;
    expect(r.text).toBe('쪼개진답');
  });

  it('spawn 에러 시 isError를 반환한다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new ClaudeCliBrain(PROFILE);
    const p = brain.complete('q');
    child.emit('error', new Error('ENOENT'));
    const r = await p;
    expect(r.isError).toBe(true);
  });

  it('타임아웃 시 isError를 반환하고 kill한다', async () => {
    jest.useFakeTimers();
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new ClaudeCliBrain({ ...PROFILE, timeoutMs: 50 });
    const p = brain.complete('q');
    jest.advanceTimersByTime(60);
    const r = await p;
    expect(r.isError).toBe(true);
    expect(child.kill).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('opts.signal abort 시 isError(raw=aborted)를 반환하고 자식을 kill한다(pid 미확보=폴백 kill)', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new ClaudeCliBrain(PROFILE);
    const ctrl = new AbortController();
    const p = brain.complete('q', undefined, { signal: ctrl.signal });
    ctrl.abort();
    const r = await p;
    expect(r.isError).toBe(true);
    expect(r.raw).toBe('aborted');
    expect(child.kill).toHaveBeenCalled();
  });

  it('진입 시 이미 opts.signal이 aborted면 즉시 aborted로 끝난다(멈춰있지 않음)', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new ClaudeCliBrain(PROFILE);
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await brain.complete('q', undefined, { signal: ctrl.signal });
    expect(r.isError).toBe(true);
    expect(r.raw).toBe('aborted');
  });

  it('opts.signal abort 시 pid가 있으면(Win) killTree가 taskkill /T /F로 트리종료한다', async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const child = fakeChild();
      child.pid = 4321;
      (spawn as unknown as jest.Mock).mockReturnValue(child);
      const brain = new ClaudeCliBrain(PROFILE);
      const ctrl = new AbortController();
      const p = brain.complete('q', undefined, { signal: ctrl.signal });
      ctrl.abort();
      const r = await p;
      expect(r.isError).toBe(true);
      expect(r.raw).toBe('aborted');
      const killCall = (spawn as unknown as jest.Mock).mock.calls.find((c) => c[0] === 'taskkill');
      expect(killCall).toBeDefined();
      expect(killCall![1]).toEqual(['/pid', '4321', '/T', '/F']);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('profile.env가 spawn 환경에 병합된다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new ClaudeCliBrain({ ...PROFILE, env: { ANTHROPIC_BASE_URL: 'http://x' } });
    const p = brain.complete('hi');
    child.emit('close', 0);
    await p;
    const opts = (spawn as unknown as jest.Mock).mock.calls[0][2];
    expect(opts.env.ANTHROPIC_BASE_URL).toBe('http://x');
  });

  it('opts.cwd·extraArgs를 spawn에 반영한다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new ClaudeCliBrain(PROFILE);
    const p = brain.complete('q', undefined, { cwd: 'C:/proj', extraArgs: ['--allowedTools', 'Bash'] });
    child.emit('close', 0);
    await p;
    const [, args, opts] = (spawn as unknown as jest.Mock).mock.calls[0];
    expect(opts.cwd).toBe('C:/proj');
    expect(args).toEqual(expect.arrayContaining(['--allowedTools', 'Bash']));
  });

  it('--allowedTools 미지정 프로필이면 WebSearch,WebFetch를 기본 주입한다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new ClaudeCliBrain(PROFILE); // extraArgs: []
    const p = brain.complete('q');
    child.emit('close', 0);
    await p;
    const args = (spawn as unknown as jest.Mock).mock.calls[0][1] as string[];
    const i = args.indexOf('--allowedTools');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('WebSearch,WebFetch,mcp__engram,mcp__plugin_engram_engram');
  });

  it('프로필이 --allowedTools를 직접 주면 기본 주입을 안 한다(중복 방지)', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new ClaudeCliBrain({ ...PROFILE, extraArgs: ['--allowedTools', 'Bash'] });
    const p = brain.complete('q');
    child.emit('close', 0);
    await p;
    const args = (spawn as unknown as jest.Mock).mock.calls[0][1] as string[];
    expect(args.filter((a) => a === '--allowedTools')).toHaveLength(1);
    expect(args).toEqual(expect.arrayContaining(['--allowedTools', 'Bash']));
    expect(args).not.toContain('WebSearch,WebFetch');
    // 프로필 지정 우선(회귀): 지정된 경로에서는 판독을 아예 참조하지 않는다.
    expect(mockReadClaudeMcpServers).not.toHaveBeenCalled();
  });

  it('클로드 MCP 판독 결과를 allowedTools에 mcp__<이름>·플러그인 변형으로 포함한다', async () => {
    mockReadClaudeMcpServers.mockReturnValue([
      { name: 'github', command: 'gh-mcp' },
      { name: 'docs', command: 'docs-mcp', pluginName: 'vercel' },
    ]);
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new ClaudeCliBrain(PROFILE);
    const p = brain.complete('q');
    child.emit('close', 0);
    await p;
    const args = (spawn as unknown as jest.Mock).mock.calls[0][1] as string[];
    const i = args.indexOf('--allowedTools');
    const list = args[i + 1].split(',');
    expect(list).toEqual(
      expect.arrayContaining([
        'WebSearch', 'WebFetch', 'mcp__engram', 'mcp__plugin_engram_engram',
        'mcp__github', 'mcp__docs', 'mcp__plugin_vercel_docs',
      ]),
    );
  });

  it('클로드 MCP 판독이 throw하면 고정 기본 4개로 폴백한다', async () => {
    mockReadClaudeMcpServers.mockImplementation(() => { throw new Error('boom'); });
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new ClaudeCliBrain(PROFILE);
    const p = brain.complete('q');
    child.emit('close', 0);
    await p;
    const args = (spawn as unknown as jest.Mock).mock.calls[0][1] as string[];
    const i = args.indexOf('--allowedTools');
    expect(args[i + 1]).toBe('WebSearch,WebFetch,mcp__engram,mcp__plugin_engram_engram');
  });

  it('판독 이름이 고정 기본과 중복되면 한 번만 포함한다', async () => {
    mockReadClaudeMcpServers.mockReturnValue([{ name: 'engram', command: 'engram-mcp' }]);
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new ClaudeCliBrain(PROFILE);
    const p = brain.complete('q');
    child.emit('close', 0);
    await p;
    const args = (spawn as unknown as jest.Mock).mock.calls[0][1] as string[];
    const i = args.indexOf('--allowedTools');
    const list = args[i + 1].split(',');
    expect(list.filter((x) => x === 'mcp__engram')).toHaveLength(1);
  });

  it('opts.timeoutMs가 profile.timeoutMs를 덮어쓴다', async () => {
    jest.useFakeTimers();
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new ClaudeCliBrain({ ...PROFILE, timeoutMs: 100000 });
    const p = brain.complete('q', undefined, { timeoutMs: 50 });
    jest.advanceTimersByTime(60);
    const r = await p;
    expect(r.isError).toBe(true);
    jest.useRealTimers();
  });

  describe('onTool(두뇌 활동 표시 Task 1) — stream-json tool_use 이벤트', () => {
    it('assistant 메시지의 tool_use 블록마다 이름·1부터 시작하는 순번으로 발화한다', async () => {
      const child = fakeChild();
      (spawn as unknown as jest.Mock).mockReturnValue(child);
      const brain = new ClaudeCliBrain(PROFILE);
      const calls: Array<{ name: string; seq: number }> = [];
      const p = brain.complete('q', undefined, { onTool: (name, seq) => calls.push({ name, seq }) });
      child.stdout.emit('data', JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'WebSearch', input: {} }] },
      }) + '\n');
      child.stdout.emit('data', JSON.stringify({ type: 'result', is_error: false, result: '답', total_cost_usd: 0 }) + '\n');
      child.emit('close', 0);
      await p;
      expect(calls).toEqual([{ name: 'WebSearch', seq: 1 }]);
    });

    it('한 assistant 메시지에 tool_use 블록이 여러 개면 등장 순서대로 순번이 매겨진다(텍스트 블록은 무시)', async () => {
      const child = fakeChild();
      (spawn as unknown as jest.Mock).mockReturnValue(child);
      const brain = new ClaudeCliBrain(PROFILE);
      const calls: Array<{ name: string; seq: number }> = [];
      const p = brain.complete('q', undefined, { onTool: (name, seq) => calls.push({ name, seq }) });
      child.stdout.emit('data', JSON.stringify({
        type: 'assistant',
        message: { content: [
          { type: 'text', text: '검색해볼게요' },
          { type: 'tool_use', id: 'tu_1', name: 'web_search', input: {} },
          { type: 'tool_use', id: 'tu_2', name: 'fetch_url', input: {} },
        ] },
      }) + '\n');
      child.emit('close', 0);
      await p;
      expect(calls).toEqual([{ name: 'web_search', seq: 1 }, { name: 'fetch_url', seq: 2 }]);
    });

    it('여러 assistant 메시지(여러 턴)에 걸쳐 순번이 누적된다', async () => {
      const child = fakeChild();
      (spawn as unknown as jest.Mock).mockReturnValue(child);
      const brain = new ClaudeCliBrain(PROFILE);
      const calls: Array<{ name: string; seq: number }> = [];
      const p = brain.complete('q', undefined, { onTool: (name, seq) => calls.push({ name, seq }) });
      child.stdout.emit('data', JSON.stringify({
        type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'a', input: {} }] },
      }) + '\n');
      child.stdout.emit('data', JSON.stringify({
        type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'b', input: {} }] },
      }) + '\n');
      child.emit('close', 0);
      await p;
      expect(calls).toEqual([{ name: 'a', seq: 1 }, { name: 'b', seq: 2 }]);
    });

    it('opts.onTool 미주입이면 파싱은 기존과 동일(회귀 0, 크래시 없음)', async () => {
      const child = fakeChild();
      (spawn as unknown as jest.Mock).mockReturnValue(child);
      const brain = new ClaudeCliBrain(PROFILE);
      const p = brain.complete('q');
      child.stdout.emit('data', JSON.stringify({
        type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'a', input: {} }] },
      }) + '\n');
      child.stdout.emit('data', JSON.stringify({ type: 'result', is_error: false, result: '답', total_cost_usd: 0 }) + '\n');
      child.emit('close', 0);
      const r = await p;
      expect(r.text).toBe('답');
      expect(r.isError).toBe(false);
    });

    it('onTool이 던져도 파싱 루프는 계속된다(never-throw 격리)', async () => {
      const child = fakeChild();
      (spawn as unknown as jest.Mock).mockReturnValue(child);
      const brain = new ClaudeCliBrain(PROFILE);
      const p = brain.complete('q', undefined, { onTool: () => { throw new Error('ui boom'); } });
      child.stdout.emit('data', JSON.stringify({
        type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'a', input: {} }] },
      }) + '\n');
      child.stdout.emit('data', JSON.stringify({ type: 'result', is_error: false, result: '답', total_cost_usd: 0 }) + '\n');
      child.emit('close', 0);
      const r = await p;
      expect(r.text).toBe('답');
      expect(r.isError).toBe(false);
    });
  });
});
