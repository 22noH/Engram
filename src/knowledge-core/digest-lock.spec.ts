import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { DigestLock } from './digest-lock';
import { PathResolver } from '../pal/path-resolver';

describe('DigestLock', () => {
  let dir: string;
  let lock: DigestLock;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-lock-'));
    lock = new DigestLock(new PathResolver(dir));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('첫 획득은 성공, 점유 중 재획득은 실패한다', async () => {
    expect(await lock.acquire('default')).toBe(true);
    expect(await lock.acquire('default')).toBe(false); // 이미 점유 중
  });

  it('release 후 다시 획득할 수 있다', async () => {
    await lock.acquire('default');
    await lock.release('default');
    expect(await lock.acquire('default')).toBe(true);
  });

  it('다른 userId는 독립적으로 획득한다', async () => {
    expect(await lock.acquire('a')).toBe(true);
    expect(await lock.acquire('b')).toBe(true);
  });

  it('stale(1시간 초과) 락은 탈취한다', async () => {
    await lock.acquire('default');
    // 락 파일 mtime을 2시간 전으로 되돌려 stale로 만든다
    const lockFile = path.join(dir, 'state', 'digest-default.lock');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(lockFile, old, old);
    expect(await lock.acquire('default')).toBe(true); // stale → 탈취 성공
  });

  it('release는 락이 없어도 throw하지 않는다(멱등)', async () => {
    await expect(lock.release('default')).resolves.toBeUndefined();
  });
});
