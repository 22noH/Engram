import { MeetingEngine } from './meeting-engine';
import { TaskStore } from '../knowledge-core/task-store';
import { KeyedLock } from '../knowledge-core/keyed-lock';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';

it('회의를 돌려 회의록 페이지와 결정 레코드를 만든다', async () => {
  const tasks = new TaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'engram-mt-')), new KeyedLock());
  const orchestrator = { collaborate: async () => '오늘의 종합 결론' } as any;
  const pages: any[] = [];
  const wiki = { createPage: async (input: any) => { pages.push(input); return input; } } as any;
  const eng = new MeetingEngine(orchestrator, wiki, tasks, { info() {}, warn() {}, error() {} } as any);
  const res = await eng.run({ name: '일일브리핑', schedule: '0 3 * * *', roster: ['Manager', 'Record'], agenda: '점검' }, 'default');
  expect(pages[0].slug).toContain('meeting-일일브리핑');
  expect(pages[0].body).toContain('오늘의 종합 결론');
  const dec = await tasks.get(res.decisionId);
  expect(dec?.kind).toBe('board-decision');
  expect(dec?.result).toBe('오늘의 종합 결론');
});
