import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readWikiRemoteFile, saveWikiRemote } from './wiki-remote-file';

describe('wiki-remote-file', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-wr-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('읽기: 없는/깨진 파일 → 기본값(remote 빈·branch main·60)', () => {
    expect(readWikiRemoteFile(tmp)).toEqual({ remote: '', branch: 'main', syncIntervalSec: 60 });
  });
  it('저장→읽기 왕복, interval 비정상은 60', () => {
    saveWikiRemote(tmp, { remote: 'git@nas:wiki.git', branch: 'wiki', syncIntervalSec: 120 });
    expect(readWikiRemoteFile(tmp)).toEqual({ remote: 'git@nas:wiki.git', branch: 'wiki', syncIntervalSec: 120 });
    saveWikiRemote(tmp, { remote: '', branch: '', syncIntervalSec: -1 });
    expect(readWikiRemoteFile(tmp)).toEqual({ remote: '', branch: 'main', syncIntervalSec: 60 });
  });
});
