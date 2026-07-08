import { Orchestrator } from './orchestrator';

const logger = { warn() {}, error() {}, log() {} } as any;

// 생성자 18인자: (reader, conversations, logger, ingester, tasks, specialist, synth, sem,
//   projects, gate, codingGit, coder, reviewer, codeBrain, fence, reporter, registry, paths)
function orc(classifyJson: string) {
  const brain = { complete: async () => ({ text: classifyJson, costUsd: 0, isError: false }) } as any;
  const registry = { all: () => [] } as any;
  const conversations = { append: async () => {} } as any;
  const projects = {} as any;                 // truthy (startProposal 가드 통과)
  const fence = { assertWritable() {} } as any; // 기본 허용
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    projects, null as any, null as any, null as any, null as any,
    brain, fence, null as any, registry, null as any,
  );
  return o;
}

it('code 1개 매칭 → proposeProject 후 완성조건·대상 게시(승인 대기)', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"버그 고쳐"}');
  (o as any).resolveRepoPaths = () => ['C:/repos/api'];
  (o as any).proposeProject = async () => ({ id: 'p1', acceptanceCriteria: ['로그인 통과'], gate: { test: true, build: false, typecheck: true } });
  const posts: string[] = [];
  await o.handleMention({ text: 'api에 버그 고쳐', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts[0]).toContain('C:/repos/api');
  expect(posts[0]).toContain('로그인 통과');
  expect(posts[0]).toContain('approve');
});

it('code 여러 매칭 → 번호 목록, 번호 답장으로 선택→제안', async () => {
  const o = orc('{"kind":"code","repo":"app","goal":"고쳐"}');
  (o as any).resolveRepoPaths = () => ['C:/a/app-web', 'C:/a/app-api'];
  const proposed: string[] = [];
  (o as any).proposeProject = async (p: string) => { proposed.push(p); return { id: 'p1', acceptanceCriteria: ['x'], gate: { test: false, build: false, typecheck: false } }; };
  const posts: string[] = [];
  await o.handleMention({ text: 'app 고쳐', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts[0]).toContain('1.');
  expect(posts[0]).toContain('2.');
  await o.handleMention({ text: '2', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(proposed).toEqual(['C:/a/app-api']);
});

it('승인 → approveProject + codeRun 호출, 성공 메시지', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  (o as any).resolveRepoPaths = () => ['C:/repos/api'];
  (o as any).proposeProject = async () => ({ id: 'p1', acceptanceCriteria: ['x'], gate: { test: true, build: false, typecheck: false } });
  let approved = ''; let ran = '';
  (o as any).approveProject = async (id: string) => { approved = id; };
  (o as any).codeRun = async (id: string) => { ran = id; return { status: 'SUCCESS', sessionId: 's1' }; };
  const posts: string[] = [];
  await o.handleMention({ text: 'api에 g', userId: 'c1' }, async (t) => { posts.push(t); });
  await o.handleMention({ text: '승인', userId: 'c1' }, async (t) => { posts.push(t); });
  await (o as any).drainForTest();
  expect(approved).toBe('p1');
  expect(ran).toBe('p1');
  expect(posts.some((p) => p.includes('✅'))).toBe(true);
});

it('취소 → 대기 폐기', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  (o as any).resolveRepoPaths = () => ['C:/repos/api'];
  (o as any).proposeProject = async () => ({ id: 'p1', acceptanceCriteria: ['x'], gate: { test: false, build: false, typecheck: false } });
  let ran = false; (o as any).approveProject = async () => { ran = true; }; (o as any).codeRun = async () => { ran = true; return { status: 'SUCCESS', sessionId: 's' }; };
  const posts: string[] = [];
  await o.handleMention({ text: 'api에 g', userId: 'c1' }, async () => {});
  await o.handleMention({ text: '취소', userId: 'c1' }, async (t) => { posts.push(t); });
  await o.handleMention({ text: '승인', userId: 'c1' }, async () => {}); // 이제 대기 없음 → 무시(chat 폴백)
  expect(posts.some((p) => p.includes('Cancelled'))).toBe(true);
  expect(ran).toBe(false);
});

it('repo 못 찾음 → 안내', async () => {
  const o = orc('{"kind":"code","repo":"nope","goal":"g"}');
  (o as any).resolveRepoPaths = () => [];
  const posts: string[] = [];
  await o.handleMention({ text: 'nope에 g', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts[0]).toContain("Couldn't find");
});

it('fence 거부 → 안내(proposeProject 호출 안 함)', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  (o as any).resolveRepoPaths = () => ['C:/Windows'];
  (o as any).fence = { assertWritable() { throw new Error('denied'); } };
  let proposed = false; (o as any).proposeProject = async () => { proposed = true; return {} as any; };
  const posts: string[] = [];
  await o.handleMention({ text: 'api에 g', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(proposed).toBe(false);
  expect(posts[0]).toContain("Can't write there");
});

it('escape hatch "code <repo> <goal>" → startCoding', async () => {
  const o = orc('{"kind":"chat","team":[]}'); // 분류 무시돼야
  const seen: any = {};
  (o as any).startCoding = async (repoRef: string, goal: string) => { seen.repoRef = repoRef; seen.goal = goal; };
  await o.handleMention({ text: 'code api 로그인 고쳐', userId: 'c1' }, async () => {});
  expect(seen).toEqual({ repoRef: 'api', goal: '로그인 고쳐' });
});

it('codeRun STUCK → 경고 메시지', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  (o as any).resolveRepoPaths = () => ['C:/repos/api'];
  (o as any).proposeProject = async () => ({ id: 'p1', acceptanceCriteria: ['x'], gate: { test: false, build: false, typecheck: false } });
  (o as any).approveProject = async () => {};
  (o as any).codeRun = async () => ({ status: 'STUCK', sessionId: 's1' });
  const posts: string[] = [];
  await o.handleMention({ text: 'api에 g', userId: 'c1' }, async () => {});
  await o.handleMention({ text: '승인', userId: 'c1' }, async (t) => { posts.push(t); });
  await (o as any).drainForTest();
  expect(posts.some((p) => p.includes('⚠️'))).toBe(true);
});

it('모호 선택 중 비숫자 대화가 오면 대기를 비워 스테일 번호선택 방지', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  (o as any).resolveRepoPaths = () => ['C:/a/app-web', 'C:/a/app-api'];
  let proposed = false;
  (o as any).proposeProject = async () => { proposed = true; return { id: 'p', acceptanceCriteria: ['x'], gate: { test: false, build: false, typecheck: false } }; };
  (o as any).route = async () => '네';
  await o.handleMention({ text: 'code app 고쳐', userId: 'c1' }, async () => {}); // 2개 → 모호(disambiguate)
  await o.handleMention({ text: '안녕', userId: 'c1' }, async () => {});          // 비숫자 → 대기 비움
  await o.handleMention({ text: '1', userId: 'c1' }, async () => {});            // 스테일 없음 → 후보선택 안 함
  expect(proposed).toBe(false);
});
