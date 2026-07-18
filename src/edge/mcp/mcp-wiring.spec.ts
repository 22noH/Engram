import { makeWikiMcpDeps, makeWikiWrite } from './mcp-wiring';
import type { WikiEngine } from '../../knowledge-core/wiki/wiki-engine';
import type { ProposalStore, NewProposal, Proposal } from '../../knowledge-core/proposal-store';

// 가짜 WikiEngine/ProposalStore — makeWikiMcpDeps/makeWikiWrite가 실제로 호출하는 메서드만 구현.
function fakeWiki(overrides: Partial<WikiEngine> = {}): WikiEngine {
  return {
    search: jest.fn().mockResolvedValue([]),
    getPage: jest.fn().mockResolvedValue(null),
    listPages: jest.fn().mockResolvedValue([]),
    editPage: jest.fn(),
    createPage: jest.fn(),
    ...overrides,
  } as unknown as WikiEngine;
}

function fakeProposals(): { store: ProposalStore; enqueue: jest.Mock } {
  const enqueue = jest.fn().mockImplementation(async (p: NewProposal): Promise<Proposal> => ({
    ...p, id: 'prop-1', createdTs: '2026-01-01T00:00:00Z', status: 'pending',
  }));
  return { store: { enqueue } as unknown as ProposalStore, enqueue };
}

describe('makeWikiMcpDeps', () => {
  it('search: WikiEngine.search 결과를 {slug,title,snippet}로 매핑(text→snippet)', async () => {
    const search = jest.fn().mockResolvedValue([{ slug: 's1', title: 'T1', text: 'body text 1' }]);
    const wiki = fakeWiki({ search });
    const deps = makeWikiMcpDeps(wiki, fakeProposals().store);
    const hits = await deps.search('query', 5);
    expect(search).toHaveBeenCalledWith('query', 5);
    expect(hits).toEqual([{ slug: 's1', title: 'T1', snippet: 'body text 1' }]);
  });

  it('read: published 페이지만 반환', async () => {
    const getPage = jest.fn().mockResolvedValue({
      frontmatter: { title: 'T', status: 'published' }, body: 'B',
    });
    const wiki = fakeWiki({ getPage });
    const deps = makeWikiMcpDeps(wiki, fakeProposals().store);
    const page = await deps.read('slug1');
    expect(getPage).toHaveBeenCalledWith('slug1');
    expect(page).toEqual({ title: 'T', content: 'B' });
  });

  it('read: draft 페이지는 null(비게시)', async () => {
    const getPage = jest.fn().mockResolvedValue({ frontmatter: { title: 'T', status: 'draft' }, body: 'B' });
    const wiki = fakeWiki({ getPage });
    const deps = makeWikiMcpDeps(wiki, fakeProposals().store);
    expect(await deps.read('slug1')).toBeNull();
  });

  it('read: 없는 페이지는 null', async () => {
    const wiki = fakeWiki({ getPage: jest.fn().mockResolvedValue(null) });
    const deps = makeWikiMcpDeps(wiki, fakeProposals().store);
    expect(await deps.read('nope')).toBeNull();
  });

  it('list: published 필터로 listPages 호출 + {slug,title,category} 매핑', async () => {
    const listPages = jest.fn().mockResolvedValue([
      { slug: 's1', frontmatter: { title: 'T1', category: 'c1' } },
    ]);
    const wiki = fakeWiki({ listPages });
    const deps = makeWikiMcpDeps(wiki, fakeProposals().store);
    const list = await deps.list();
    expect(listPages).toHaveBeenCalledWith({ status: 'published' });
    expect(list).toEqual([{ slug: 's1', title: 'T1', category: 'c1' }]);
  });

  it('propose: makeMcpPropose와 동형 — enqueue 호출 후 id 반환', async () => {
    const wiki = fakeWiki({ getPage: jest.fn().mockResolvedValue(null) });
    const { store, enqueue } = fakeProposals();
    const deps = makeWikiMcpDeps(wiki, store);
    const id = await deps.propose({ title: 'New Page', content: 'C' });
    expect(id).toBe('prop-1');
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ targetSlug: 'new-page', op: 'create' }));
  });
});

describe('makeWikiWrite', () => {
  it('기존 slug(published) → editPage(target, content), "updated {slug}" 반환', async () => {
    const editPage = jest.fn().mockResolvedValue(undefined);
    const wiki = fakeWiki({
      getPage: jest.fn().mockResolvedValue({ frontmatter: { title: 'T', status: 'published' }, body: 'old' }),
      editPage,
    });
    const write = makeWikiWrite(wiki);
    const result = await write({ slug: 'existing', title: 'T', content: 'new body' });
    expect(editPage).toHaveBeenCalledWith('existing', 'new body');
    expect(result).toBe('updated existing');
  });

  it('기존 slug가 draft(비게시) → editPage가 throw → write도 throw(정직한 실패, 조용한 무효쓰기 아님)', async () => {
    const editPage = jest.fn().mockRejectedValue(new Error('Not published: default/existing'));
    const wiki = fakeWiki({
      getPage: jest.fn().mockResolvedValue({ frontmatter: { title: 'T', status: 'draft' }, body: 'old' }),
      editPage,
    });
    const write = makeWikiWrite(wiki);
    await expect(write({ slug: 'existing', title: 'T', content: 'new body' })).rejects.toThrow('Not published');
  });

  it('없는 slug → createPage({slug,title,category:"external",body,sources:["mcp"],status:"published"}), "created {slug}" 반환', async () => {
    const createPage = jest.fn().mockResolvedValue(undefined);
    const wiki = fakeWiki({ getPage: jest.fn().mockResolvedValue(null), createPage });
    const write = makeWikiWrite(wiki);
    const result = await write({ slug: 'brand-new', title: 'Brand New', content: 'body' });
    expect(createPage).toHaveBeenCalledWith({
      slug: 'brand-new', title: 'Brand New', category: 'external', body: 'body', sources: ['mcp'], status: 'published',
    });
    expect(result).toBe('created brand-new');
  });

  it('slug 미지정 → title을 slugify해 target 결정 후 createPage', async () => {
    const createPage = jest.fn().mockResolvedValue(undefined);
    const wiki = fakeWiki({ getPage: jest.fn().mockResolvedValue(null), createPage });
    const write = makeWikiWrite(wiki);
    await write({ title: 'My Cool Title', content: 'body' });
    expect(createPage).toHaveBeenCalledWith(expect.objectContaining({ slug: 'my-cool-title' }));
  });
});
