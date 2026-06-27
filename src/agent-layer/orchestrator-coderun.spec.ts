import { Orchestrator } from './orchestrator';

function fakeBrain(text: string) { return { complete: () => Promise.resolve({ text, costUsd: 0, isError: false }) }; }
const logger = { warn() {}, log() {} } as any;
const project = { id: 'p', targetPath: 'C:/proj', branch: 'engram/x', writePaths: ['C:/proj'],
  gate: { test: 't', build: 'b', typecheck: 'tc' }, acceptanceCriteria: ['c1'], concurrency: 1, budget: { tokens: null }, approved: true };

describe('Orchestrator.codeRun', () => {
  it('게이트 초록이면 착지하고 완성조건 충족 시 SUCCESS', async () => {
    const tickets = [{ id: 'tk0', area: '.', instruction: 'i', status: 'PENDING', attempts: 0, gate: null }];
    const tasks = {
      createCoding: async () => ({ id: 's1' }), transition: async () => {}, addTickets: async () => {},
      recordProgress: async () => {}, contribute: async () => {},
      updateTicket: async (_i: string, id: string, patch: any) => { const t = tickets.find(x => x.id === id); Object.assign(t!, patch); },
      get: async () => ({ id: 's1', tickets, blackboard: {}, progress: { landed: tickets.filter(t=>t.status==='SUCCESS').length, criteriaMet: 0, criteriaTotal: 1 } }),
      setResult: async () => {}, remove: async () => {},
    };
    const o = new Orchestrator({} as any, {} as any, logger, {} as any,
      tasks as any, undefined, undefined, { run: (f: any) => f() } as any,
      { get: async () => project } as any,
      { run: async () => ({ pass: true, failed: null, output: '' }) } as any,
      { ensureBranch: async () => {}, commitAll: async () => {}, hasChanges: async () => true } as any,
      { work: async () => '코딩함' } as any,
      { review: async () => ({ approved: true, extraTickets: [] }) } as any,
      fakeBrain('{"tickets":[{"area":".","instruction":"i"}]}') as any);
    const r = await o.codeRun('p', { maxRounds: 5 });
    expect(r.status).toBe('SUCCESS');
  });

  it('게이트 계속 빨강 + 진전 없으면 STUCK', async () => {
    const tickets = [{ id: 'tk0', area: '.', instruction: 'i', status: 'PENDING', attempts: 0, gate: null }];
    const tasks = {
      createCoding: async () => ({ id: 's1' }), transition: async () => {}, addTickets: async () => {},
      recordProgress: async () => {}, contribute: async () => {},
      updateTicket: async (_i: string, id: string, patch: any) => { const t = tickets.find(x => x.id === id); Object.assign(t!, patch); },
      get: async () => ({ id: 's1', tickets, blackboard: {}, progress: { landed: 0, criteriaMet: 0, criteriaTotal: 1 } }),
      setResult: async () => {}, remove: async () => {},
    };
    const o = new Orchestrator({} as any, {} as any, logger, {} as any,
      tasks as any, undefined, undefined, { run: (f: any) => f() } as any,
      { get: async () => project } as any,
      { run: async () => ({ pass: false, failed: 'test', output: 'red' }) } as any,
      { ensureBranch: async () => {}, commitAll: async () => {}, hasChanges: async () => true } as any,
      { work: async () => 'x' } as any,
      { review: async () => ({ approved: false, extraTickets: [] }) } as any,
      fakeBrain('{"tickets":[{"area":".","instruction":"i"}]}') as any);
    const r = await o.codeRun('p', { maxRounds: 10, stuckK: 3 });
    expect(r.status).toBe('STUCK');
  });

  it('리뷰어가 계속 미승인이면 SUCCESS 안 되고 STUCK', async () => {
    const tickets = [{ id: 'tk0', area: '.', instruction: 'i', status: 'PENDING', attempts: 0, gate: null }];
    const tasks = {
      createCoding: async () => ({ id: 's1' }), transition: async () => {}, addTickets: async () => {},
      recordProgress: async () => {}, contribute: async () => {},
      updateTicket: async (_i: string, id: string, patch: any) => { const t = tickets.find(x => x.id === id)!; Object.assign(t, patch); },
      get: async () => ({ id: 's1', tickets, blackboard: {}, progress: { landed: tickets.filter(t=>t.status==='SUCCESS').length, criteriaMet: 0, criteriaTotal: 1 } }),
      setResult: async () => {}, remove: async () => {},
    };
    const o = new Orchestrator({} as any, {} as any, logger, {} as any,
      tasks as any, undefined, undefined, { run: (f: any) => f() } as any,
      { get: async () => project } as any, { run: async () => ({ pass: true, failed: null, output: '' }) } as any,
      { ensureBranch: async () => {}, commitAll: async () => {}, hasChanges: async () => true } as any,
      { work: async () => 'x' } as any,
      { review: async () => ({ approved: false, extraTickets: [] }) } as any,  // 영원히 미승인
      fakeBrain('{"tickets":[{"area":".","instruction":"i"}]}') as any);
    const r = await o.codeRun('p', { maxRounds: 20, stuckK: 3 });
    expect(r.status).toBe('STUCK');   // SUCCESS가 아니어야 한다
  });

  it('runState=stopped면 STOPPED', async () => {
    const tasks = {
      createCoding: async () => ({ id: 's1' }), transition: async () => {}, addTickets: async () => {},
      recordProgress: async () => {}, contribute: async () => {}, updateTicket: async () => {},
      get: async () => ({ id: 's1', tickets: [{ id: 'tk0', area: '.', instruction: 'i', status: 'PENDING', attempts: 0, gate: null }], blackboard: {}, progress: { landed: 0, criteriaMet: 0, criteriaTotal: 1 } }),
      setResult: async () => {}, remove: async () => {},
    };
    const o = new Orchestrator({} as any, {} as any, logger, {} as any,
      tasks as any, undefined, undefined, { run: (f: any) => f() } as any,
      { get: async () => project } as any, { run: async () => ({ pass: true, failed: null, output: '' }) } as any,
      { ensureBranch: async () => {}, commitAll: async () => {}, hasChanges: async () => true } as any,
      { work: async () => 'x' } as any, { review: async () => ({ approved: false, extraTickets: [] }) } as any,
      fakeBrain('{"tickets":[{"area":".","instruction":"i"}]}') as any);
    o.setRunState('stopped');
    const r = await o.codeRun('p', { maxRounds: 5 });
    expect(r.status).toBe('STOPPED');
  });
});

