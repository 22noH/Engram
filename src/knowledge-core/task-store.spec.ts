import { TaskStore } from './task-store';
import { KeyedLock } from './keyed-lock';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function tmpStore(): { store: TaskStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-task-'));
  return { store: new TaskStore(dir, new KeyedLock()), dir };
}

describe('TaskStore create/get', () => {
  it('레코드를 PENDING으로 만들고 다시 읽는다', async () => {
    const { store } = tmpStore();
    const t = await store.create({ kind: 'collaboration', question: 'Q', assignees: ['Brand'] });
    expect(t.status).toBe('PENDING');
    expect(t.id).toMatch(/^task_/);
    expect(t.blackboard).toEqual({});
    const again = await store.get(t.id);
    expect(again?.question).toBe('Q');
  });

  it('없는 id는 null', async () => {
    const { store } = tmpStore();
    expect(await store.get('task_none')).toBeNull();
  });
});

describe('TaskStore FSM/blackboard', () => {
  it('유효 전이는 통과, 무효 전이는 throw', async () => {
    const { store } = tmpStore();
    const t = await store.create({ kind: 'collaboration', question: 'Q', assignees: [] });
    await store.transition(t.id, 'RUNNING');
    const done = await store.transition(t.id, 'SUCCESS');
    expect(done.status).toBe('SUCCESS');
    await expect(store.transition(t.id, 'RUNNING')).rejects.toThrow(); // 완료 후 역행 금지
  });

  it('PENDING에서 RUNNING 건너뛰고 SUCCESS는 금지', async () => {
    const { store } = tmpStore();
    const t = await store.create({ kind: 'collaboration', question: 'Q', assignees: [] });
    await expect(store.transition(t.id, 'SUCCESS')).rejects.toThrow();
  });

  it('동시 contribute 두 건이 둘 다 살아남는다(KeyedLock 직렬화)', async () => {
    const { store } = tmpStore();
    const t = await store.create({ kind: 'collaboration', question: 'Q', assignees: ['A', 'B'] });
    await Promise.all([store.contribute(t.id, 'A', 'aa'), store.contribute(t.id, 'B', 'bb')]);
    const got = await store.get(t.id);
    expect(got?.blackboard).toEqual({ A: 'aa', B: 'bb' });
  });
});

describe('TaskStore 코딩 확장', () => {
  let dir: string; let store: TaskStore;
  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'engram-task-'));
    store = new TaskStore(dir, new KeyedLock());
  });
  afterEach(async () => { await fs.promises.rm(dir, { recursive: true, force: true }); });

  it('createCoding은 coding kind + 빈 티켓 + progress', async () => {
    const r = await store.createCoding({ question: '목표', projectRef: 'proj_a', criteriaTotal: 2 });
    expect(r.kind).toBe('coding');
    expect(r.tickets).toEqual([]);
    expect(r.progress).toEqual({ landed: 0, criteriaMet: 0, criteriaTotal: 2 });
  });

  it('addTickets→updateTicket→recordProgress', async () => {
    const r = await store.createCoding({ question: 'q', projectRef: 'p', criteriaTotal: 1 });
    await store.addTickets(r.id, [{ id: 'tk1', area: 'src/a', instruction: 'do' }]);
    await store.updateTicket(r.id, 'tk1', { status: 'SUCCESS', gate: { pass: true, output: 'ok' } });
    await store.recordProgress(r.id, { landed: 1, criteriaMet: 1 });
    const fresh = await store.get(r.id);
    expect(fresh!.tickets![0]).toMatchObject({ status: 'SUCCESS', gate: { pass: true } });
    expect(fresh!.progress).toEqual({ landed: 1, criteriaMet: 1, criteriaTotal: 1 });
  });

  it('progressKey는 landed:criteriaMet', () => {
    expect(TaskStore.progressKey({ progress: { landed: 2, criteriaMet: 1, criteriaTotal: 3 } } as any)).toBe('2:1');
  });

  it('remove 후 get은 null', async () => {
    const r = await store.createCoding({ question: 'q', projectRef: 'p', criteriaTotal: 0 });
    await store.remove(r.id);
    expect(await store.get(r.id)).toBeNull();
  });

  it('createCoding이 channelId를 저장하고 list가 반환한다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskstore-'));
    const store = new TaskStore(dir, new KeyedLock());
    const rec = await store.createCoding({ question: 'q', projectRef: 'p1', criteriaTotal: 2, channelId: 'chan-1' });
    expect(rec.channelId).toBe('chan-1');
    const all = await store.list();
    expect(all.some((r) => r.id === rec.id && r.channelId === 'chan-1')).toBe(true);
  });

  it('list는 손상 파일을 건너뛴다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskstore-'));
    const store = new TaskStore(dir, new KeyedLock());
    await store.createCoding({ question: 'q', projectRef: 'p1', criteriaTotal: 1 });
    fs.writeFileSync(path.join(dir, 'junk.json'), '{ not json');
    const all = await store.list();
    expect(all.length).toBe(1);
  });
});
