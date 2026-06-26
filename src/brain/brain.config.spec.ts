import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { loadActiveBrain } from './brain.config';

describe('loadActiveBrain', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cfg-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('파일이 없으면 기본 brains.json을 만들고 default 프로필을 반환한다', () => {
    const p = loadActiveBrain(dir, {});
    expect(p.provider).toBe('claude-cli');
    expect(p.cli).toBe('claude');
    expect(p.concurrency).toBe(2);
    expect(fs.existsSync(path.join(dir, 'brains.json'))).toBe(true);
  });

  it('파일의 default 프로필을 읽는다', () => {
    fs.writeFileSync(
      path.join(dir, 'brains.json'),
      JSON.stringify({ default: 'c', brains: { c: { provider: 'claude-cli', cli: 'claude', model: 'opus', concurrency: 5, timeoutMs: 9000, extraArgs: [] } } }),
    );
    const p = loadActiveBrain(dir, {});
    expect(p.model).toBe('opus');
    expect(p.concurrency).toBe(5);
  });

  it('env가 활성 프로필을 덮어쓴다', () => {
    const p = loadActiveBrain(dir, { ENGRAM_BRAIN_MODEL: 'haiku', ENGRAM_BRAIN_CONCURRENCY: '1' });
    expect(p.model).toBe('haiku');
    expect(p.concurrency).toBe(1);
  });

  it('default가 가리키는 프로필이 없으면 throw', () => {
    fs.writeFileSync(path.join(dir, 'brains.json'), JSON.stringify({ default: 'x', brains: {} }));
    expect(() => loadActiveBrain(dir, {})).toThrow(/default/);
  });

  it('claude-cli가 아닌 provider는 거부한다', () => {
    fs.writeFileSync(
      path.join(dir, 'brains.json'),
      JSON.stringify({ default: 'g', brains: { g: { provider: 'gemini-api' } } }),
    );
    expect(() => loadActiveBrain(dir, {})).toThrow(/provider/);
  });
});
