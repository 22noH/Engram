import { Orchestrator } from './orchestrator';

const logger = { warn() {}, error() {}, log() {} } as any;

// 생성자 18인자: (reader, conversations, logger, ingester, tasks, specialist, synth, sem,
//   projects, gate, codingGit, coder, reviewer, codeBrain, fence, reporter, registry, paths)
// orchestrator-coding.spec.ts의 orc() 조립을 그대로 재사용 — startProposal 도달에 필요한
// projects(truthy)+fence(허용)+brain을 주입.
function makeOrchestrator() {
  const brain = { complete: async () => ({ text: '{"kind":"chat","team":[]}', costUsd: 0, isError: false }) } as any;
  const registry = { all: () => [] } as any;
  const conversations = { append: async () => {} } as any;
  const projects = {} as any;                  // truthy (startProposal 가드 통과)
  const fence = { assertWritable() {} } as any; // 기본 허용
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    projects, null as any, null as any, null as any, null as any,
    brain, fence, null as any, registry, null as any,
  );
  return o;
}

it('Code 모드 메시지는 classify를 건너뛰고 대화 답변으로 간다(answerInCode)', async () => {
  const orch = makeOrchestrator();
  const spyAnswer = jest.spyOn(orch as any, 'answerInCode').mockResolvedValue({ reply: '답' });
  const spyClassify = jest.spyOn(orch as any, 'classify');
  await orch.handleMention(
    { text: '로그인 붙여줘', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' },
    async () => {}, 'c1',
  );
  expect(spyClassify).not.toHaveBeenCalled();
  // 3번째 인자는 요청 한정 채널 두뇌(Task 2, 스펙 §3.2) — channelBrain 미주입이면 codeBrain 그대로 전달.
  expect(spyAnswer).toHaveBeenCalledWith(
    expect.objectContaining({ mode: 'code', repoPath: 'C:/repo/app' }), 'c1', expect.anything(),
  );
});

it('Code 모드인데 repoPath 미바인딩이면 안내만 한다', async () => {
  const orch = makeOrchestrator();
  const posts: string[] = [];
  await orch.handleMention(
    { text: '뭐든', userId: 'c1', mode: 'code' },
    async (t) => { posts.push(t); }, 'c1',
  );
  expect(posts.join('')).toMatch(/폴더|folder/i);
});

it('Code 채널에서도 team escape hatch는 협업으로 간다(벽 아님)', async () => {
  const orch = makeOrchestrator();
  const spyCollab = jest.spyOn(orch as any, 'launchCollaboration').mockReturnValue(undefined);
  await orch.handleMention(
    { text: 'team Recon 시장조사', userId: 'c1', mode: 'code', repoPath: 'C:/r' },
    async () => {}, 'c1',
  );
  expect(spyCollab).toHaveBeenCalled();
});
