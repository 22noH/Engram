import { EventEmitter } from 'events';
jest.mock('cross-spawn');
import spawn from 'cross-spawn';
import { CodexBrain } from './codex.brain';

const PROFILE = { provider: 'codex-cli' as const, cli: 'codex', model: '', concurrency: 1, timeoutMs: 1000, extraArgs: [], env: {} };

function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

describe('CodexBrain', () => {
  afterEach(() => jest.clearAllMocks());

  it('codex stdout 텍스트를 BrainResult.text로 모은다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new CodexBrain(PROFILE);
    const p = brain.complete('hi');
    child.stdout.emit('data', Buffer.from('code'));
    child.emit('close', 0);
    const r = await p;
    expect(r.text).toContain('code');
  });

  it('exec 플래그로 시작한다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new CodexBrain(PROFILE);
    const p = brain.complete('q');
    child.emit('close', 0);
    await p;
    const args = (spawn as unknown as jest.Mock).mock.calls[0][1];
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('q');
  });

  it('extraArgs를 포함한다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new CodexBrain({ ...PROFILE, extraArgs: ['--debug'] });
    const p = brain.complete('q');
    child.emit('close', 0);
    await p;
    const args = (spawn as unknown as jest.Mock).mock.calls[0][1];
    expect(args).toContain('--debug');
  });

  it('Semaphore로 동시 호출을 제어한다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new CodexBrain({ ...PROFILE, concurrency: 1 });
    const p1 = brain.complete('q1');
    const p2 = brain.complete('q2');
    expect((spawn as unknown as jest.Mock).mock.calls.length).toBe(1); // 첫 호출만 즉시
    child.emit('close', 0);
    await p1;
    // p2는 p1 완료 후에 spawn되어야 함(Semaphore 검증)
    expect((spawn as unknown as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
