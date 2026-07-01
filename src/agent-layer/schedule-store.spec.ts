import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { ScheduleStore } from './schedule-store';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sched-')); }

it('add가 id·createdAt 부여하고 all에 노출', () => {
  const s = new ScheduleStore(tmp());
  const e = s.add({ channelId: 'c1', cron: '0 9 * * *', task: 'X' });
  expect(e.id).toBeTruthy();
  expect(e.createdAt).toBeTruthy();
  expect(s.all()).toHaveLength(1);
});

it('byChannel이 채널로 필터', () => {
  const s = new ScheduleStore(tmp());
  s.add({ channelId: 'c1', cron: '0 9 * * *', task: 'A' });
  s.add({ channelId: 'c2', cron: '0 9 * * *', task: 'B' });
  expect(s.byChannel('c1').map((e) => e.task)).toEqual(['A']);
});

it('remove가 삭제하고 결과 반환', () => {
  const s = new ScheduleStore(tmp());
  const e = s.add({ channelId: 'c1', cron: '0 9 * * *', task: 'X' });
  expect(s.remove(e.id)).toBe(true);
  expect(s.remove('nope')).toBe(false);
  expect(s.all()).toHaveLength(0);
});

it('영속: add 후 새 인스턴스 load하면 남아있음', () => {
  const dir = tmp();
  new ScheduleStore(dir).add({ channelId: 'c1', cron: '0 9 * * *', task: 'X' });
  const s2 = new ScheduleStore(dir); s2.load();
  expect(s2.all()).toHaveLength(1);
});

it('깨진 파일 → 빈', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'schedules.json'), '{not json');
  const s = new ScheduleStore(dir); s.load();
  expect(s.all()).toEqual([]);
});
