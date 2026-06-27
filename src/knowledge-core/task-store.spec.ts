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
