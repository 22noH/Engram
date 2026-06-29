import { MentionTracker } from './mention-tracker';

it('start하면 running으로 status에 노출', () => {
  const tr = new MentionTracker();
  tr.start('th1', { question: '비용 줄여줘', team: ['Manager'] });
  const s = tr.status('th1');
  expect(s).toHaveLength(1);
  expect(s[0].state).toBe('running');
  expect(s[0].team).toEqual(['Manager']);
});

it('finish하면 done/failed로 전이', () => {
  const tr = new MentionTracker();
  const t = tr.start('th1', { question: 'q', team: ['A'] });
  tr.finish('th1', t.id, 'done');
  expect(tr.status('th1')[0].state).toBe('done');
});

it('완료분은 최근 5개만 유지(running은 전부)', () => {
  const tr = new MentionTracker();
  for (let i = 0; i < 7; i++) { const t = tr.start('th1', { question: `q${i}`, team: [] }); tr.finish('th1', t.id, 'done'); }
  const running = tr.start('th1', { question: 'live', team: [] }); // running 1개
  const s = tr.status('th1');
  const done = s.filter((x) => x.state === 'done');
  expect(done).toHaveLength(5);          // 완료분 캡
  expect(s.some((x) => x.id === running.id && x.state === 'running')).toBe(true); // running 보존
});

it('스레드 격리', () => {
  const tr = new MentionTracker();
  tr.start('th1', { question: 'a', team: [] });
  expect(tr.status('th2')).toEqual([]);
});

it('status는 최신순(나중 것이 앞)', () => {
  const tr = new MentionTracker();
  tr.start('th1', { question: 'first', team: [] });
  tr.start('th1', { question: 'second', team: [] });
  expect(tr.status('th1')[0].question).toBe('second');
});
