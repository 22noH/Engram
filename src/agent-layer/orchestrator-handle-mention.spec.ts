import { Orchestrator } from './orchestrator';

const logger = { warn() {}, error() {}, log() {} } as any;

// 생성자: (reader, conversations, logger, ingester, tasks, specialist, synth, sem,
//          projects, gate, codingGit, coder, reviewer, codeBrain, fence, reporter, registry)
function orc(brainText: string, registryNames: string[] = ['Manager', 'Infra']) {
  const brain = { complete: async () => ({ text: brainText, costUsd: 0, isError: false }) } as any;
  const registry = { all: () => registryNames.map((name) => ({ name, role: 'r', brain: 'claude', tools: [], invocation: ['summon'], prompt: '' })) } as any;
  const conversations = { append: async () => {} } as any; // launchCollaboration이 결과를 적재
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
    brain, null as any, null as any, registry,
  );
  return o;
}

it('분류 collaborate → ack 후 백그라운드 결과 post', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager","Infra"]}');
  (o as any).collaborate = async () => '종합';
  const posts: string[] = [];
  await o.handleMention({ text: '서버 비용 줄여줘', userId: 'c1' }, async (t) => { posts.push(t); });
  await (o as any).drainForTest();
  expect(posts[0]).toContain('알아볼게요');
  expect(posts).toContain('종합');
});

it('collaborate 팀이 ack 문구에 들어감', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager","Infra"]}');
  (o as any).collaborate = async () => 'x';
  const posts: string[] = [];
  await o.handleMention({ text: 'q', userId: 'c1' }, async (t) => { posts.push(t); });
  await (o as any).drainForTest();
  expect(posts[0]).toContain('Manager');
  expect(posts[0]).toContain('Infra');
});

it('분류 chat → 답을 post', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  (o as any).route = async () => '즉답';
  const posts: string[] = [];
  await o.handleMention({ text: '엔그램이 뭐야?', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts).toEqual(['즉답']);
});

it('분류 응답이 깨지면 chat 폴백', async () => {
  const o = orc('이건 JSON이 아님');
  let routed = false;
  (o as any).route = async () => { routed = true; return 'r'; };
  await o.handleMention({ text: 'x', userId: 'c1' }, async () => {});
  expect(routed).toBe(true);
});

it('collaborate인데 team이 비면 [Manager] 폴백', async () => {
  const o = orc('{"kind":"collaborate","team":[]}');
  let used: string[] = [];
  (o as any).collaborate = async (_q: string, team: string[]) => { used = team; return 'x'; };
  await o.handleMention({ text: 'x', userId: 'c1' }, async () => {});
  await (o as any).drainForTest();
  expect(used).toEqual(['Manager']);
});

it('escape hatch "team a,b 질문" → 백그라운드 collaborate', async () => {
  const o = orc('{"kind":"chat","team":[]}'); // 분류 chat이어도 무시
  const calls: any[] = [];
  (o as any).collaborate = async (q: string, team: string[]) => { calls.push({ q, team }); return 'x'; };
  await o.handleMention({ text: 'team Brand,Trend 런칭 전략?', userId: 'c1' }, async () => {});
  await (o as any).drainForTest();
  expect(calls[0]).toEqual({ q: '런칭 전략?', team: ['Brand', 'Trend'] });
});

it('escape hatch "ask 질문" → chat route', async () => {
  const o = orc('{"kind":"collaborate","team":["X"]}'); // 무시돼야
  (o as any).route = async (m: any) => `r:${m.text}`;
  const posts: string[] = [];
  await o.handleMention({ text: 'ask 엔그램이 뭐야', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts).toEqual(['r:엔그램이 뭐야']);
});

it('상태 → 진행 중 작업 보고', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager"]}');
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  (o as any).collaborate = async () => { await gate; return '결과'; };
  await o.handleMention({ text: '분석해줘', userId: 'c1' }, async () => {}); // 백그라운드 시작(미완)
  const statusPosts: string[] = [];
  await o.handleMention({ text: '상태', userId: 'c1' }, async (t) => { statusPosts.push(t); });
  expect(statusPosts[0]).toContain('진행 중');
  release();
  await (o as any).drainForTest();
});

it('상태 — 작업 없으면 안내', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  const posts: string[] = [];
  await o.handleMention({ text: 'status', userId: 'c9' }, async (t) => { posts.push(t); });
  expect(posts[0]).toContain('없어요');
});

it('백그라운드 실패 → 사과 post(상주 불사)', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager"]}');
  (o as any).collaborate = async () => { throw new Error('boom'); };
  const posts: string[] = [];
  await o.handleMention({ text: 'q', userId: 'c1' }, async (t) => { posts.push(t); });
  await (o as any).drainForTest();
  expect(posts.some((p) => p.includes('문제가 생겼어요'))).toBe(true);
});
