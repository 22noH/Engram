import { makeMcpProposals } from './mcp-proposals';
import { DEFAULT_USER } from '../../pal/path-resolver';

const proposal = (over: Partial<any> = {}): any => ({
  id: 'id1', userId: DEFAULT_USER, createdTs: 't', op: 'create', targetSlug: 'alpha',
  title: 'Title', category: 'general', payload: 'x'.repeat(300), sources: [], importance: 3,
  verdict: { confidence: 1, reason: 'r' }, status: 'pending',
  ...over,
});

function fakeApplier(overrides: Partial<any> = {}): any {
  return { apply: jest.fn().mockResolvedValue(undefined), reject: jest.fn().mockResolvedValue(undefined), ...overrides };
}

describe('makeMcpProposals', () => {
  it('list: pending만 반환, preview는 payload 앞 200자', async () => {
    const p = proposal();
    const store = { listPending: jest.fn().mockResolvedValue([p]) } as any;
    const deps = makeMcpProposals(store, fakeApplier());
    const out = await deps.list();
    expect(store.listPending).toHaveBeenCalledWith(DEFAULT_USER);
    expect(out).toEqual([{ id: 'id1', title: 'Title', op: 'create', targetSlug: 'alpha', preview: p.payload.slice(0, 200) }]);
    expect(out[0].preview.length).toBe(200);
  });

  it('approve: 성공 시 applier.apply 호출 + onChanged 호출 + 요약에 targetSlug 포함', async () => {
    const p = proposal();
    const store = { get: jest.fn().mockResolvedValue(p) } as any;
    const applier = fakeApplier();
    const onChanged = jest.fn();
    const deps = makeMcpProposals(store, applier, { onChanged });
    const summary = await deps.approve('id1');
    expect(applier.apply).toHaveBeenCalledWith(p);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(summary).toContain('alpha');
  });

  it('approve: 없는 id → throw(사유 포함)', async () => {
    const store = { get: jest.fn().mockResolvedValue(null) } as any;
    const deps = makeMcpProposals(store, fakeApplier());
    await expect(deps.approve('nope')).rejects.toThrow(/not found/i);
  });

  it('approve: 이미 approved인 id → throw(사유 포함)', async () => {
    const p = proposal({ status: 'approved' });
    const store = { get: jest.fn().mockResolvedValue(p) } as any;
    const deps = makeMcpProposals(store, fakeApplier());
    await expect(deps.approve('id1')).rejects.toThrow(/pending/i);
  });

  it('★동시 approve 두 번(같은 id) → 한 번만 apply, 두 번째는 in-flight로 즉시 거부', async () => {
    const p = proposal();
    const store = { get: jest.fn().mockResolvedValue(p) } as any;
    let resolveApply: () => void;
    const applyPromise = new Promise<void>((res) => { resolveApply = res; });
    const applier = fakeApplier({ apply: jest.fn().mockImplementation(() => applyPromise) });
    const deps = makeMcpProposals(store, applier);

    const first = deps.approve('id1');
    // 첫 approve가 store.get까지 진행하도록 한 틱 양보
    await Promise.resolve();
    await Promise.resolve();
    const second = deps.approve('id1');
    await expect(second).rejects.toThrow(/in flight|already being approved/i);

    resolveApply!();
    await expect(first).resolves.toContain('alpha');
    expect(applier.apply).toHaveBeenCalledTimes(1);
  });

  it('외부 approving Set 전달 시 그 Set 사용 — 사전에 add해두면 즉시 거부', async () => {
    const p = proposal();
    const store = { get: jest.fn().mockResolvedValue(p) } as any;
    const applier = fakeApplier();
    const approving = new Set<string>(['id1']);
    const deps = makeMcpProposals(store, applier, { approving });
    await expect(deps.approve('id1')).rejects.toThrow(/in flight|already being approved/i);
    expect(applier.apply).not.toHaveBeenCalled();
  });

  it('reject: 성공 시 applier.reject 호출 + onChanged 호출 + 요약에 targetSlug 포함', async () => {
    const p = proposal();
    const store = { get: jest.fn().mockResolvedValue(p) } as any;
    const applier = fakeApplier();
    const onChanged = jest.fn();
    const deps = makeMcpProposals(store, applier, { onChanged });
    const summary = await deps.reject('id1');
    expect(applier.reject).toHaveBeenCalledWith(p);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(summary).toContain('alpha');
  });

  it('reject: 없는 id → throw(사유 포함)', async () => {
    const store = { get: jest.fn().mockResolvedValue(null) } as any;
    const deps = makeMcpProposals(store, fakeApplier());
    await expect(deps.reject('nope')).rejects.toThrow(/not found/i);
  });

  it('reject: 이미 rejected인 id → throw(사유 포함)', async () => {
    const p = proposal({ status: 'rejected' });
    const store = { get: jest.fn().mockResolvedValue(p) } as any;
    const deps = makeMcpProposals(store, fakeApplier());
    await expect(deps.reject('id1')).rejects.toThrow(/pending/i);
  });
});
