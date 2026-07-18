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

  describe('tick (주기 발화 — ENGRAM_RESIDENT 게이트)', () => {
    const ORIGINAL = process.env.ENGRAM_RESIDENT;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.ENGRAM_RESIDENT;
      else process.env.ENGRAM_RESIDENT = ORIGINAL;
    });

    it('ENGRAM_RESIDENT 미설정 — tick은 아무 파일도 쓰지 않는다(헤드리스 등 비상주 장수명 프로세스 안전)', () => {
      delete process.env.ENGRAM_RESIDENT;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
      const paths = new PathResolver(dir);
      new HeartbeatEmitter(paths).tick();
      expect(fs.existsSync(paths.getHeartbeatPath())).toBe(false);
      expect(fs.existsSync(paths.getPidPath())).toBe(false);
    });

    it('ENGRAM_RESIDENT=1 — tick이 beat와 동일하게 heartbeat/pid를 쓴다', () => {
      process.env.ENGRAM_RESIDENT = '1';
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
      const paths = new PathResolver(dir);
      new HeartbeatEmitter(paths).tick();
      expect(fs.existsSync(paths.getHeartbeatPath())).toBe(true);
      expect(Number(fs.readFileSync(paths.getPidPath(), 'utf8').trim())).toBe(process.pid);
    });
  });
});
