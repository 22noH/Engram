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
    // gray-matter가 본문 앞뒤에 주입하는 개행 1개씩만 제거한다(사용자 후행 공백은 보존).
    // 단, 본문 경계의 빈 줄(앞/뒤 연속 개행)은 gray-matter가 정규화하므로 완전한 바이트 단위 왕복은 보장하지 않는다.
    body: parsed.content.replace(/^\n/, '').replace(/\n$/, ''),
  };
}
