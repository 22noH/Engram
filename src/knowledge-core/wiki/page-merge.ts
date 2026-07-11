import { PageFrontmatter } from './page.types';

// 두 편집을 규칙으로 조정(결정론적). 동시 편집 충돌 시 frontmatter를 합친다.
export function reconcileFrontmatter(ours: PageFrontmatter, theirs: PageFrontmatter): PageFrontmatter {
  const newer = theirs.updated > ours.updated ? theirs : ours; // ISO 문자열 비교. 동률이면 ours.
  return {
    title: newer.title,
    category: newer.category,
    // 지식 가시성 유지 — 한쪽이라도 published면 published.
    status: ours.status === 'published' || theirs.status === 'published' ? 'published' : 'draft',
    sources: [...new Set([...ours.sources, ...theirs.sources])], // 순서보존 dedup — 무손실
    created: ours.created < theirs.created ? ours.created : theirs.created, // 최초
    updated: ours.updated > theirs.updated ? ours.updated : theirs.updated, // 최신
  };
}

// 진짜 본문 겹침의 폴백: 양쪽 다 보존(손실 0). 같으면 하나.
export function unionBodies(oursBody: string, theirsBody: string): string {
  if (oursBody.trim() === theirsBody.trim()) return oursBody;
  return `${oursBody}\n\n<!-- merge: 동시 편집 양쪽 보존 -->\n\n${theirsBody}`;
}