describe('proposeProject/approveProject', () => {
  it('완성조건 초안 추정 + approved=false 저장', async () => {
    let saved: any;
    const projects = { create: async (c: any) => { saved = c; return c; }, update: async (_id: string, p: any) => { saved = { ...saved, ...p }; return saved; }, get: async () => saved };
    const fence = { assertWritable: () => {} };
    const o = new Orchestrator({} as any, {} as any, logger, {} as any,
      {} as any, undefined, undefined, { run: (f: any) => f() } as any, projects as any,
      {} as any, {} as any, {} as any, {} as any,
      fakeBrain('{"acceptanceCriteria":["로그인 토큰 발급"],"gate":{"test":"npm test","build":"npm run build","typecheck":"tsc --noEmit"}}') as any,
      fence as any);
    const cfg = await o.proposeProject('C:/proj', '로그인 고쳐');
    expect(cfg.approved).toBe(false);
    expect(cfg.acceptanceCriteria).toContain('로그인 토큰 발급');
    expect(cfg.gate.test).toBe('npm test');
    await o.approveProject(cfg.id);
    expect(saved.approved).toBe(true);
  });

  it('denyPaths 타깃은 거부', async () => {
    const fence = { assertWritable: () => { throw new Error('금지'); } };
    const o = new Orchestrator({} as any, {} as any, logger, {} as any,
      {} as any, undefined, undefined, { run: (f: any) => f() } as any, { create: async (c: any) => c } as any,
      {} as any, {} as any, {} as any, {} as any, fakeBrain('{}') as any, fence as any);
    await expect(o.proposeProject('C:/engram', 'x')).rejects.toThrow();
  });
});
