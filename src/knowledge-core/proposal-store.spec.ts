import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ProposalStore } from './proposal-store';
import { PathResolver } from '../pal/path-resolver';

const sample = (slug: string) => ({
  userId: 'default', op: 'create' as const, targetSlug: slug, title: 'T', category: 'general',
  payload: 'body', sources: ['conv:2026-06-26T01:00'], importance: 4,
  verdict: { confidence: 0.9, reason: 'ok' },
});

describe('ProposalStore', () => {
  let dir: string; let store: ProposalStore;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-prop-')); store = new ProposalStore(new PathResolver(dir)); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('enqueue는 id·createdTs·pending을 부여한다', async () => {
    const p = await store.enqueue(sample('alpha'));
    expect(p.id).toBeTruthy();
    expect(p.status).toBe('pending');
    expect((await store.get(p.id))?.targetSlug).toBe('alpha');
  });
  it('listPending은 pending만 createdTs순으로 반환한다', async () => {
    const a = await store.enqueue(sample('a'));
    await store.enqueue(sample('b'));
    await store.markRejected(a.id);
    const pend = await store.listPending();
    expect(pend.map((x) => x.targetSlug)).toEqual(['b']);
  });
  it('markApproved는 상태를 전이한다', async () => {
    const p = await store.enqueue(sample('c'));
    await store.markApproved(p.id);
    expect((await store.get(p.id))?.status).toBe('approved');
    expect(await store.listPending()).toHaveLength(0);
  });
});
