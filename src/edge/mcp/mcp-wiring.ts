import type { WikiEngine } from '../../knowledge-core/wiki/wiki-engine';
import type { ProposalStore } from '../../knowledge-core/proposal-store';
import type { McpDeps } from './engram-mcp';
import { makeMcpPropose, slugifyMcpTitle } from './mcp-propose';

// main.ts(앱 /mcp)와 mcp-headless.ts(헤드리스)가 공유하는 위키 McpDeps 조립부(헤드리스 설계 §3.1
// 바인딩 요건 — main.ts의 기존 인라인 배선을 그대로 추출, 동작 무변경).

// search/read/list/propose — main.ts의 기존 매핑과 동일(published만 read/list, search는 텍스트→snippet).
export function makeWikiMcpDeps(
  wiki: WikiEngine,
  proposals: ProposalStore,
): Pick<McpDeps, 'search' | 'read' | 'list' | 'propose'> {
  return {
    search: async (query, limit) =>
      (await wiki.search(query, limit)).map((h) => ({ slug: h.slug, title: h.title, snippet: h.text })),
    read: async (slug) => {
      const page = await wiki.getPage(slug);
      if (!page || page.frontmatter.status !== 'published') return null;
      return { title: page.frontmatter.title, content: page.body };
    },
    list: async () =>
      (await wiki.listPages({ status: 'published' })).map((p) => ({
        slug: p.slug, title: p.frontmatter.title, category: p.frontmatter.category,
      })),
    // targetSlug 선확정 → 그 slug로 존재 검사(한글 제목 slugify 폴백 충돌 봉쇄 — mcp-propose.ts).
    propose: makeMcpPropose(wiki, proposals),
  };
}

// wiki_write 실 구현(§3.3, main.ts 0fe1f02 리뷰 반영분 verbatim 추출).
// 기존 slug면 editPage(★게시본 전용 — draft면 throw→isError로 정직하게 실패, updatePage는
// draft를 조용히 미게시 상태로 두는 무효 쓰기가 됨[리뷰 적발])·없으면 createPage(published).
export function makeWikiWrite(wiki: WikiEngine): NonNullable<McpDeps['write']> {
  return async ({ slug, title, content }) => {
    const target = slug ?? slugifyMcpTitle(title);
    const existing = await wiki.getPage(target);
    if (existing) {
      await wiki.editPage(target, content);
      return `updated ${target}`;
    }
    await wiki.createPage({ slug: target, title, category: 'external', body: content, sources: ['mcp'], status: 'published' });
    return `created ${target}`;
  };
}
