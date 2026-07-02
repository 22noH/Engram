import { Orchestrator } from './orchestrator';

const logger = { warn() {}, error() {}, log() {} } as any;

// 생성자 18인자: (reader, conversations, logger, ingester, tasks, specialist, synth, sem,
//   projects, gate, codingGit, coder, reviewer, codeBrain, fence, reporter, registry, paths)
function orc(classifyJson: string) {
  const brain = { complete: async () => ({ text: classifyJson, costUsd: 0, isError: false }) } as any;
  const registry = { all: () => [] } as any;
  const conversations = { append: async () => {} } as any;
  const projects = {} as any;
  const fence = { assertWritable() {} } as any;
  return new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    projects, null as any, null as any, null as any, null as any,
    brain, fence, null as any, registry, null as any,
  );
}

// add(input, opts) 캡처 스텁
function fakeScheduler() {
  const adds: Array<{ input: any; opts: any }> = [];
  return {
    adds,
    add(input: any, opts?: any) { adds.push({ input, opts }); return { id: 'r1', ...input, createdAt: 't' }; },
    list() { return []; },
    remove() { return true; },
  };
}

// 승인까지 진행시키는 공통 준비(코딩 제안→승인). codeRun 결과만 바꿔가며 재사용.
async function approveWith(o: any, status: string, posts: string[]) {
  o.resolveRepoPaths = () => ['C:/repos/api'];
  o.proposeProject = async () => ({ id: 'p1', acceptanceCriteria: ['x'], gate: { test: false, build: false, typecheck: false } });
  o.approveProject = async () => {};
  o.codeRun = async () => ({ status, sessionId: 's1' });
  await o.handleMention({ text: 'api에 g', userId: 'c1' }, async () => {});
  await o.handleMention({ text: '승인', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.drainForTest();
}

it('STUCK → once 재개예약(internal, resume p1 1) + ⏸ 게시', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await approveWith(o as any, 'STUCK', posts);
  expect(sch.adds).toHaveLength(1);
  expect(sch.adds[0].input).toMatchObject({ channelId: 'c1', task: 'resume p1 1', once: true });
  expect(sch.adds[0].opts).toEqual({ internal: true });
  const msg = posts.find((p) => p.includes('⏸'));
  expect(msg).toContain('재개 1/2');
  expect(msg).toContain('예약취소 r1');
});

it('BUDGET → 재개예약(사유 문구=예산)', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await approveWith(o as any, 'BUDGET', posts);
  expect(sch.adds[0].input.task).toBe('resume p1 1');
  expect(posts.find((p) => p.includes('⏸'))).toContain('예산');
});

it('SUCCESS → 재예약 없음', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await approveWith(o as any, 'SUCCESS', posts);
  expect(sch.adds).toHaveLength(0);
});

it('STOPPED(사용자 정지) → 재예약 없음, 기존 ⚠️', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await approveWith(o as any, 'STOPPED', posts);
  expect(sch.adds).toHaveLength(0);
  expect(posts.some((p) => p.includes('⚠️'))).toBe(true);
});

it('scheduler 미주입 STUCK → 기존 ⚠️ 메시지로 강등', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  const posts: string[] = [];
  await approveWith(o as any, 'STUCK', posts);
  expect(posts.some((p) => p.includes('⚠️'))).toBe(true);
});
