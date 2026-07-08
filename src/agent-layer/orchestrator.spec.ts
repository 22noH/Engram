import { Orchestrator, DECOMPOSE_DEFAULT, AMBIENT_DEFAULT, TRIAGE_DEFAULT } from './orchestrator';

describe('Orchestrator.decompose', () => {
  const make = () => new Orchestrator({} as any, {} as any, { warn() {}, log() {} } as any, {} as any);
  it('JSON 티켓 분할 파싱', async () => {
    const brain = { complete: () => Promise.resolve({ text: '{"tickets":[{"area":"src/a","instruction":"i1"},{"area":"src/b","instruction":"i2"}]}', costUsd: 0, isError: false }) };
    const t = await make().decompose('목표', brain as any);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ area: 'src/a', instruction: 'i1' });
    expect(t[0].id).toBeTruthy();
  });
  it('파싱 실패는 단일 티켓 폴백', async () => {
    const brain = { complete: () => Promise.resolve({ text: 'JSON 아님', costUsd: 0, isError: false }) };
    const t = await make().decompose('목표', brain as any);
    expect(t).toHaveLength(1);
    expect(t[0].instruction).toContain('목표');
  });
});

describe('Orchestrator (스텁)', () => {
  it('route는 reader.handle로 위임하고 onChunk를 통과시킨다', async () => {
    const reader = { handle: jest.fn(async () => '답') } as any;
    const convStore = { append: async () => {} } as any;
    const orch = new Orchestrator(reader, convStore, { warn: () => {} } as any, {} as any);
    const cb = jest.fn();
    const out = await orch.route({ text: 'q', userId: 'default' }, cb);
    expect(out).toBe('답');
    expect(reader.handle).toHaveBeenCalledWith({ text: 'q', userId: 'default' }, cb, expect.any(Function));
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

  it('route는 reader가 노출한 인용 slug를 대화기록 sources에 적재한다', async () => {
    const reader = { handle: async (_m: any, _c: any, onSources?: (s: string[]) => void) => { onSources?.(['p1', 'p2']); return '답'; } };
    const appended: any[] = [];
    const conversations = { append: async (_u: string, rec: any) => { appended.push(rec); } };
    const logger = { warn: () => {} };
    const orch = new Orchestrator(reader as any, conversations as any, logger as any, {} as any);
    await orch.route({ text: 'q', userId: 'default' });
    expect(appended[0].sources).toEqual(['p1', 'p2']);
  });

  it('insight()는 reporter에 위임한다', async () => {
    const reporter = { run: async () => ({ date: '2026-06-28', metrics: {} as any, report: 'r' }) };
    const orch = new Orchestrator(
      {} as any, {} as any, { warn: () => {} } as any, {} as any,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, reporter as any,
    );
    expect((await orch.insight('default'))?.report).toBe('r');
  });

  it('classification defaults are English', () => {
    for (const s of [DECOMPOSE_DEFAULT, AMBIENT_DEFAULT, TRIAGE_DEFAULT]) expect(/[가-힣]/.test(s)).toBe(false);
  });
});
