import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { HeartbeatEmitter } from './heartbeat';
import { PathResolver } from './path-resolver';

describe('HeartbeatEmitter', () => {
  it('beat은 heartbeat에 최근 시각을, pid 파일에 현재 pid를 쓴다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
    const paths = new PathResolver(dir);
    const before = Date.now();
    new HeartbeatEmitter(paths).beat();
    const beat = Number(fs.readFileSync(paths.getHeartbeatPath(), 'utf8').trim());
    const pid = Number(fs.readFileSync(paths.getPidPath(), 'utf8').trim());
    expect(beat).toBeGreaterThanOrEqual(before);
    expect(pid).toBe(process.pid);
  });
});
