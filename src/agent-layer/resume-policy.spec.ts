import { computeResume } from './resume-policy';

afterEach(() => {
  delete process.env.ENGRAM_RESUME_STUCK_MIN;
  delete process.env.ENGRAM_RESUME_COLLAB_MIN;
  delete process.env.ENGRAM_RESUME_BUDGET_HOUR;
  delete process.env.ENGRAM_LANG;
});

it('STUCK: 60분 뒤 once cron(분 시 일 월 *)', () => {
  const r = computeResume('STUCK', new Date(2026, 6, 2, 13, 32)); // 2026-07-02 13:32
  expect(r.cron).toBe('32 14 2 7 *');
  expect(r.human).toBe('in 60 min (14:32)');
});

it('COLLAB: 30분 뒤 — 자정 넘김이면 일/월 정확히 증가', () => {
  const r = computeResume('COLLAB', new Date(2026, 6, 2, 23, 45));
  expect(r.cron).toBe('15 0 3 7 *');
});

it('BUDGET: 오늘 9시가 지났으면 내일 9시', () => {
  const r = computeResume('BUDGET', new Date(2026, 6, 2, 10, 0));
  expect(r.cron).toBe('0 9 3 7 *');
  expect(r.human).toContain('tomorrow');
});

it('BUDGET: 오늘 9시 전이면 오늘 9시', () => {
  const r = computeResume('BUDGET', new Date(2026, 6, 2, 3, 0));
  expect(r.cron).toBe('0 9 2 7 *');
  expect(r.human).toContain('today');
});

it('ENGRAM_LANG=ko이면 한국어 human 문자열을 돌려준다', () => {
  process.env.ENGRAM_LANG = 'ko';
  try {
    const r = computeResume('STUCK', new Date(2026, 6, 2, 13, 32));
    expect(r.human).toBe('60분 뒤(14:32)');
    const b = computeResume('BUDGET', new Date(2026, 6, 2, 10, 0));
    expect(b.human).toContain('내일');
  } finally {
    delete process.env.ENGRAM_LANG;
  }
});

it('env 오버라이드: ENGRAM_RESUME_STUCK_MIN=5', () => {
  process.env.ENGRAM_RESUME_STUCK_MIN = '5';
  expect(computeResume('STUCK', new Date(2026, 6, 2, 13, 0)).cron).toBe('5 13 2 7 *');
});

it('비숫자/0 이하 env → 기본값 폴백', () => {
  process.env.ENGRAM_RESUME_STUCK_MIN = 'abc';
  expect(computeResume('STUCK', new Date(2026, 6, 2, 13, 0)).cron).toBe('0 14 2 7 *');
  process.env.ENGRAM_RESUME_COLLAB_MIN = '0';
  expect(computeResume('COLLAB', new Date(2026, 6, 2, 13, 0)).cron).toBe('30 13 2 7 *');
});

it('BUDGET 시 env 범위밖(25) → 기본 9시', () => {
  process.env.ENGRAM_RESUME_BUDGET_HOUR = '25';
  expect(computeResume('BUDGET', new Date(2026, 6, 2, 10, 0)).cron).toBe('0 9 3 7 *');
});
