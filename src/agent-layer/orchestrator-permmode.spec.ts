import { Orchestrator } from './orchestrator';

// 채널 권한 모드(permMode) 관통 — "이 턴에 어디까지 알아서 할지"를 orchestrator 한 지점에서 정하고
// 코딩 실행부(fence/cmdGuard)까지 턴 단위로 흘린다. 부팅 시 캐시한 전역값이 아님을 여기서 못박는다.
const logger = { warn() {}, error() {}, log() {} } as any;

function makeOrch(brainText: string, over: { fence?: any } = {}) {
  const brain = { complete: async () => ({ text: brainText, costUsd: 0, isError: false }) } as any;
  const conversations = { append: async () => {}, recent: async () => [] } as any;
  const projects = {} as any;
  const fence = over.fence ?? ({ assertWritable() {} } as any);
  const registry = { all: () => [] } as any;
  return new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    projects, null as any, null as any, null as any, null as any,
    brain, fence, null as any, registry, null as any,
  );
}

function collect() {
  const posts: Array<{ text: string; actions?: any[] }> = [];
  const post = async (text: string, actions?: any[]) => { posts.push({ text, actions }); };
  return { posts, post };
}

const PROPOSE = '바로 붙일게.\n```engram:propose\n{"goal":"로그인 붙이기"}\n```';

describe('resolveTurnPermMode — 단일 결정 지점', () => {
  it('코드 채널이면 채널에 저장된 값을 쓴다', () => {
    const o = makeOrch('x');
    expect((o as any).resolveTurnPermMode({ text: '', userId: 'u', mode: 'code', permMode: 'files' })).toBe('files');
  });

  it('코드 채널인데 채널에 값이 없으면 undefined(=전역 설정 폴백)', () => {
    const o = makeOrch('x');
    expect((o as any).resolveTurnPermMode({ text: '', userId: 'u', mode: 'code' })).toBeUndefined();
  });

  it('Chat·Team 채널은 값이 있어도 무시(코드 채널 전용 설정)', () => {
    const o = makeOrch('x');
    expect((o as any).resolveTurnPermMode({ text: '', userId: 'u', permMode: 'bypass' })).toBeUndefined();
  });
});

