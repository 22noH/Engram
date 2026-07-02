import { Orchestrator } from './orchestrator';

const logger = { warn() {}, error() {}, log() {} } as any;

// 생성자 19인자: (reader..paths, rag). rag 주입이 이 스펙의 핵심.
function orc(brainJson: string, hits: Array<{ slug: string; title: string; text: string; score: number }>) {
  let brainCalls = 0;
  const brain = { complete: async () => { brainCalls++; return { text: brainJson, costUsd: 0, isError: false }; } } as any;
  let ragCalls = 0;
  const rag = { search: async () => { ragCalls++; return hits; } } as any;
  const conversations = { append: async () => {} } as any;
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
    brain, null as any, null as any, { all: () => [] } as any, null as any,
    rag,
  ) as any;
  return { o, counts: { get brain() { return brainCalls; }, get rag() { return ragCalls; } } };
}

const HIT = [{ slug: 'rag-notes', title: 'RAG 노트', text: '마이그레이션은 …', score: 0.03 }];

it('통과: RAG 적중+interject=true → 💡 게시', async () => {
  const { o } = orc('{"interject":true,"text":"위키 rag-notes에 정리돼 있어요"}', HIT);
  const posts: string[] = [];
  await o.observe({ text: 'LanceDB 마이그레이션 어떻게 했더라?', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(posts).toEqual(['💡 위키 rag-notes에 정리돼 있어요']);
});

it('짧은 메시지(<10자) → RAG조차 미호출', async () => {
  const { o, counts } = orc('{"interject":true,"text":"x"}', HIT);
  await o.observe({ text: 'ㅇㅋ', userId: 'c1' }, async () => {});
  expect(counts.rag).toBe(0);
});

it('쿨다운: 게시 직후 두 번째 관찰은 스킵', async () => {
  const { o } = orc('{"interject":true,"text":"참고하세요"}', HIT);
  const posts: string[] = [];
  const post = async (t: string) => { posts.push(t); };
  await o.observe({ text: '마이그레이션 질문입니다', userId: 'c1' }, post);
  await o.observe({ text: '마이그레이션 추가 질문입니다', userId: 'c1' }, post);
  expect(posts).toHaveLength(1);
});

it('쿨다운이 지나면 다시 게시(now seam)', async () => {
  const { o } = orc('{"interject":true,"text":"참고"}', HIT);
  let t = 1_000_000; o.now = () => t;
  const posts: string[] = [];
  await o.observe({ text: '마이그레이션 질문입니다', userId: 'c1' }, async (x: string) => { posts.push(x); });
  t += 31 * 60_000; // 31분 경과
  await o.observe({ text: '마이그레이션 재질문입니다', userId: 'c1' }, async (x: string) => { posts.push(x); });
  expect(posts).toHaveLength(2);
});

it('RAG 무결과 → 두뇌 미호출', async () => {
  const { o, counts } = orc('{"interject":true,"text":"x"}', []);
  await o.observe({ text: '위키에 없는 주제 이야기입니다', userId: 'c1' }, async () => {});
  expect(counts.brain).toBe(0);
});

it('interject=false → 게시 없음 + 쿨다운 미기록(다음 관찰이 다시 RAG 도달)', async () => {
  const { o, counts } = orc('{"interject":false,"text":""}', HIT);
  await o.observe({ text: '마이그레이션 질문입니다', userId: 'c1' }, async () => {});
  await o.observe({ text: '마이그레이션 재질문입니다', userId: 'c1' }, async () => {});
  expect(counts.rag).toBe(2);
});

it('두뇌 throw → 무음(게시 0, 예외 전파 없음)', async () => {
  const { o } = orc('irrelevant', HIT);
  o.codeBrain = { complete: async () => { throw new Error('boom'); } };
  const posts: string[] = [];
  await expect(o.observe({ text: '마이그레이션 질문입니다', userId: 'c1' }, async (t: string) => { posts.push(t); })).resolves.toBeUndefined();
  expect(posts).toHaveLength(0);
});

it('rag 미주입(18인자 구식) → 무음 no-op', async () => {
  const conversations = { append: async () => {} } as any;
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
  ) as any;
  await expect(o.observe({ text: '마이그레이션 질문입니다', userId: 'c1' }, async () => {})).resolves.toBeUndefined();
});

it('insight(userId, date) → reporter.run에 date 패스스루', async () => {
  const conversations = { append: async () => {} } as any;
  const seen: any = {};
  const reporter = { run: async (u: string, d?: string) => { seen.u = u; seen.d = d; return null; } } as any;
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
    null as any, null as any, reporter, null as any, null as any,
  );
  await o.insight('c1', '2026-07-01');
  expect(seen).toEqual({ u: 'c1', d: '2026-07-01' });
});
