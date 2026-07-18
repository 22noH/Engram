import { slugifyMcpTitle, makeMcpPropose } from './mcp-propose';
import type { NewProposal, Proposal } from '../../knowledge-core/proposal-store';

describe('slugifyMcpTitle', () => {
  it('ascii 제목 → 소문자-하이픈 slug', () => {
    expect(slugifyMcpTitle('My Cool Page!')).toBe('my-cool-page');
  });

  it('비ascii(한글) 전용 제목 → untitled- 접두 유일 slug, 두 번 호출해도 서로 다름(충돌 봉쇄)', () => {
    const a = slugifyMcpTitle('한글 제목');
    const b = slugifyMcpTitle('한글 제목');
    expect(a).toMatch(/^untitled-/);
    expect(b).toMatch(/^untitled-/);
    expect(a).not.toBe(b);
  });

  it('빈/공백 제목도 untitled- 접두 폴백', () => {
    expect(slugifyMcpTitle('   ')).toMatch(/^untitled-/);
  });
});

describe('makeMcpPropose', () => {
  function makeStore(): { enqueue: jest.Mock; last(): NewProposal } {
    const enqueue = jest.fn().mockImplementation(async (p: NewProposal): Promise<Proposal> => ({
      ...p, id: 'prop-1', createdTs: '2026-01-01T00:00:00Z', status: 'pending',
    }));
    return { enqueue, last: () => enqueue.mock.calls.at(-1)![0] as NewProposal };
  }

  it('명시 slug가 기존 페이지(draft 포함) → op=append, targetSlug=그 slug', async () => {
    const store = makeStore();
    const propose = makeMcpPropose({ getPage: async () => ({ slug: 'existing' }) }, store);
    const id = await propose({ slug: 'existing', title: 'T', content: 'C' });
    expect(id).toBe('prop-1');
    expect(store.last()).toMatchObject({ op: 'append', targetSlug: 'existing' });
  });

  it('명시 slug가 미존재 → op=create', async () => {
    const store = makeStore();
    const propose = makeMcpPropose({ getPage: async () => null }, store);
    await propose({ slug: 'brand-new', title: 'T', content: 'C' });
    expect(store.last()).toMatchObject({ op: 'create', targetSlug: 'brand-new' });
  });

  it('★존재 검사는 확정된 targetSlug로 한다(slug 미지정 시 slugify 결과로 getPage 호출)', async () => {
    const store = makeStore();
    const seen: string[] = [];
    const propose = makeMcpPropose(
      { getPage: async (slug) => { seen.push(slug); return slug === 'my-page' ? { slug } : null; } },
      store,
    );
    await propose({ title: 'My Page', content: 'C' });
    expect(seen).toEqual(['my-page']); // input.slug(undefined)가 아니라 slugify된 slug로 검사
    expect(store.last()).toMatchObject({ op: 'append', targetSlug: 'my-page' });
  });

  it('한글 제목 두 번(slug 미지정) → 서로 다른 targetSlug·둘 다 create(EEXIST 충돌 봉쇄)', async () => {
    const store = makeStore();
    const propose = makeMcpPropose({ getPage: async () => null }, store);
    await propose({ title: '한글 회의록', content: 'A' });
    const first = store.last();
    await propose({ title: '한글 회의록', content: 'B' });
    const second = store.last();
    expect(first.targetSlug).toMatch(/^untitled-/);
    expect(second.targetSlug).toMatch(/^untitled-/);
    expect(first.targetSlug).not.toBe(second.targetSlug);
    expect(first.op).toBe('create');
    expect(second.op).toBe('create');
  });

  it('제안 필드 계약: userId/category/sources/importance/verdict(reason 유무 반영)', async () => {
    const store = makeStore();
    const propose = makeMcpPropose({ getPage: async () => null }, store);
    await propose({ title: 'T', content: 'C', reason: 'because' });
    expect(store.last()).toMatchObject({
      userId: 'default', category: 'external', payload: 'C', sources: ['mcp'], importance: 3,
      verdict: { confidence: 0.5, reason: 'external MCP client proposal: because' },
    });
    await propose({ title: 'T', content: 'C' });
    expect(store.last().verdict.reason).toBe('external MCP client proposal');
  });
});
