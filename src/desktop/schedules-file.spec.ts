import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listSchedules, removeScheduleFromFile } from './schedules-file';

describe('schedules-file', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const seed = () => fs.writeFileSync(path.join(tmp, 'schedules.json'), JSON.stringify([
    { id: 's1', channelId: 'ch1', cron: '0 9 * * 1-5', task: '브리핑', createdAt: 't' },
    { id: 's2', channelId: 'ch2', cron: '0 18 * * 5', task: '회고', once: true, createdAt: 't' },
  ]));

  it('listSchedules: 배열 반환, 없는/깨진 파일 []', () => {
    expect(listSchedules(tmp)).toEqual([]);
    seed();
    expect(listSchedules(tmp).map((e) => e.id)).toEqual(['s1', 's2']);
    fs.writeFileSync(path.join(tmp, 'schedules.json'), '{깨진');
    expect(listSchedules(tmp)).toEqual([]);
  });
  it('removeScheduleFromFile: 삭제 true·없으면 false(무변경)', () => {
    seed();
    expect(removeScheduleFromFile(tmp, 's1')).toBe(true);
    expect(listSchedules(tmp).map((e) => e.id)).toEqual(['s2']);
    expect(removeScheduleFromFile(tmp, 'ghost')).toBe(false);
  });
});
