import { InsightContext } from './insight-context';
import { InsightStore, DayInsight } from './insight-store';

const fakeStore = (latest: DayInsight | null): InsightStore => ({ latest: async () => latest } as unknown as InsightStore);

describe('InsightContext', () => {
  it('인사이트 없으면 빈 문자열', async () => {
    const ctx = new InsightContext(fakeStore(null));
    expect(await ctx.latest('default')).toBe('');
  });

  it('있으면 날짜·리포트·주제를 담은 문자열', async () => {
    const ctx = new InsightContext(fakeStore({
      date: '2026-06-28',
      metrics: { date: '2026-06-28', queryCount: 3, hourHistogram: [], avgQuestionLen: 0, avgAnswerLen: 0, topTerms: [{ term: 'docker', count: 3 }], topPages: [] },
      report: '도커 배포에 집중',
    }));
    const out = await ctx.latest('default');
    expect(out).toContain('2026-06-28');
    expect(out).toContain('도커 배포에 집중');
    expect(out).toContain('docker');
  });
});
