import { EventEmitter } from 'events';
jest.mock('cross-spawn');
import spawn from 'cross-spawn';
import { spawnTextBrain } from './text-brain';

const PROFILE = { provider: 'gemini-cli' as const, cli: 'g', model: '', concurrency: 1, timeoutMs: 1000, extraArgs: [], env: {} };

function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

describe('spawnTextBrain', () => {
  afterEach(() => jest.clearAllMocks());

  it('spawnTextBrain은 stdout을 모아 BrainResult로 정규화', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const p = spawnTextBrain(PROFILE, ['-p', 'hi']);
    child.stdout.emit('data', Buffer.from('안녕'));
    child.emit('close', 0);
    const r = await p;
    expect(r.isError).toBe(false);
    expect(r.text).toContain('안녕');
  });

  it('비정상 종료코드는 isError', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const p = spawnTextBrain(PROFILE, []);
    child.emit('close', 1);
    const r = await p;
    expect(r.isError).toBe(true);
  });

  it('spawn 에러 시 isError를 반환한다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const p = spawnTextBrain(PROFILE, []);
    child.emit('error', new Error('ENOENT'));
    const r = await p;
    expect(r.isError).toBe(true);
  });

  it('타임아웃 시 isError를 반환하고 kill한다', async () => {
    jest.useFakeTimers();
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const p = spawnTextBrain({ ...PROFILE, timeoutMs: 50 }, []);
    jest.advanceTimersByTime(60);
    const r = await p;
    expect(r.isError).toBe(true);
    expect(child.kill).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('onChunk 콜백을 data 이벤트마다 호출한다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const chunks: string[] = [];
    const p = spawnTextBrain(PROFILE, ['-p', 'hi'], (t) => chunks.push(t));
    child.stdout.emit('data', Buffer.from('가'));
    child.stdout.emit('data', Buffer.from('나'));
    child.emit('close', 0);
    const r = await p;
    expect(chunks).toEqual(['가', '나']);
    expect(r.text).toBe('가나');
  });

  it('profile.env가 spawn 환경에 병합된다', async () => {
    const child = fakeChild();
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const p = spawnTextBrain({ ...PROFILE, env: { GEMINI_KEY: 'xyz' } }, []);
    child.emit('close', 0);
    await p;
    const opts = (spawn as unknown as jest.Mock).mock.calls[0][2];
    expect(opts.env.GEMINI_KEY).toBe('xyz');
  });
});
