import { Orchestrator } from './orchestrator';

const logger = { warn() {}, error() {}, log() {} } as any;

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
  return o;
}

// 스텁 스케줄러
function fakeScheduler() {
  const calls: any = { add: [], list: [], remove: [] };
  return {
    calls,
    add(input: any) { calls.add.push(input); return input.cron === 'BAD' ? null : { id: 'x1', cron: input.cron, task: input.task, once: input.once, channelId: input.channelId, createdAt: 't' }; },
    list(channelId: string) { calls.list.push(channelId); return [{ id: 'x1', cron: '0 9 * * *', task: '서버비', channelId, createdAt: 't' }]; },
    remove(id: string) { calls.remove.push(id); return id === 'x1'; },
  };
}

it('classify schedule → scheduler.add 호출 + 확인 게시', async () => {
  const o = orc('{"kind":"schedule","cron":"0 9 * * *","task":"서버비 정리"}');
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await o.handleMention({ text: '매일 9시에 서버비 정리해줘', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(sch.calls.add[0]).toMatchObject({ channelId: 'c1', cron: '0 9 * * *', task: '서버비 정리' });
  expect(posts[0]).toContain('예약했어요');
});

it('add가 null(잘못된 cron) → 되묻기', async () => {
  const o = orc('{"kind":"schedule","cron":"BAD","task":"X"}');
  o.setScheduler(fakeScheduler() as any);
  const posts: string[] = [];
  await o.handleMention({ text: '언젠가 X', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts[0]).toContain('언제인지');
});

it('예약목록 → list 집계 게시', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  o.setScheduler(fakeScheduler() as any);
  const posts: string[] = [];
  await o.handleMention({ text: '예약목록', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts[0]).toContain('서버비');
  expect(posts[0]).toContain('#x1');
});

it('예약취소 <id> → remove 호출', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await o.handleMention({ text: '예약취소 x1', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(sch.calls.remove).toEqual(['x1']);
  expect(posts[0]).toContain('취소');
});

it('escape hatch "schedule <cron> <task>" → add', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  await o.handleMention({ text: 'schedule 0 9 * * * 서버비 정리', userId: 'c1' }, async () => {});
  expect(sch.calls.add[0]).toMatchObject({ cron: '0 9 * * *', task: '서버비 정리' });
});

it('scheduler 미주입 → 안내', async () => {
  const o = orc('{"kind":"schedule","cron":"0 9 * * *","task":"X"}');
  const posts: string[] = [];
  await o.handleMention({ text: '매일 9시 X', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts[0]).toContain('준비되지 않');
});

it('예약취소 — 다른 채널 소유 예약은 취소 안 함(채널 스코프)', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  // fakeScheduler.list는 어떤 채널이든 id 'x1'을 돌려주니, 다른 id로 소유 아님 검증
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await o.handleMention({ text: '예약취소 other', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(sch.calls.remove).toEqual([]); // 소유 아님 → remove 미호출
  expect(posts[0]).toContain('못 찾');
});

it('scheduler 미주입 상태의 예약취소 → 준비 안 됨 안내', async () => {
  const o = orc('{"kind":"chat","team":[]}'); // scheduler 미주입
  const posts: string[] = [];
  await o.handleMention({ text: '예약취소 x1', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts[0]).toContain('준비되지 않');
});
