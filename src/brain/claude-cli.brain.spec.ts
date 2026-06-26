import { EventEmitter } from 'events';
jest.mock('cross-spawn');
import spawn from 'cross-spawn';
import { ClaudeCliBrain } from './claude-cli.brain';
import { BrainProfile } from './brain.config';

const PROFILE: BrainProfile = { provider: 'claude-cli', cli: 'claude', model: '', concurrency: 1, timeoutMs: 1000, extraArgs: [] };

function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

describe('ClaudeCliBrain', () => {
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
});
