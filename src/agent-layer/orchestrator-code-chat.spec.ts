import { Orchestrator } from './orchestrator';

const logger = { warn() {}, error() {}, log() {} } as any;

// brainText: codeBrain.complete가 돌려줄 텍스트(테스트마다 주입).
function makeOrch(brainText: string) {
  const brain = { complete: async () => ({ text: brainText, costUsd: 0, isError: false }) } as any;
  const conversations = { append: async () => {}, recent: async () => [] } as any;
  const projects = {} as any;                   // truthy(escalate 가능 조건)
  const fence = { assertWritable() {} } as any; // truthy + 허용
  const registry = { all: () => [] } as any;
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    projects, null as any, null as any, null as any, null as any,
    brain, fence, null as any, registry, null as any,
  );
  return o;
}

type Posted = { text: string; actions?: any[] };
function collect() {
  const posts: Posted[] = [];
  const post = async (text: string, actions?: any[]) => { posts.push({ text, actions }); };
  return { posts, post };
}

it('Code 채널 질문은 대화 답변만 — 버튼·제안 없음', async () => {
  const orch = makeOrch('여기 원인은 add.js가 없어서야.');
  const { posts, post } = collect();
  await orch.handleMention(
    { text: '왜 막혔어?', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1',
  );
  expect(posts).toHaveLength(1);
  expect(posts[0].text).toContain('원인');
  expect(posts[0].actions).toBeUndefined();
});

it('Code 채널 대화는 다음 턴 연속성을 위해 ConversationStore에 적재된다', async () => {
  const brain = { complete: async () => ({ text: '원인은 X.', costUsd: 0, isError: false }) } as any;
  const append = jest.fn(async () => {});
  const conversations = { append, recent: async () => [] } as any;
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    {} as any, null as any, null as any, null as any, null as any,
    brain, { assertWritable() {} } as any, null as any, { all: () => [] } as any, null as any,
  );
  const { post } = collect();
  await o.handleMention({ text: '왜 막혔어?', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1');
  expect(append).toHaveBeenCalledWith('c1', expect.objectContaining({ question: '왜 막혔어?', answer: '원인은 X.' }));
});

it('Code 채널 코드요청은 답변 + [구현 시작] 버튼 + pending=proposeReady', async () => {
  const orch = makeOrch('바로 붙일게.\n```engram:propose\n{"goal":"로그인 붙이기"}\n```');
  const { posts, post } = collect();
  await orch.handleMention(
    { text: '로그인 붙여줘', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1',
  );
  expect(posts).toHaveLength(1);
  expect(posts[0].text).toBe('바로 붙일게.');
  expect(posts[0].actions).toEqual([{ label: '구현 시작', send: '구현 시작' }]);
  expect((orch as any).pending.get('c1')).toEqual({ kind: 'proposeReady', repoPath: 'C:/repo/app', goal: '로그인 붙이기' });
});

it('Code 모드인데 repoPath 없으면 폴더 안내만', async () => {
  const orch = makeOrch('무시됨');
  const { posts, post } = collect();
  await orch.handleMention({ text: '뭐든', userId: 'c1', mode: 'code' }, post, 'c1');
  expect(posts[0].text).toMatch(/폴더|folder/i);
});

it('[구현 시작] 누르면 startProposal로 escalate', async () => {
  const orch = makeOrch('바로 붙일게.\n```engram:propose\n{"goal":"로그인 붙이기"}\n```');
  const spyProposal = jest.spyOn(orch as any, 'startProposal').mockResolvedValue(undefined);
  const { post } = collect();
  // 1) 코드요청 → pending=proposeReady
  await orch.handleMention(
    { text: '로그인 붙여줘', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1',
  );
  // 2) 구현 시작 → startProposal(repoPath, goal)
  await orch.handleMention(
    { text: '구현 시작', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1',
  );
  expect(spyProposal).toHaveBeenCalledWith('C:/repo/app', '로그인 붙이기', 'c1', expect.any(Function));
  expect((orch as any).pending.get('c1')).toBeUndefined(); // proposeReady 소비됨
});

it('proposeReady 중 비매칭 메시지는 제안을 버리고 일반 대화로 흐른다', async () => {
  const orch = makeOrch('그건 이래.'); // 두 번째 턴은 마커 없는 일반 답
  const spyProposal = jest.spyOn(orch as any, 'startProposal').mockResolvedValue(undefined);
  const { posts, post } = collect();
  (orch as any).pending.set('c1', { kind: 'proposeReady', repoPath: 'C:/repo/app', goal: 'X' });
  await orch.handleMention(
    { text: '아니 그거 말고 이건 뭐야?', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1',
  );
  expect(spyProposal).not.toHaveBeenCalled();
  expect((orch as any).pending.get('c1')).toBeUndefined(); // 스테일 제안 정리
  expect(posts[posts.length - 1].text).toContain('그건 이래'); // 대화로 응답
});
