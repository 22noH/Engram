import { Orchestrator } from './orchestrator';

describe('Orchestrator (스텁)', () => {
  it('route는 reader.handle로 위임하고 onChunk를 통과시킨다', async () => {
    const reader = { handle: jest.fn(async () => '답') } as any;
    const convStore = { append: async () => {} } as any;
    const orch = new Orchestrator(reader, convStore, { warn: () => {} } as any, {} as any);
    const cb = jest.fn();
    const out = await orch.route({ text: 'q', userId: 'default' }, cb);
    expect(out).toBe('답');
    expect(reader.handle).toHaveBeenCalledWith({ text: 'q', userId: 'default' }, cb);
  });

  it('route 후 대화를 ConversationStore에 적재한다', async () => {
    const appended: any[] = [];
    const convStore = { append: async (_u: string, r: any) => { appended.push(r); } } as any;
    const reader = { handle: async () => 'the answer' } as any;
    const orch = new Orchestrator(reader, convStore, { warn: () => {} } as any, {} as any);
    await orch.route({ text: 'my question', userId: 'default' });
    expect(appended).toHaveLength(1);
    expect(appended[0].question).toBe('my question');
    expect(appended[0].answer).toBe('the answer');
    expect(typeof appended[0].ts).toBe('string');
  });

  it('append가 실패해도 답변을 반환하고 throw하지 않는다', async () => {
    const convStore = { append: async () => { throw new Error('disk full'); } } as any;
    const reader = { handle: async () => 'the answer' } as any;
    const logger = { warn: jest.fn() } as any;
    const orch = new Orchestrator(reader, convStore, logger, {} as any);
    const out = await orch.route({ text: 'q', userId: 'default' });
    expect(out).toBe('the answer');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('digest는 IngesterAgent.run에 위임한다', async () => {
    const ingester = { run: jest.fn().mockResolvedValue({ extracted: 2, gated: 1, proposed: 1 }) } as any;
    const orch = new Orchestrator({} as any, {} as any, { warn: () => {} } as any, ingester);
    expect(await orch.digest('default')).toEqual({ extracted: 2, gated: 1, proposed: 1 });
    expect(ingester.run).toHaveBeenCalledWith('default');
  });
});
