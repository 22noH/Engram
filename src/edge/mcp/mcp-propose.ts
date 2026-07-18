import type { NewProposal, Proposal } from '../../knowledge-core/proposal-store';
import { DEFAULT_USER } from '../../pal/path-resolver';

// MCP wiki_propose의 targetSlug 폴백(Phase 8c-2). ingester-agent.ts의 비공개 slugify(한글 유지)와
// 달리 외부 MCP 클라이언트용이라 ascii 소문자-하이픈로 단순화. ★비ascii 전용 제목(한글 등)은
// 빈 문자열로 붕괴하는데, 고정 'untitled'로 폴백하면 그런 제안 두 개가 같은 slug로 충돌해
// 두 번째 승인이 EEXIST로 영원히 pending에 남는다(리뷰 적발) — 시각+난수 접미로 유일화.
export function slugifyMcpTitle(title: string): string {
  const s = title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || `untitled-${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
}

// McpDeps.propose 실 구현 팩토리(main.ts가 실 WikiEngine/ProposalStore로 배선, 테스트는 가짜 주입).
// ★targetSlug를 먼저 확정한 뒤 그 slug로 존재를 검사한다(리뷰 적발: input.slug로만 검사하면
// slugify 폴백 slug와 op 판단이 어긋나 create/EEXIST 충돌). 존재하면 published 여부 무관 'append'
// (ProposalApplier가 기존 파일에 append — draft여도 파일은 있으므로 create는 EEXIST).
export function makeMcpPropose(
  wiki: { getPage(slug: string): Promise<object | null> },
  proposals: { enqueue(p: NewProposal): Promise<Proposal> },
): (input: { slug?: string; title: string; content: string; reason?: string }) => Promise<string> {
  return async (input) => {
    const targetSlug = input.slug ?? slugifyMcpTitle(input.title);
    const existing = await wiki.getPage(targetSlug);
    const p = await proposals.enqueue({
      userId: DEFAULT_USER,
      op: existing ? 'append' : 'create',
      targetSlug,
      title: input.title,
      category: 'external',
      payload: input.content,
      sources: ['mcp'],
      importance: 3,
      verdict: { confidence: 0.5, reason: `external MCP client proposal${input.reason ? `: ${input.reason}` : ''}` },
    });
    return p.id;
  };
}
