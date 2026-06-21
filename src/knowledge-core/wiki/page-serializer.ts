import matter from 'gray-matter';
import { PageFrontmatter, WikiPage } from './page.types';

// WikiPage <-> .md 파일 문자열 직렬화(설계 §5.1).
// frontmatter(YAML) + 마크다운 본문 구조. gray-matter로 왕복 변환을 보장한다.

export function serializePage(page: WikiPage): string {
  // gray-matter는 (본문, 데이터) 순서로 frontmatter를 앞에 붙여 직렬화한다.
  return matter.stringify(page.body, page.frontmatter);
}

export function parsePage(slug: string, fileContent: string): WikiPage {
  const parsed = matter(fileContent);
  return {
    slug,
    frontmatter: parsed.data as PageFrontmatter,
    // stringify가 본문 앞뒤로 개행을 주입하므로, 그 개행만 제거해 왕복 동일성을 맞춘다.
    // (trim()은 사용자의 의도적 후행 공백까지 없애므로 사용하지 않는다)
    body: parsed.content.replace(/^\n/, '').replace(/\n$/, ''),
  };
}
