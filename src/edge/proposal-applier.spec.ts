import { ProposalApplier } from './proposal-applier';

const baseProp = (op: any, targetSlug: string) => ({
  id: 'id1', userId: 'default', createdTs: 't', op, targetSlug, title: 'T', category: 'general',
  payload: '새 내용', sources: ['conv:1'], importance: 4, verdict: { confidence: 1, reason: 'r' }, status: 'pending',
});

describe('ProposalApplier', () => {
  it('create는 published 페이지를 만든다', async () => {
    const calls: any = {};
    const wiki = { getPage: async () => null, createPage: async (i: any) => { calls.create = i; return {} as any; } } as any;
    const proposals = { markApproved: jest.fn() } as any;
    await new ProposalApplier(wiki, proposals).apply(baseProp('create', 'alpha') as any);
    expect(calls.create.status).toBe('published');
    expect(calls.create.slug).toBe('alpha');
    expect(proposals.markApproved).toHaveBeenCalledWith('id1');
  });
  it('append는 기존 본문에 이어붙인다', async () => {
    const calls: any = {};
    const wiki = {
      getPage: async () => ({ slug: 'alpha', frontmatter: { sources: ['old'] }, body: '기존' }),
      updatePage: async (_s: string, p: any) => { calls.update = p; return {} as any; },
    } as any;
    await new ProposalApplier(wiki, { markApproved: jest.fn() } as any).apply(baseProp('append', 'alpha') as any);
    expect(calls.update.body).toContain('기존');
    expect(calls.update.body).toContain('새 내용');
    expect(calls.update.sources).toEqual(expect.arrayContaining(['old', 'conv:1']));
  });
  it('supersede는 기존 본문을 보존하고 마커+내용을 덧붙인다(덮어쓰기 금지)', async () => {
    const calls: any = {};
    const wiki = {
      getPage: async () => ({ slug: 'alpha', frontmatter: { sources: ['old'] }, body: '기존 본문' }),
      updatePage: async (_s: string, p: any) => { calls.update = p; return {} as any; },
    } as any;
    await new ProposalApplier(wiki, { markApproved: jest.fn() } as any).apply(baseProp('supersede', 'alpha') as any);
    expect(calls.update.body).toContain('기존 본문');        // 기존 보존(덮어쓰기 아님)
    expect(calls.update.body).toContain('superseded');       // 마커 존재
    expect(calls.update.body).toContain('새 내용');          // 새 payload 추가
    expect(calls.update.body.indexOf('기존 본문')).toBeLessThan(calls.update.body.indexOf('새 내용')); // 기존이 앞
  });
  it('append 대상이 없으면 create로 강등한다', async () => {
    const calls: any = {};
    const wiki = { getPage: async () => null, createPage: async (i: any) => { calls.create = i; return {} as any; } } as any;
    await new ProposalApplier(wiki, { markApproved: jest.fn() } as any).apply(baseProp('append', 'missing') as any);
    expect(calls.create.slug).toBe('missing');
    expect(calls.create.status).toBe('published');
  });
  it('reject는 위키를 안 건드리고 markRejected만', async () => {
    const wiki = { createPage: jest.fn(), updatePage: jest.fn() } as any;
    const proposals = { markRejected: jest.fn() } as any;
    await new ProposalApplier(wiki, proposals).reject(baseProp('create', 'a') as any);
    expect(wiki.createPage).not.toHaveBeenCalled();
    expect(proposals.markRejected).toHaveBeenCalledWith('id1');
  });
});
