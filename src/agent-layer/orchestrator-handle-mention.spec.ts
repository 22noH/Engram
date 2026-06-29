import { Orchestrator } from './orchestrator';

const logger = { warn() {}, error() {}, info() {} } as any;

// route/collaborate를 가짜로 덮어 어느 경로로 갔는지만 관측한다.
function orc(brainText: string, registryNames: string[] = ['Manager', 'Infra']) {
  const brain = { complete: async () => ({ text: brainText, costUsd: 0, isError: false }) } as any;
  const registry = { all: () => registryNames.map((name) => ({ name, role: 'r', brain: 'claude', tools: [], invocation: ['summon'], prompt: '' })) } as any;
  // 생성자: (reader, conversations, logger, ingester, tasks, specialist, synth, sem, projects, gate, codingGit, coder, reviewer, codeBrain, fence, reporter, registry)
  const o = new Orchestrator(
    null as any, null as any, logger, null as any,
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
    brain, null as any, null as any, registry,
  );
  return o;
}

it('분류 collaborate → collaborate(team)로 디스패치', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager","Infra"]}');
  const calls: any[] = [];
  (o as any).collaborate = async (q: string, team: string[]) => { calls.push({ q, team }); return '종합'; };
  const out = await o.handleMention({ text: '서버 비용 줄여줘', userId: 'c1' });
  expect(out).toBe('종합');
  expect(calls[0].team).toEqual(['Manager', 'Infra']);
});

it('분류 chat → route로 디스패치', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  (o as any).route = async () => '즉답';
  const out = await o.handleMention({ text: '엔그램이 뭐야?', userId: 'c1' });
  expect(out).toBe('즉답');
});

it('분류 응답이 깨지면 chat 폴백', async () => {
  const o = orc('이건 JSON이 아님');
  let routed = false;
  (o as any).route = async () => { routed = true; return 'r'; };
  await o.handleMention({ text: 'x', userId: 'c1' });
  expect(routed).toBe(true);
});

it('collaborate인데 team이 비면 [Manager] 폴백', async () => {
  const o = orc('{"kind":"collaborate","team":[]}');
  let used: string[] = [];
  (o as any).collaborate = async (_q: string, team: string[]) => { used = team; return 'x'; };
  await o.handleMention({ text: 'x', userId: 'c1' });
  expect(used).toEqual(['Manager']);
});

it('collaborate면 onAck로 처리중 메시지 1회', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager"]}');
  (o as any).collaborate = async () => '결과';
  const acks: string[] = [];
  await o.handleMention({ text: 'x', userId: 'c1' }, async (t) => { acks.push(t); });
  expect(acks.length).toBe(1);
});

it('escape hatch "team a,b 질문" → 분류 스킵·직접 collaborate', async () => {
  const o = orc('{"kind":"chat","team":[]}'); // 분류가 chat이어도 무시돼야 함
  const calls: any[] = [];
  (o as any).collaborate = async (q: string, team: string[]) => { calls.push({ q, team }); return 'x'; };
  await o.handleMention({ text: 'team Brand,Trend 런칭 전략?', userId: 'c1' });
  expect(calls[0]).toEqual({ q: '런칭 전략?', team: ['Brand', 'Trend'] });
});
