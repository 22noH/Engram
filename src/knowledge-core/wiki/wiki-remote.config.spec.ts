import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadWikiRemote } from './wiki-remote.config';

describe('loadWikiRemote', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-wr-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('미설정(파일 없음) → null', () => {
    expect(loadWikiRemote(dir, {})).toBeNull();
  });

  it('remote 빈 값 → null', () => {
    fs.writeFileSync(path.join(dir, 'wiki-remote.json'), JSON.stringify({ remote: '  ' }));
    expect(loadWikiRemote(dir, {})).toBeNull();
  });

  it('remote 설정 → 기본 branch main·interval 60', () => {
    fs.writeFileSync(path.join(dir, 'wiki-remote.json'), JSON.stringify({ remote: 'file:///tmp/r.git' }));
    expect(loadWikiRemote(dir, {})).toEqual({ remote: 'file:///tmp/r.git', branch: 'main', syncIntervalSec: 60 });
  });

  it('branch·interval 오버라이드; env ENGRAM_WIKI_REMOTE가 파일보다 우선', () => {
    fs.writeFileSync(path.join(dir, 'wiki-remote.json'), JSON.stringify({ remote: 'file:///a.git', branch: 'trunk', syncIntervalSec: 30 }));
    expect(loadWikiRemote(dir, { ENGRAM_WIKI_REMOTE: 'file:///b.git' })).toEqual({ remote: 'file:///b.git', branch: 'trunk', syncIntervalSec: 30 });
  });

  it('비양수 interval → 60', () => {
    fs.writeFileSync(path.join(dir, 'wiki-remote.json'), JSON.stringify({ remote: 'file:///a.git', syncIntervalSec: 0 }));
    expect(loadWikiRemote(dir, {})!.syncIntervalSec).toBe(60);
  });
});
