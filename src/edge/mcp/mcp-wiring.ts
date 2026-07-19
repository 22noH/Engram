import type { WikiEngine } from '../../knowledge-core/wiki/wiki-engine';
import type { ProposalStore } from '../../knowledge-core/proposal-store';
import type { McpDeps } from './engram-mcp';
import { makeMcpPropose, slugifyMcpTitle } from './mcp-propose';

// main.ts(앱 /mcp)와 mcp-headless.ts(헤드리스)가 공유하는 위키 McpDeps 조립부(헤드리스 설계 §3.1
// 바인딩 요건 — main.ts의 기존 인라인 배선을 그대로 추출, 동작 무변경).

// search/read/list/propose — main.ts의 기존 매핑과 동일(published만 read/list, search는 텍스트→snippet).
// 브리지/앱(RagStore 탑재) 전용 — 헤드리스 코어 모드는 makeWikiMcpDepsCore를 대신 쓴다(근본픽스 2026-07-20).
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

// 텍스트 폴백 검색 발췌 반경(매치 앞뒤로 이만큼, 문자 수).
const EXCERPT_RADIUS = 80;

// body 내 matchIdx~matchIdx+matchLen 주변을 발췌·공백 정규화(줄바꿈 등)·잘렸으면 …로 표시.
function excerptAround(body: string, matchIdx: number, matchLen: number): string {
  const start = Math.max(0, matchIdx - EXCERPT_RADIUS);
  const end = Math.min(body.length, matchIdx + matchLen + EXCERPT_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return `${prefix}${body.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

// 헤드리스 코어 모드 전용 텍스트 폴백 검색(근본픽스 2026-07-20 — 코어 모드는 RagStore를 절대 열지
// 않으므로 wiki.search()가 아니라 이걸 쓴다). 의미검색이 아니라 대소문자 무시 부분일치/토큰 스코어링
// — published 페이지의 title/slug/body만 대상. "충분히 쓸만한" 디그레이드 경로가 목표이지 RAG를
// 대체하려는 게 아니다(의미검색은 앱/브리지 모드에서 그대로 제공됨).
export function makeFileSearch(wiki: WikiEngine): McpDeps['search'] {
  return async (query, limit) => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const tokens = q.split(/\s+/).filter(Boolean);
    const pages = await wiki.listPages({ status: 'published' });

    const scored: Array<{ slug: string; title: string; snippet: string; score: number }> = [];
    for (const page of pages) {
      const title = page.frontmatter.title ?? '';
      const titleLower = title.toLowerCase();
      const slugLower = page.slug.toLowerCase();
      const bodyLower = page.body.toLowerCase();

      let score = 0;
      if (titleLower.includes(q) || slugLower.includes(q)) score += 10; // 제목/슬러그 전체구 일치
      if (bodyLower.includes(q)) score += 5; // 본문 전체구 일치
      for (const t of tokens) {
        if (titleLower.includes(t)) score += 3;
        if (bodyLower.includes(t)) score += 1;
      }
      if (score === 0) continue;

      const wholeIdx = bodyLower.indexOf(q);
      const firstTokenIdx = wholeIdx === -1 ? bodyLower.indexOf(tokens[0] ?? '') : -1;
      const matchIdx = wholeIdx !== -1 ? wholeIdx : firstTokenIdx;
      const snippet = matchIdx !== -1
        ? excerptAround(page.body, matchIdx, wholeIdx !== -1 ? q.length : (tokens[0] ?? '').length)
        : `${page.body.slice(0, 160).trim()}${page.body.length > 160 ? '…' : ''}`;

      scored.push({ slug: page.slug, title, snippet, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ slug, title, snippet }) => ({ slug, title, snippet }));
  };
}

// 헤드리스 코어 모드용 McpDeps 조립부 — makeWikiMcpDeps와 read/list/propose는 동일하되 search만
// makeFileSearch(텍스트 폴백)로 교체하고 searchFallback:true로 도구 설명에 그 사실을 알린다
// (근본픽스 2026-07-20, engram-mcp.ts wikiSearchTool 참조). RagStore/wiki.search()는 여기서 절대
// 호출되지 않는다 — Lance는 앱/브리지 모드 전용.
export function makeWikiMcpDepsCore(
  wiki: WikiEngine,
  proposals: ProposalStore,
): Pick<McpDeps, 'search' | 'read' | 'list' | 'propose' | 'searchFallback'> {
  const base = makeWikiMcpDeps(wiki, proposals);
  return { read: base.read, list: base.list, propose: base.propose, search: makeFileSearch(wiki), searchFallback: true };
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
