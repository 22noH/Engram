import matter from 'gray-matter';
import { PageFrontmatter, WikiPage } from './page.types';

// WikiPage <-> .md 파일 문자열 직렬화(설계 §5.1).
// frontmatter(YAML) + 마크다운 본문 구조. gray-matter로 왕복 변환을 보장한다.

export function serializePage(page: WikiPage): string {
  // gray-matter는 (본문, 데이터) 순서로 frontmatter를 앞에 붙여 직렬화한다.
  return matter.stringify(page.body, page.frontmatter);
}

// ★frontmatter는 캐스트가 아니라 정규화로 받는다(2026-07-30 실사고).
//
// `parsed.data as PageFrontmatter`는 거짓말이었다. gray-matter는 YAML이 준 값을 그대로 주므로
// `title: 2026-07-30`은 **Date**, 빈 `category:`는 **null**, 키가 없으면 **undefined**가 온다.
// 앱이 쓴 페이지는 늘 문자열이라 개발 머신에서는 절대 안 나오고, git으로 동기화된 위키나 사람이
// 손으로 고친 페이지에서만 나온다 — 그리고 그때 부팅이 통째로 멈췄다:
//   crypto.update(Date) → ERR_INVALID_ARG_TYPE → 부팅 재색인 전체 reject → 앱이 안 켜진다
//   LanceDB category 열은 non-nullable → null이면 그 페이지는 영영 검색되지 않는다
// 읽는 지점이 여기 하나뿐이라(wiki-engine·wiki-git 모두 이 함수를 지난다) 여기서 한 번 문자열로
// 만들면 RAG·폴더 트리·화면이 같이 낫는다. 캐스트로 넘긴 대가는 부팅 정지였다.
function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  // `title: 2026-07-30`은 자정 UTC Date로 온다 — 사용자가 적은 그대로(날짜만) 보이게 되돌린다.
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().replace(/T00:00:00\.000Z$/, '');
  return String(v);
}

function normalizeFrontmatter(data: Record<string, unknown>): PageFrontmatter {
  const sources = Array.isArray(data.sources)
    ? data.sources.map(text).filter((s) => s !== '')
    : text(data.sources) !== ''
      ? [text(data.sources)]
      : [];
  // status는 손대지 않는다 — 색인·해시에 쓰이지 않고(터질 곳이 없다), 값이 이상하면 오늘도
  // published 필터에서 걸러지므로 동작이 그대로다. 모르는 키는 보존한다(왕복 유지).
  return {
    ...data,
    title: text(data.title),
    category: text(data.category),
    sources,
    created: text(data.created),
    updated: text(data.updated),
  } as PageFrontmatter;
}

export function parsePage(slug: string, fileContent: string): WikiPage {
  const parsed = matter(fileContent);
  return {
    slug,
    frontmatter: normalizeFrontmatter(parsed.data as Record<string, unknown>),
    // gray-matter가 본문 앞뒤에 주입하는 개행 1개씩만 제거한다(사용자 후행 공백은 보존).
    // 단, 본문 경계의 빈 줄(앞/뒤 연속 개행)은 gray-matter가 정규화하므로 완전한 바이트 단위 왕복은 보장하지 않는다.
    body: parsed.content.replace(/^\n/, '').replace(/\n$/, ''),
  };
}
