import { loadMeetings, saveMeetings } from './meeting-config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

it('없으면 빈 배열, 저장 후 다시 읽힌다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-mc-'));
  expect(loadMeetings(dir)).toEqual([]);
  saveMeetings(dir, [{ name: 'd', schedule: '0 3 * * *', roster: ['Manager'], agenda: 'a' }]);
  expect(loadMeetings(dir)[0].name).toBe('d');
});
