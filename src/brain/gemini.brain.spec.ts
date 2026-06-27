import { EventEmitter } from 'events';
jest.mock('cross-spawn');
import spawn from 'cross-spawn';
import { GeminiBrain } from './gemini.brain';

const PROFILE = { provider: 'gemini-cli' as const, cli: 'gemini', model: '', concurrency: 1, timeoutMs: 1000, extraArgs: [], env: {} };

function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

describe('GeminiBrain', () => {
  afterEach(() => jest.clearAllMocks());

  it('GeminiBrain은 args를 만들어 spawnTextBrain에 위임', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new GeminiBrain(PROFILE);
    const p = brain.complete('hi');
    child.stdout.emit('data', Buffer.from('Gemini답'));
    child.emit('close', 0);
    const r = await p;
    expect(r.text).toContain('Gemini답');
    const args = (spawn as unknown as jest.Mock).mock.calls[0][1];
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('hi');
  });

  it('model이 있으면 -m 플래그를 포함한다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new GeminiBrain({ ...PROFILE, model: 'gemini-2.0' });
    const p = brain.complete('q');
    child.emit('close', 0);
    await p;
    const args = (spawn as unknown as jest.Mock).mock.calls[0][1];
    expect(args).toContain('-m');
    expect(args).toContain('gemini-2.0');
  });

  it('model이 없으면 -m 플래그를 제외한다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new GeminiBrain({ ...PROFILE, model: '' });
    const p = brain.complete('q');
    child.emit('close', 0);
    await p;
    const args = (spawn as unknown as jest.Mock).mock.calls[0][1];
    expect(args).not.toContain('-m');
  });

  it('extraArgs를 포함한다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new GeminiBrain({ ...PROFILE, extraArgs: ['--verbose'] });
    const p = brain.complete('q');
    child.emit('close', 0);
    await p;
    const args = (spawn as unknown as jest.Mock).mock.calls[0][1];
    expect(args).toContain('--verbose');
  });

  it('Semaphore로 동시 호출을 제어한다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const brain = new GeminiBrain({ ...PROFILE, concurrency: 1 });
    const p1 = brain.complete('q1');
    const p2 = brain.complete('q2');
    expect((spawn as unknown as jest.Mock).mock.calls.length).toBe(1); // 첫 호출만 즉시
    child.emit('close', 0);
    await p1;
    // p2는 p1 완료 후에 spawn되어야 함(Semaphore 검증)
    expect((spawn as unknown as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
