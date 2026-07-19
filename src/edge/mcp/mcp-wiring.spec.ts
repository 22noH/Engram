import { makeWikiMcpDeps, makeWikiWrite, makeFileSearch, makeWikiMcpDepsCore } from './mcp-wiring';
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

// 근본픽스(2026-07-20): 헤드리스 코어 모드는 RagStore를 절대 열지 않는다 — makeFileSearch는 그
// 대체 경로(텍스트 폴백 검색)다. wiki.search()(RagStore 위임)는 이 경로에서 절대 호출되지 않는다.
describe('makeFileSearch', () => {
  const pages = [
    { slug: 'rust-tips', frontmatter: { title: 'Rust 학습 팁' }, body: '오너십과 대여를 먼저 익혀라. 러스트는 처음엔 낯설다.' },
    { slug: 'ts-generics', frontmatter: { title: 'TypeScript 제네릭' }, body: '제네릭은 타입을 매개변수화한다. 재사용성이 좋아진다.' },
    { slug: 'cooking', frontmatter: { title: '파스타 레시피' }, body: '마늘과 올리브오일로 알리오 올리오를 만든다.' },
  ];

  function fakeWikiWithPages(list: typeof pages): WikiEngine {
    return { listPages: jest.fn().mockResolvedValue(list) } as unknown as WikiEngine;
  }

  it('published 페이지만 대상(listPages를 status:published로 호출)', async () => {
    const listPages = jest.fn().mockResolvedValue([]);
    const wiki = { listPages } as unknown as WikiEngine;
    await makeFileSearch(wiki)('rust', 5);
    expect(listPages).toHaveBeenCalledWith({ status: 'published' });
  });

  it('빈/공백 쿼리는 서버 왕복 없이 빈 배열', async () => {
    const listPages = jest.fn().mockResolvedValue(pages);
    const wiki = { listPages } as unknown as WikiEngine;
    expect(await makeFileSearch(wiki)('   ', 5)).toEqual([]);
    expect(listPages).not.toHaveBeenCalled();
  });

  it('제목·본문에 대소문자 무시 부분일치하는 페이지만 반환', async () => {
    const wiki = fakeWikiWithPages(pages);
    const hits = await makeFileSearch(wiki)('RUST', 5);
    expect(hits.map((h) => h.slug)).toEqual(['rust-tips']);
  });

  it('제목 일치가 본문만 일치보다 상위(스코어 정렬)', async () => {
    const withTitleMatch = [
      { slug: 'a', frontmatter: { title: '제네릭 가이드' }, body: '평범한 설명' },
      { slug: 'b', frontmatter: { title: '무관한 제목' }, body: '제네릭이 여기 살짝 언급된다' },
    ];
    const wiki = fakeWikiWithPages(withTitleMatch);
    const hits = await makeFileSearch(wiki)('제네릭', 5);
    expect(hits.map((h) => h.slug)).toEqual(['a', 'b']);
  });

  it('limit으로 결과 개수 제한', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      slug: `p${i}`, frontmatter: { title: `공통어 페이지 ${i}` }, body: '본문',
    }));
    const wiki = fakeWikiWithPages(many);
    const hits = await makeFileSearch(wiki)('공통어', 2);
    expect(hits).toHaveLength(2);
  });

  it('매치 없으면 빈 배열', async () => {
    const wiki = fakeWikiWithPages(pages);
    expect(await makeFileSearch(wiki)('블록체인', 5)).toEqual([]);
  });

  it('결과 항목은 slug/title/snippet만 포함(발췌 텍스트 존재)', async () => {
    const wiki = fakeWikiWithPages(pages);
    const hits = await makeFileSearch(wiki)('제네릭', 5);
    expect(hits[0]).toEqual(
      expect.objectContaining({ slug: 'ts-generics', title: 'TypeScript 제네릭' }),
    );
    expect(typeof hits[0].snippet).toBe('string');
    expect(hits[0].snippet.length).toBeGreaterThan(0);
  });
});

describe('makeWikiMcpDepsCore', () => {
  it('search는 makeFileSearch(텍스트 폴백)로 대체되고 searchFallback:true', async () => {
    const listPages = jest.fn().mockResolvedValue([
      { slug: 'rust-tips', frontmatter: { title: 'Rust 학습 팁' }, body: '러스트 오너십' },
    ]);
    const wiki = fakeWiki({ listPages });
    const search = jest.fn(); // wiki.search가 정의돼 있어도(fakeWiki 기본) 절대 호출되면 안 됨
    Object.assign(wiki, { search });
    const deps = makeWikiMcpDepsCore(wiki, fakeProposals().store);

    expect(deps.searchFallback).toBe(true);
    const hits = await deps.search('러스트', 5);
    expect(hits.map((h) => h.slug)).toEqual(['rust-tips']);
    expect(search).not.toHaveBeenCalled(); // RagStore 위임 wiki.search()는 절대 호출되지 않는다
    expect(listPages).toHaveBeenCalledWith({ status: 'published' });
  });

  it('read/list/propose는 makeWikiMcpDeps와 동일 동작(회귀 없음)', async () => {
    const getPage = jest.fn().mockResolvedValue({ frontmatter: { title: 'T', status: 'published' }, body: 'B' });
    const wiki = fakeWiki({ getPage });
    const deps = makeWikiMcpDepsCore(wiki, fakeProposals().store);
    expect(await deps.read('slug1')).toEqual({ title: 'T', content: 'B' });
  });
});
