import { reconcileFrontmatter, unionBodies } from './page-merge';
import { PageFrontmatter } from './page.types';

const fm = (o: Partial<PageFrontmatter>): PageFrontmatter => ({
  title: 'T', category: 'C', status: 'draft', sources: [], created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', ...o,
});

describe('reconcileFrontmatter', () => {
  it('updated=max, created=min', () => {
    const r = reconcileFrontmatter(
      fm({ updated: '2026-01-02T00:00:00Z', created: '2026-01-01T00:00:00Z' }),
      fm({ updated: '2026-01-03T00:00:00Z', created: '2025-12-31T00:00:00Z' }),
    );
    expect(r.updated).toBe('2026-01-03T00:00:00Z');
    expect(r.created).toBe('2025-12-31T00:00:00Z');
  });
  it('sources=합집합 dedup(순서보존)', () => {
    expect(reconcileFrontmatter(fm({ sources: ['a', 'b'] }), fm({ sources: ['b', 'c'] })).sources).toEqual(['a', 'b', 'c']);
  });
  it('status=둘 중 published 우선', () => {
    expect(reconcileFrontmatter(fm({ status: 'draft' }), fm({ status: 'published' })).status).toBe('published');
    expect(reconcileFrontmatter(fm({ status: 'draft' }), fm({ status: 'draft' })).status).toBe('draft');
  });
  it('title/category=updated 최신 쪽', () => {
    const r = reconcileFrontmatter(
      fm({ title: 'Old', category: 'OldC', updated: '2026-01-01T00:00:00Z' }),
      fm({ title: 'New', category: 'NewC', updated: '2026-01-02T00:00:00Z' }),
    );
    expect(r.title).toBe('New');
    expect(r.category).toBe('NewC');
  });
});

describe('unionBodies', () => {
  it('다르면 둘 다 보존', () => {
    const u = unionBodies('AAA', 'BBB');
    expect(u).toContain('AAA');
    expect(u).toContain('BBB');
  });
  it('같으면 하나', () => {
    expect(unionBodies('same', 'same')).toBe('same');
  });
});
