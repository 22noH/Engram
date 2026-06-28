import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { isStale, readHeartbeat } from './watchdog-core';

describe('watchdog-core', () => {
  it('heartbeat 없으면 null', () => {
    expect(readHeartbeat(path.join(os.tmpdir(), 'no-hb-xyz'))).toBeNull();
  });

  it('heartbeat 값을 숫자로 읽는다', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wd-')), 'hb');
    fs.writeFileSync(f, '1700000000000');
    expect(readHeartbeat(f)).toBe(1700000000000);
  });

  it('lastBeat이 staleMs보다 오래되면 stale', () => {
    expect(isStale(1000_000, 800_000, 180_000)).toBe(true);   // 200s 경과 > 180s
    expect(isStale(1000_000, 900_000, 180_000)).toBe(false);  // 100s 경과 < 180s
  });

  it('lastBeat null(아직 없음)은 stale 아님(부팅 유예)', () => {
    expect(isStale(1000_000, null, 180_000)).toBe(false);
  });
});
