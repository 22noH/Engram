import { PinoLogger } from './logger';
import { PathResolver } from './path-resolver';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

describe('PinoLogger', () => {
  const tmps: string[] = [];
  afterAll(async () => {
    for (const t of tmps) await fs.rm(t, { recursive: true, force: true });
  });

  it('로그를 runtime/logs/engram.log에 JSON으로 기록한다', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-log-'));
    tmps.push(tmp);
    const logger = new PinoLogger(new PathResolver(tmp));
    logger.log('hello-engram', 'TestCtx');
    // sync:true 목적지이므로 log() 반환 시점에 이미 디스크 기록 완료(sleep 불필요).
    const content = await fs.readFile(
      path.join(tmp, 'logs', 'engram.log'),
      'utf8',
    );
    expect(content).toContain('hello-engram');
    expect(content).toContain('TestCtx');
  });

  it('error는 throw 없이 기록된다', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-log-'));
    tmps.push(tmp);
    const logger = new PinoLogger(new PathResolver(tmp));
    expect(() => logger.error('boom', 'stack', 'Ctx')).not.toThrow();
  });
});
