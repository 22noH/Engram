// 위키 분류 경로(2026-07-27). category를 `engram/release`처럼 슬래시 경로로 쓰고, 화면의 폴더
// 트리는 이 문자열에서 파생한다. ★파일을 실제 중첩 폴더로 옮기지는 않는다 — slug 조회(pagePath),
// git 이력, RAG 색인, 원격 동기화가 전부 평면 구조를 전제로 돌아간다. 보이는 결과는 같고 위험만 작다.
//
// 값은 사람이 읽는 라벨이라 대소문자·한글·공백을 보존한다. 다만 경로로 쓰이니 구분자·깊이·길이는 조인다.

export const CATEGORY_MAX_DEPTH = 3;
export const CATEGORY_MAX_SEGMENT = 40;
export const CATEGORY_FALLBACK = 'external';

// 정규화 결과. 못 쓰는 값이면 null — 호출자가 폴백을 정한다(조용히 이상한 값을 저장하지 않는다).
export function normalizeCategoryPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const segments = raw
    .replace(/\\/g, '/') // 윈도우 습관으로 역슬래시를 넣어도 같은 뜻으로 받는다
    // 제어문자는 프론트매터(YAML)와 화면 양쪽을 깨뜨린다 — 세그먼트 안에서도 제거.
    .split('/')
    .map((s) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .filter((s) => s.length > 0)
    // '.'·'..'는 지금 구조에선 무해하지만, 나중에 실제 폴더로 바뀌면 곧바로 경로 이탈이 된다.
    // 그때 가서 기억해내는 대신 지금 막는다(path-safety 백스톱과 같은 결).
    .filter((s) => s !== '.' && s !== '..')
    .map((s) => (s.length > CATEGORY_MAX_SEGMENT ? s.slice(0, CATEGORY_MAX_SEGMENT).trim() : s));
  if (segments.length === 0) return null;
  return segments.slice(0, CATEGORY_MAX_DEPTH).join('/');
}

// 저장용 — 못 쓰는 값이면 폴백. 기존 동작(분류 미지정 = 'external')을 그대로 유지한다.
export function categoryOrFallback(raw: unknown, fallback: string = CATEGORY_FALLBACK): string {
  return normalizeCategoryPath(raw) ?? fallback;
}

export interface CategoryNode {
  /** 이 마디의 라벨(마지막 세그먼트). */
  name: string;
  /** 루트부터의 전체 경로 — 목록 필터에 그대로 쓴다. */
  path: string;
  children: CategoryNode[];
  /** 이 경로에 **직접** 달린 페이지 수(하위 폴더 것은 제외). */
  count: number;
}

// 카테고리 문자열 목록 → 폴더 트리. 화면(위키 사이드바)과 테스트가 같은 함수를 쓴다.
// 이름순 정렬 — 목록이 흔들리지 않아야 사람이 위치를 기억할 수 있다.
export function buildCategoryTree(categories: string[]): CategoryNode[] {
  const roots: CategoryNode[] = [];
  for (const raw of categories) {
    const norm = normalizeCategoryPath(raw) ?? CATEGORY_FALLBACK;
    let level = roots;
    let prefix = '';
    const parts = norm.split('/');
    parts.forEach((name, i) => {
      prefix = prefix ? `${prefix}/${name}` : name;
      let node = level.find((n) => n.name === name);
      if (!node) {
        node = { name, path: prefix, children: [], count: 0 };
        level.push(node);
      }
      if (i === parts.length - 1) node.count++;
      level = node.children;
    });
  }
  const sort = (nodes: CategoryNode[]): CategoryNode[] => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) sort(n.children);
    return nodes;
  };
  return sort(roots);
}
