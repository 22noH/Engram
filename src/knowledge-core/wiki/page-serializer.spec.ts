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
