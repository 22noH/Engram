// 추출된 텍스트 → 위키 페이지(들). 두뇌 호출 자체는 상위(folder-importer)가 하고,
// 여기는 프롬프트 조립·응답 파싱·원문모드·출처표시 같은 순수 로직만 담는다(테스트 가능).

/** 두뇌(또는 원문모드)가 만들어낸 페이지 한 장. slug가 있으면 그 문서에 덧붙인다. */
export interface OrganizedPage {
  /** 기존 문서에 덧붙일 때만 채워진다(중복 페이지 양산 금지). 없으면 제목에서 만든다. */
  slug?: string;
  title: string;
  category?: string;
  body: string;
}

export interface ExistingPage {
  slug: string;
  title: string;
  snippet?: string;
}

export interface OrganizeInput {
  /** 감시 폴더 기준 상대경로(출처 표시·프롬프트에 함께 들어간다). */
  rel: string;
  text: string;
  truncated?: boolean;
  /** RAG로 찾은 관련 기존 문서 — 두뇌가 "새 페이지 vs 덧붙임"을 고르는 근거. */
  existing: ExistingPage[];
  /** 이미지만 있는 파일(스캔·사진)이면 true — 두뇌는 텍스트 대신 그림을 본다. */
  imageOnly?: boolean;
}

/** 제목 → 파일명 안전한 slug(한글 유지 — ingester-agent.ts의 관례와 동일). */
export function slugifyTitle(title: string): string {
  const s = title.toLowerCase().trim().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  // 비ascii·비한글 전용 제목이 빈 문자열로 붕괴하면 서로 다른 문서가 같은 slug로 충돌한다
  // (mcp-propose.ts가 겪은 그 사고) — 시각+난수 접미로 유일화한다.
  return s || `import-${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
}

/**
 * 출처 꼬리말. 어떤 파일에서 왔는지가 본문 안에 남아야 잘못 만들어진 문서에서 원본을 되짚을 수 있다
 * (프론트매터 sources와 이중으로 남긴다 — 사람이 보는 건 본문 쪽).
 */
export function sourceFooter(rel: string, when: Date): string {
  return `\n\n---\n_Source: \`${rel}\` — imported from the watched folder on ${when.toISOString().slice(0, 10)}_`;
}

/** 프론트매터 sources에 넣는 출처 토큰. 절대경로를 넣지 않는 이유는 위키가 git으로 공유되기 때문. */
export function sourceToken(rel: string): string {
  return `file:${rel}`;
}

/** 원문 그대로 모드: 파일 하나 = 페이지 하나. 두뇌를 부르지 않는다(무료·즉시). */
export function rawPages(input: OrganizeInput): OrganizedPage[] {
  const title = titleFromRel(input.rel);
  const body = input.truncated
    ? `${input.text}\n\n_[truncated — the original file is longer than the import limit]_`
    : input.text;
  return [{ title, body }];
}

/** 상대경로 → 사람이 읽는 제목(확장자 제거, 구분자를 공백으로). */
export function titleFromRel(rel: string): string {
  const base = rel.replace(/\\/g, '/').split('/').pop() ?? rel;
  const noExt = base.replace(/\.[^.]+$/, '');
  return noExt.replace(/[_-]+/g, ' ').trim() || base;
}

/**
 * 두뇌 프롬프트. 지시는 영어로 통일(prompts/*.md 영어 관례) — 본문 언어는 원문을 따르라고 명시한다.
 * 핵심 두 가지: (1) 긴 문서는 주제별로 여러 페이지 (2) 이미 있는 주제면 그 slug를 재사용해 덧붙이기.
 */
export function buildOrganizePrompt(input: OrganizeInput): string {
  const existing = input.existing.length
    ? input.existing
        .map((e) => `- slug: ${e.slug}\n  title: ${e.title}${e.snippet ? `\n  excerpt: ${e.snippet.slice(0, 300)}` : ''}`)
        .join('\n')
    : '(none)';
  const lines = [
    'You are organizing a file that a user dropped into a watched folder so it can be stored in their wiki.',
    '',
    'Rules:',
    '- Split the material by topic. One page per coherent topic; a long document usually becomes 2-5 pages. A short note is a single page.',
    '- If one of the existing wiki pages listed below already covers a topic, reuse that page: set "slug" to that exact existing slug and write ONLY the new material to append (do not restate what the page already says). Never create a near-duplicate page.',
    '- For a genuinely new topic, omit "slug".',
    '- Write the body as clean markdown: a short summary sentence first, then the organized detail. Keep every fact from the source; do not invent anything.',
    '- Write in the same language as the source material.',
    '- "category" is one short lowercase word (e.g. meeting, guide, spec, reference, note).',
    '',
    'Output ONLY a JSON object, no prose and no code fence:',
    '{"pages":[{"slug":"optional-existing-slug","title":"...","category":"...","body":"markdown body"}]}',
    '',
    `# Source file\n${input.rel}${input.truncated ? '\n(NOTE: the text below was truncated at the import size limit)' : ''}`,
    '',
    `# Existing wiki pages on related topics\n${existing}`,
    '',
  ];
  if (input.imageOnly) {
    lines.push('# Content\nThe file is an image, attached to this request. Read what it shows and organize it.');
  } else {
    lines.push(`# Content\n${fence(input.text)}`);
  }
  return lines.join('\n');
}

/** 본문을 펜스로 감싸 프롬프트 구조 오염을 막는다(reader-agent.ts 첨부 처리와 같은 기법). */
function fence(content: string): string {
  const runs = content.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0;
  const f = '`'.repeat(Math.max(3, longest + 1));
  return `${f}\n${content}\n${f}`;
}

/**
 * 두뇌 응답 → 페이지 배열. 코드펜스·앞뒤 잡담을 견딘다. 형태가 아니면 null(호출부가 실패로 기록).
 * 제목/본문이 비어 있는 항목은 버린다(빈 페이지가 위키에 들어가지 않게).
 */
export function parseOrganized(raw: string): OrganizedPage[] | null {
  const text = String(raw ?? '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text].filter((c): c is string => typeof c === 'string');
  for (const c of candidates) {
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(c.slice(start, end + 1));
    } catch {
      continue;
    }
    const pages = (parsed as { pages?: unknown })?.pages;
    if (!Array.isArray(pages)) continue;
    const out: OrganizedPage[] = [];
    for (const p of pages) {
      if (!p || typeof p !== 'object') continue;
      const r = p as Record<string, unknown>;
      const title = typeof r.title === 'string' ? r.title.trim() : '';
      const body = typeof r.body === 'string' ? r.body.trim() : '';
      if (!title || !body) continue;
      out.push({
        slug: typeof r.slug === 'string' && r.slug.trim() ? r.slug.trim() : undefined,
        title,
        category: typeof r.category === 'string' && r.category.trim() ? r.category.trim() : undefined,
        body,
      });
    }
    if (out.length > 0) return out;
  }
  return null;
}

/**
 * 두뇌가 지어낸 slug가 실제 위키에 없으면 "덧붙임"이 아니라 신규다 — 존재하는 slug 집합으로
 * 걸러 잘못된 append를 막는다(없는 slug로 append 제안이 나가면 ProposalApplier가 신규로 강등하는데,
 * 그때 제목·분류가 append 가정으로 비어 있을 수 있다).
 */
export function resolveSlug(page: OrganizedPage, known: Set<string>): { slug: string; op: 'create' | 'append' } {
  if (page.slug && known.has(page.slug)) return { slug: page.slug, op: 'append' };
  return { slug: slugifyTitle(page.title), op: 'create' };
}
