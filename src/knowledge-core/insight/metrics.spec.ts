import { computeDayMetrics } from './metrics';
import { ConversationRecord } from '../conversation-store';

const rec = (ts: string, q: string, a: string, sources?: string[]): ConversationRecord => ({ ts, question: q, answer: a, sources });

describe('computeDayMetrics', () => {
  it('빈 입력은 0 메트릭', () => {
    const m = computeDayMetrics('2026-06-28', []);
    expect(m.queryCount).toBe(0);
    expect(m.hourHistogram).toHaveLength(24);
    expect(m.hourHistogram.every((h) => h === 0)).toBe(true);
    expect(m.topTerms).toEqual([]);
    expect(m.topPages).toEqual([]);
  });

  it('카운트·시간대·평균길이·용어/페이지 빈도를 집계', () => {
    const m = computeDayMetrics('2026-06-28', [
      rec('2026-06-28T01:00:00.000Z', 'docker 배포 docker', 'aaaa', ['guide', 'deploy']),
      rec('2026-06-28T01:30:00.000Z', 'docker 환경변수', 'bb', ['guide']),
    ]);
    expect(m.queryCount).toBe(2);
    expect(m.hourHistogram[1]).toBe(2);          // 01시 UTC 2건
    expect(m.avgAnswerLen).toBe(3);              // (4+2)/2
    expect(m.topTerms[0]).toEqual({ term: 'docker', count: 3 }); // 빈도 최상
    expect(m.topPages[0]).toEqual({ slug: 'guide', count: 2 });  // 인용 최다
  });

  it('동점은 키 오름차순으로 안정 정렬(결정적)', () => {
    const m = computeDayMetrics('2026-06-28', [rec('2026-06-28T00:00:00.000Z', 'beta alpha', 'x')]);
    expect(m.topTerms.map((t) => t.term)).toEqual(['alpha', 'beta']);
  });
});