describe('계획만(plan) — 구현으로 넘어가는 문을 닫는다', () => {
  it('코드요청이어도 [구현 시작] 버튼·pending이 생기지 않는다', async () => {
    const orch = makeOrch(PROPOSE);
    const { posts, post } = collect();
    await orch.handleMention(
      { text: '로그인 붙여줘', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app', permMode: 'plan' }, post, 'c1',
    );
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toBe('바로 붙일게.');   // 계획(답)은 그대로 나온다
    expect(posts[0].actions).toBeUndefined();      // 실행 문은 닫힘
    expect((orch as any).pending.get('c1')).toBeUndefined();
  });

  it('이미 걸린 pending에 "구현 시작"이 와도 startProposal로 안 넘어간다', async () => {
    const orch = makeOrch('무시됨');
    const spy = jest.spyOn(orch as any, 'startProposal').mockResolvedValue(undefined);
    (orch as any).pending.set('c1', { kind: 'proposeReady', repoPath: 'C:/repo/app', goal: '로그인' });
    const { posts, post } = collect();
    await orch.handleMention(
      { text: '구현 시작', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app', permMode: 'plan' }, post, 'c1',
    );
    expect(spy).not.toHaveBeenCalled();
    expect(posts[0].text).toMatch(/계획만|plan/i);
  });

  it('plan이 아니면 기존대로 버튼·pending이 생긴다(회귀 0)', async () => {
    const orch = makeOrch(PROPOSE);
    const { posts, post } = collect();
    await orch.handleMention(
      { text: '로그인 붙여줘', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app', permMode: 'files' }, post, 'c1',
    );
    expect(posts[0].actions).toEqual([{ label: 'Start implementation', send: '구현 시작' }]);
    expect((orch as any).pending.get('c1')).toEqual({ kind: 'proposeReady', repoPath: 'C:/repo/app', goal: '로그인 붙이기' });
  });
});

describe('권한 무시(bypass) — 울타리 밖 폴더도 제안 단계에서 통과', () => {
  it('startProposal의 쓰기 검증에 이번 턴의 모드를 넘긴다', async () => {
    const seen: Array<[string, string | undefined]> = [];
    const fence = { assertWritable: (p: string, m?: string) => { seen.push([p, m]); } } as any;
    const orch = makeOrch(PROPOSE, { fence });
    // proposeProject는 fence 통과 후 호출되는 협력자 — 여기선 그 앞의 검증만 본다.
    jest.spyOn(orch as any, 'proposeProject').mockResolvedValue({ id: 'p1', acceptanceCriteria: ['a'], gate: { test: 't', build: 'b', typecheck: 'c' } });
    (orch as any).projects = {};
    (orch as any).pending.set('c1', { kind: 'proposeReady', repoPath: 'C:/out/app', goal: '로그인' });
    const { post } = collect();
    await orch.handleMention(
      { text: '구현 시작', userId: 'c1', mode: 'code', repoPath: 'C:/out/app', permMode: 'bypass' }, post, 'c1',
    );
    expect(seen).toEqual([['C:/out/app', 'bypass']]);
  });
});

describe('codeRun — 코딩 실행부까지 턴의 모드가 흘러간다', () => {
  function codingOrch(permMode: string | undefined, workSpy: jest.Mock, assertSpy: jest.Mock) {
    const brain = { complete: async () => ({ text: '{"tickets":[]}', costUsd: 0, isError: false }) } as any;
    const conversations = { append: async () => {}, recent: async () => [] } as any;
    const projects = { get: async () => ({ id: 'p1', targetPath: 'C:/proj', writePaths: ['C:/proj'], approved: true, branch: 'b', acceptanceCriteria: ['a'], budget: { tokens: null }, gate: {} }) } as any;
    const tasks = {
      createCoding: async () => ({ id: 's1' }),
      transition: async () => {},
      addTickets: async () => {},
      get: async () => ({ tickets: [{ id: 'tk1', area: 'a', instruction: 'i', status: 'PENDING', attempts: 0 }], blackboard: {} }),
      updateTicket: async () => {},
      contribute: async () => {},
      recordProgress: async () => {},
      setResult: async () => {},
      remove: async () => {},
    } as any;
    const fence = { assertWritable: assertSpy } as any;
    const gate = { run: async () => ({ pass: false, output: '' }) } as any;
    const git = { ensureBranch: async () => {}, commitAll: async () => {} } as any;
    const coder = { work: workSpy } as any;
    const reviewer = { review: async () => ({ approved: true, extraTickets: [] }) } as any;
    const sem = { run: (fn: () => Promise<void>) => fn() } as any;
    // 생성자 순서: reader, conversations, logger, ingester, tasks, specialist, synthesizer, sem,
    //             projects, gate, codingGit, coder, reviewer, codeBrain, fence, reporter, registry, paths
    const o = new Orchestrator(
      null as any, conversations, logger, null as any,
      tasks, null as any, null as any, sem,
      projects, gate, git, coder, reviewer,
      brain, fence, null as any, { all: () => [] } as any, null as any,
    );
    return o;
  }

  it('opts.permMode가 CodingSpecialist.work의 6번째 인자로 그대로 전달된다', async () => {
    const work = jest.fn(async (..._a: any[]) => 'done');
    const assertWritable = jest.fn();
    const o = codingOrch('restricted', work, assertWritable);
    await o.codeRun('p1', { maxRounds: 1, permMode: 'restricted' } as any);
    expect(work).toHaveBeenCalled();
    expect(work.mock.calls[0][5]).toBe('restricted');
    // 진입 시 쓰기 재검증에도 같은 모드가 실린다(bypass면 울타리 밖 타깃도 통과해야 하므로).
    expect(assertWritable).toHaveBeenCalledWith('C:/proj', 'restricted');
  });

  it('permMode 미지정이면 아무 모드도 안 붙는다(전역 설정 폴백 — 회귀 0)', async () => {
    const work = jest.fn(async (..._a: any[]) => 'done');
    const assertWritable = jest.fn();
    const o = codingOrch(undefined, work, assertWritable);
    await o.codeRun('p1', { maxRounds: 1 });
    expect(work.mock.calls[0][5]).toBeUndefined();
    expect(assertWritable).toHaveBeenCalledWith('C:/proj', undefined);
  });
});
