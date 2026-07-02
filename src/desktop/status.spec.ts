import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readStatus } from './status';

describe('readStatus', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-status-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeBeat(epochMs: number): void {
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'state', 'heartbeat'), String(epochMs));
  }

  it('최근 박동(3분 이내)이면 alive', () => {
    writeBeat(1_000_000);
    expect(readStatus(tmp, 1_000_000 + 60_000)).toMatchObject({ alive: true, lastBeat: 1_000_000 });
  });

  it('박동이 3분 넘게 오래되면 죽음', () => {
    writeBeat(1_000_000);
    expect(readStatus(tmp, 1_000_000 + 4 * 60_000).alive).toBe(false);
  });

  it('heartbeat 파일이 없으면 죽음 취급(lastBeat null)', () => {
    expect(readStatus(tmp, 1_000_000)).toMatchObject({ alive: false, lastBeat: null });
  });

  it('models 폴더에 내용이 있으면 modelCacheReady', () => {
    fs.mkdirSync(path.join(tmp, 'models', 'Xenova'), { recursive: true });
    expect(readStatus(tmp, 0).modelCacheReady).toBe(true);
  });

  it('models 폴더가 없거나 비면 미준비', () => {
    expect(readStatus(tmp, 0).modelCacheReady).toBe(false);
  });
});
