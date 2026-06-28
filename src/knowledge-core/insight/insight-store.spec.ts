import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { InsightStore, DayInsight } from './insight-store';
import { PathResolver } from '../../pal/path-resolver';

const insight = (date: string): DayInsight => ({
  date,
  metrics: { date, queryCount: 1, hourHistogram: new Array(24).fill(0), avgQuestionLen: 1, avgAnswerLen: 1, topTerms: [], topPages: [] },
  report: `report-${date}`,
});

describe('InsightStore', () => {
  let dir: string; let store: InsightStore;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'insight-'));
    store = new InsightStore(new PathResolver(dir));
  });

  it('save→latest 라운드트립, 최신 날짜 반환', async () => {
    await store.save('default', insight('2026-06-27'));
    await store.save('default', insight('2026-06-28'));
    const latest = await store.latest('default');
    expect(latest?.date).toBe('2026-06-28');
    expect(latest?.report).toBe('report-2026-06-28');
  });

  it('없으면 latest는 null', async () => {
    expect(await store.latest('default')).toBeNull();
  });

  it('get은 특정 날짜를 반환', async () => {
    await store.save('default', insight('2026-06-28'));
    expect((await store.get('default', '2026-06-28'))?.report).toBe('report-2026-06-28');
    expect(await store.get('default', '2026-06-01')).toBeNull();
  });
});
