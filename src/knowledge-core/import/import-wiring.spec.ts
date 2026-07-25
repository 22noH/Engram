import { ImportWiringDeps, makeImporterPorts } from './import-wiring';
import { SubmitPage } from './folder-importer';

function deps(over: Partial<ImportWiringDeps> = {}): ImportWiringDeps {
  return {
    brain: { complete: async () => ({ text: 'ok', isError: false }) },
    wiki: {
      getPage: async () => null,
      createPage: async () => undefined,
      updatePage: async () => undefined,
      search: async () => [],
    },
    proposals: { enqueue: async () => ({ id: 'p1' }) },
    userId: 'default',
    extract: { readFile: async () => new Uint8Array() },
    log: () => undefined,
    ...over,
  };
}

const page = (over: Partial<SubmitPage> = {}): SubmitPage => ({
  slug: 's', op: 'create', title: 'T', category: 'note', body: 'B', sources: ['file:a.md'], ...over,
});

describe('import-wiring — 두뇌 호출', () => {
  it('이미지가 있으면 vision 옵션으로 넘긴다(reader-agent와 동일 계약)', async () => {
    let opts: unknown;
    const p = makeImporterPorts(deps({
      brain: { complete: async (_p, _c, o) => { opts = o; return { text: 'x', isError: false }; } },
    }));
    await p.organize('prompt', [{ mime: 'image/png', dataBase64: 'AAA' }]);
    expect(opts).toEqual({ images: [{ mime: 'image/png', dataBase64: 'AAA' }] });
  });

  it('첨부가 없으면 옵션 자체를 안 붙인다(회귀 0)', async () => {
    let opts: unknown = 'untouched';
    const p = makeImporterPorts(deps({
      brain: { complete: async (_p, _c, o) => { opts = o; return { text: 'x', isError: false }; } },
    }));
    await p.organize('prompt');
    expect(opts).toBeUndefined();
  });

  it('두뇌 오류·예외를 never-throw 규약으로 바꾼다', async () => {
    const err = makeImporterPorts(deps({ brain: { complete: async () => ({ text: '한도 초과', isError: true }) } }));
    expect(await err.organize('p')).toEqual({ error: '한도 초과' });
    const boom = makeImporterPorts(deps({ brain: { complete: async () => { throw new Error('네트워크'); } } }));
    expect(await boom.organize('p')).toMatchObject({ error: expect.stringContaining('네트워크') });
  });
});

describe('import-wiring — 관련 문서 검색', () => {
  it('RAG 결과를 slug/제목/발췌로 옮긴다', async () => {
    const p = makeImporterPorts(deps({
      wiki: { ...deps().wiki, search: async () => [{ slug: 'a', title: 'A', text: '본문 조각' }] },
    }));
    expect(await p.findRelated('q')).toEqual([{ slug: 'a', title: 'A', snippet: '본문 조각' }]);
  });

  it('pageExists는 실제 페이지 존재를 본다', async () => {
    const p = makeImporterPorts(deps({
      wiki: { ...deps().wiki, getPage: async (s) => (s === 'real' ? { slug: 'real', body: '', frontmatter: { sources: [] } } : null) },
    }));
    expect(await p.pageExists('real')).toBe(true);
    expect(await p.pageExists('ghost')).toBe(false);
  });
});

describe('import-wiring — 승인함/바로 게시', () => {
  it('제안은 op·출처를 그대로 실어 승인함에 넣는다', async () => {
    let sent: Record<string, unknown> | undefined;
    const p = makeImporterPorts(deps({
      proposals: { enqueue: async (x) => { sent = x as unknown as Record<string, unknown>; return { id: 'p9' }; } },
    }));
    expect(await p.propose(page({ op: 'append', slug: 'existing' }))).toBe('p9');
    expect(sent).toMatchObject({ op: 'append', targetSlug: 'existing', sources: ['file:a.md'], userId: 'default' });
  });

  it('바로 게시: 없는 페이지는 published로 새로 만든다', async () => {
    let created: Record<string, unknown> | undefined;
    const p = makeImporterPorts(deps({
      wiki: { ...deps().wiki, createPage: async (i) => { created = i as unknown as Record<string, unknown>; } },
    }));
    await p.publishNow(page());
    expect(created).toMatchObject({ slug: 's', status: 'published', body: 'B' });
  });

  it('바로 게시: 있는 페이지는 통째 교체가 아니라 덧붙이고 출처를 합친다', async () => {
    let patch: Record<string, unknown> | undefined;
    const p = makeImporterPorts(deps({
      wiki: {
        ...deps().wiki,
        getPage: async () => ({ slug: 's', body: '기존 본문', frontmatter: { sources: ['file:old.md'] } }),
        updatePage: async (_s, x) => { patch = x as unknown as Record<string, unknown>; },
      },
    }));
    await p.publishNow(page());
    expect(patch).toEqual({ body: '기존 본문\n\nB', sources: ['file:old.md', 'file:a.md'] });
  });
});
