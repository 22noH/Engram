import { serializePage, parsePage } from './page-serializer';
import { WikiPage } from './page.types';

describe('page-serializer', () => {
  it('직렬화 후 파싱하면 원본과 같다 (왕복)', () => {
    const page: WikiPage = {
      slug: 'test-page',
      frontmatter: {
        title: '테스트',
        category: 'general',
        status: 'draft',
        sources: ['conv:123'],
        created: '2026-06-21T00:00:00.000Z',
        updated: '2026-06-21T00:00:00.000Z',
      },
      body: '본문 내용입니다.',
    };

    const text = serializePage(page);
    const back = parsePage('test-page', text);

    expect(back).toEqual(page);
  });

  it('본문 끝 공백(마크다운 하드 줄바꿈)이 왕복 후 보존된다', () => {
    const page: WikiPage = {
      slug: 'trailing-space',
      frontmatter: {
        title: '공백 테스트',
        category: 'general',
        status: 'draft',
        sources: [],
        created: '2026-06-21T00:00:00.000Z',
        updated: '2026-06-21T00:00:00.000Z',
      },
      body: '줄1\n줄2 뒤 공백  ',
    };

    expect(parsePage(page.slug, serializePage(page))).toEqual(page);
  });

  it('frontmatter가 YAML로 직렬화된다', () => {
    const page: WikiPage = {
      slug: 'p',
      frontmatter: {
        title: 'T', category: 'c', status: 'published',
        sources: [], created: '2026-06-21T00:00:00.000Z',
        updated: '2026-06-21T00:00:00.000Z',
      },
      body: 'hi',
    };
    const text = serializePage(page);
    expect(text).toContain('title: T');
    expect(text).toContain('status: published');
  });
});

// ★2026-07-30 실사고: YAML은 문자열만 주는 게 아니다. 이 정규화가 없으면 부팅 재색인이 죽고
// (crypto가 Date 거부) 그 페이지는 LanceDB에도 못 들어간다(category 열이 non-nullable).
describe('parsePage — YAML이 문자열을 주지 않을 때', () => {
  const fm = (yaml: string) => parsePage('p', `---\n${yaml}\n---\n본문\n`).frontmatter;

  it('날짜로 읽히는 제목은 적은 그대로의 날짜 문자열이 된다', () => {
    expect(fm('title: 2026-07-30')).toMatchObject({ title: '2026-07-30' });
  });

  it('빈 값·없는 키는 빈 문자열(null·undefined가 새어나가지 않는다)', () => {
    const f = fm('title: T\ncategory:');
    expect(f.category).toBe('');
    expect(fm('title: T').category).toBe('');
    expect(typeof fm('title: T').created).toBe('string');
  });

  it('숫자 제목도 문자열', () => {
    expect(fm('title: 2026').title).toBe('2026');
  });

  it('sources는 항상 문자열 배열(한 줄로 적었거나 비어 있어도)', () => {
    expect(fm('title: T\nsources: mcp').sources).toEqual(['mcp']);
    expect(fm('title: T\nsources:').sources).toEqual([]);
    expect(fm('title: T').sources).toEqual([]);
    expect(fm('title: T\nsources:\n  - mcp\n  - 대화').sources).toEqual(['mcp', '대화']);
  });

  it('모르는 키는 보존한다(왕복 유지)', () => {
    expect(fm('title: T\nowner: nobody')).toMatchObject({ owner: 'nobody' });
  });
});
