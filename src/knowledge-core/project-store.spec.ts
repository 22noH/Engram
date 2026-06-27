import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectStore } from './project-store';

describe('ProjectStore', () => {
  let dir: string;
  let store: ProjectStore;
  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'engram-proj-'));
    store = new ProjectStore(dir);
  });
  afterEach(async () => { await fs.promises.rm(dir, { recursive: true, force: true }); });

  const base = {
    id: 'proj_a', targetPath: 'C:/proj/a', branch: 'engram/x',
    gate: { test: 'npm test', build: 'npm run build', typecheck: 'tsc --noEmit' },
    acceptanceCriteria: ['c1'], writePaths: ['C:/proj/a'], concurrency: 1,
    budget: { tokens: null }, approved: false,
  };

  it('create→get 왕복', async () => {
    await store.create(base);
    expect(await store.get('proj_a')).toMatchObject({ id: 'proj_a', approved: false });
  });
  it('update는 부분 패치', async () => {
    await store.create(base);
    await store.update('proj_a', { approved: true });
    expect((await store.get('proj_a'))!.approved).toBe(true);
  });
  it('없는 id는 null', async () => { expect(await store.get('nope')).toBeNull(); });
  it('remove 후 없음', async () => {
    await store.create(base); await store.remove('proj_a');
    expect(await store.get('proj_a')).toBeNull();
  });
});
