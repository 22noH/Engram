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
