import { Orchestrator } from './orchestrator';

const logger = { warn() {}, error() {}, log() {} } as any;

// 생성자 18인자(reader..paths). 기존 orchestrator-schedule.spec 패턴.
function orc(classifyJson: string) {
  const brain = { complete: async () => ({ text: classifyJson, costUsd: 0, isError: false }) } as any;
  const registry = { all: () => [] } as any;
  const conversations = { append: async () => {} } as any;
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
    brain, null as any, null as any, registry, null as any,
  );
  return o as any;
}

// 특정 cap만 거부하는 정책 스텁(채널 c1).
function denyPolicy(...caps: string[]) {
  return { channels: { c1: Object.fromEntries(caps.map((c) => [c, false])) } };
}

it('coding 차단: classify code → 안내, startCoding 미호출', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  o.policy = () => denyPolicy('coding');
  let called = false; o.startCoding = async () => { called = true; };
  const posts: string[] = [];
  await o.handleMention({ text: 'api에 g', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(called).toBe(false);
  expect(posts[0]).toContain('코딩');
  expect(posts[0]).toContain('쓸 수 없어요');
});

it('coding 차단: code hatch도 동일', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  o.policy = () => denyPolicy('coding');
  let called = false; o.startCoding = async () => { called = true; };
  await o.handleMention({ text: 'code api g', userId: 'c1' }, async () => {});
  expect(called).toBe(false);
});

it('coding 차단: resume hatch(자가 재개 발사)도 안내만', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  o.policy = () => denyPolicy('coding');
  let called = false; o.resumeCoding = async () => { called = true; };
  const posts: string[] = [];
  await o.handleMention({ text: 'resume p1 1', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(called).toBe(false);
  expect(posts[0]).toContain('코딩');
});

it('schedule 차단: classify schedule·hatch → 안내, doSchedule 미호출', async () => {
  const o = orc('{"kind":"schedule","cron":"0 9 * * *","task":"X"}');
  o.policy = () => denyPolicy('schedule');
  let called = false; o.doSchedule = async () => { called = true; };
  const posts: string[] = [];
  await o.handleMention({ text: '매일 9시 X', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.handleMention({ text: 'schedule 0 9 * * * X', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(called).toBe(false);
  expect(posts[0]).toContain('예약');
  expect(posts[1]).toContain('예약');
});

it('schedule 차단 채널에서도 예약목록·예약취소는 동작(읽기/정리)', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  o.policy = () => denyPolicy('schedule');
  o.setScheduler({
    add() { return null; },
    list: () => [{ id: 'x1', cron: '0 9 * * *', task: 'T', channelId: 'c1', createdAt: 't' }],
    remove: (id: string) => id === 'x1',
  } as any);
  const posts: string[] = [];
  await o.handleMention({ text: '예약목록', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.handleMention({ text: '예약취소 x1', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(posts[0]).toContain('#x1');
  expect(posts[1]).toContain('취소');
});

it('collaborate 차단: classify collaborate·team·retry → 안내, launchCollaboration 미호출', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager"]}');
  o.policy = () => denyPolicy('collaborate');
  let called = 0; o.launchCollaboration = () => { called++; };
  const posts: string[] = [];
  await o.handleMention({ text: '정리해줘', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.handleMention({ text: 'team Manager 정리해줘', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.handleMention({ text: 'retry 1 Manager 정리해줘', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(called).toBe(0);
  expect(posts.every((p) => p.includes('협업'))).toBe(true);
});

it('정책 미설정(기본값) → 전부 통과(기존 동작)', async () => {
  const o = orc('{"kind":"chat","team":[]}'); // paths=null → policy()={channels:{}} → 기본 허용
  let called = false; o.startCoding = async () => { called = true; };
  await o.handleMention({ text: 'code api g', userId: 'c1' }, async () => {});
  expect(called).toBe(true);
});

it('차단 채널에서도 chat(route)·ask는 동작', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  o.policy = () => denyPolicy('coding', 'schedule', 'collaborate');
  o.route = async () => '네';
  const posts: string[] = [];
  await o.handleMention({ text: '안녕', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.handleMention({ text: 'ask 뭐야', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(posts).toEqual(['네', '네']);
});
