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
  expect(msg).toContain('resume 1/2');
  expect(msg).toContain('schedule cancel r1');
});

it('BUDGET → 재개예약(사유 문구=예산)', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await approveWith(o as any, 'BUDGET', posts);
  expect(sch.adds[0].input.task).toBe('resume p1 1');
  expect(posts.find((p) => p.includes('⏸'))).toContain('budget');
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

it('resume hatch: 승인된 프로젝트 → runState 복원 + launchCoding(attempt 전달)', async () => {
  const o = orc('{"kind":"chat","team":[]}') as any;
  o.projects = { get: async (id: string) => ({ id, targetPath: 'C:/repos/api', approved: true }) };
  const seen: any = {};
  o.launchCoding = (projectId: string, targetPath: string, _tk: string, _post: any, attempt: number) => {
    seen.projectId = projectId; seen.targetPath = targetPath; seen.attempt = attempt;
  };
  o.setRunState('paused'); // STUCK이 남긴 상태 재현
  const posts: string[] = [];
  await o.handleMention({ text: 'resume p1 1', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(o.getRunState()).toBe('running');
  expect(seen).toEqual({ projectId: 'p1', targetPath: 'C:/repos/api', attempt: 1 });
  expect(posts[0]).toContain('Continuing');
});

it('resume hatch: 프로젝트 없음 → 안내', async () => {
  const o = orc('{"kind":"chat","team":[]}') as any;
  o.projects = { get: async () => null };
  const posts: string[] = [];
  await o.handleMention({ text: 'resume nope 1', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(posts[0]).toContain("Couldn't find");
});

it('resume hatch: 미승인 프로젝트 → 안내', async () => {
  const o = orc('{"kind":"chat","team":[]}') as any;
  o.projects = { get: async () => ({ id: 'p1', targetPath: 'C:/x', approved: false }) };
  const posts: string[] = [];
  await o.handleMention({ text: 'resume p1', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(posts[0]).toContain("hasn't been approved");
});

it('resume hatch: attempt 비숫자/생략 → 0', async () => {
  const o = orc('{"kind":"chat","team":[]}') as any;
  o.projects = { get: async () => ({ id: 'p1', targetPath: 'C:/x', approved: true }) };
  const seen: any = {};
  o.launchCoding = (_p: string, _t: string, _tk: string, _post: any, attempt: number) => { seen.attempt = attempt; };
  await o.handleMention({ text: 'resume p1', userId: 'c1' }, async () => {});
  expect(seen.attempt).toBe(0);
});

it('재개 상한: resume attempt 2로 또 STUCK → 재예약 없음 + 사람 호출', async () => {
  const o = orc('{"kind":"chat","team":[]}') as any;
  o.projects = { get: async () => ({ id: 'p1', targetPath: 'C:/repos/api', approved: true }) };
  o.codeRun = async () => ({ status: 'STUCK', sessionId: 's1' }); // launchCoding은 실물 사용
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await o.handleMention({ text: 'resume p1 2', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.drainForTest();
  expect(sch.adds).toHaveLength(0);
  expect(posts.some((p) => p.includes('human needs to take a look'))).toBe(true);
});

it('협업 실패 → once 재시도예약(retry 1 <팀> <질문>) + ⏸ 게시', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager"]}') as any;
  o.collaborate = async () => { throw new Error('boom'); };
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await o.handleMention({ text: '서버비 정리해줘', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.drainForTest();
  expect(sch.adds).toHaveLength(1);
  expect(sch.adds[0].input).toMatchObject({ channelId: 'c1', task: 'retry 1 Manager 서버비 정리해줘', once: true });
  expect(sch.adds[0].opts).toEqual({ internal: true });
  const msg = posts.find((p) => p.includes('⏸'));
  expect(msg).toContain('retry 1/2');
});

it('retry hatch: 파싱 → launchCollaboration(팀·attempt 전달)', async () => {
  const o = orc('{"kind":"chat","team":[]}') as any;
  const seen: any = {};
  o.launchCollaboration = (q: string, team: string[], _u: string, _tk: string, _post: any, attempt: number) => {
    seen.q = q; seen.team = team; seen.attempt = attempt;
  };
  await o.handleMention({ text: 'retry 1 Manager,Dev 서버비 정리해줘', userId: 'c1' }, async () => {});
  expect(seen).toEqual({ q: '서버비 정리해줘', team: ['Manager', 'Dev'], attempt: 1 });
});

it('retry 상한: attempt 2로 또 실패 → 재예약 없음 + 사람 호출', async () => {
  const o = orc('{"kind":"chat","team":[]}') as any;
  o.collaborate = async () => { throw new Error('boom'); };
  const sch = fakeScheduler(); o.setScheduler(sch as any);
  const posts: string[] = [];
  await o.handleMention({ text: 'retry 2 Manager 서버비 정리해줘', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.drainForTest();
  expect(sch.adds).toHaveLength(0);
  expect(posts.some((p) => p.includes('human needs to take a look'))).toBe(true);
});

it('retry 형식 불일치(attempt 비숫자) → hatch 미적용, 일반 흐름(chat)', async () => {
  const o = orc('{"kind":"chat","team":[]}') as any;
  o.route = async () => '네';
  const posts: string[] = [];
  await o.handleMention({ text: 'retry me later', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(posts).toEqual(['네']);
});

it('scheduler 미주입 협업 실패 → 기존 실패 메시지(회귀)', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager"]}') as any;
  o.collaborate = async () => { throw new Error('boom'); };
  const posts: string[] = [];
  await o.handleMention({ text: '서버비 정리해줘', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.drainForTest();
  expect(posts.some((p) => p.includes('Something went wrong'))).toBe(true);
});
