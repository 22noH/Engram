import { Orchestrator } from './orchestrator';

describe('Orchestrator (스텁)', () => {
  it('route는 reader.handle로 위임하고 onChunk를 통과시킨다', async () => {
    const reader = { handle: jest.fn(async () => '답') } as any;
    const orch = new Orchestrator(reader);
    const cb = jest.fn();
    const out = await orch.route({ text: 'q', userId: 'default' }, cb);
    expect(out).toBe('답');
    expect(reader.handle).toHaveBeenCalledWith({ text: 'q', userId: 'default' }, cb);
  });
});
