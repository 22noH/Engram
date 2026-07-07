import { Orchestrator } from './orchestrator';

const logger = { warn() {}, error() {}, log() {} } as any;

// 생성자 18인자: (reader, conversations, logger, ingester, tasks, specialist, synth, sem,
//   projects, gate, codingGit, coder, reviewer, codeBrain, fence, reporter, registry, paths)
// orchestrator-modes.spec.ts/orchestrator-coding.spec.ts의 조립을 그대로 재사용.
function makeOrchestrator(classifyJson = '{"kind":"chat","team":[]}') {
  const brain = { complete: async () => ({ text: classifyJson, costUsd: 0, isError: false }) } as any;
  const registry = { all: () => [] } as any;
  const conversations = { append: async () => {} } as any;
  const projects = {} as any;                   // truthy (startProposal 가드 통과)
  const fence = { assertWritable() {} } as any;  // 기본 허용
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    projects, null as any, null as any, null as any, null as any,
    brain, fence, null as any, registry, null as any,
  );
  return o;
}

it('startProposal(escalate)은 완성조건 게시에 승인/취소 actions를 첨부한다', async () => {
  const orch = makeOrchestrator();
  (orch as any).proposeProject = async () => ({
    id: 'p1',
    acceptanceCriteria: ['로그인 통과'],
    gate: { test: true, build: false, typecheck: true },
  });
  const posts: { text: string; actions?: any }[] = [];
  const post = async (text: string, actions?: any): Promise<void> => { posts.push({ text, actions }); };
  // proposeReady 대기에서 '구현 시작' → startProposal
  (orch as any).pending.set('c1', { kind: 'proposeReady', repoPath: 'C:/repo/app', goal: '로그인 붙이기' });
  await orch.handleMention({ text: '구현 시작', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1');
  const approve = posts.find((p) => p.actions);
  expect(approve?.actions).toEqual([
    { label: '✅ 승인', send: '승인', confirm: '자율 코딩을 시작할까요?' },
    { label: '취소', send: '취소' },
  ]);
  expect(approve?.text).toContain('맞으면 @Engram 승인 / 취소는 @Engram 취소');
});

it('startCoding 다중 매치는 후보 번호 actions + 취소를 첨부한다', async () => {
  const orch = makeOrchestrator();
  (orch as any).resolveRepoPaths = () => ['C:/a', 'C:/b'];
  const posts: { text: string; actions?: any }[] = [];
  await orch.handleMention(
    { text: 'code foo 로그인', userId: 'c1' },
    async (t, a) => { posts.push({ text: t, actions: a }); },
    'c1',
  );
  const pick = posts.find((p) => p.actions);
  expect(pick?.actions).toEqual([
    { label: '1. C:/a', send: '1' },
    { label: '2. C:/b', send: '2' },
    { label: '취소', send: '취소' },
  ]);
});
