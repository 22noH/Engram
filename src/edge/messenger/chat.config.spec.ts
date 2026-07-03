import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadChatConfig } from './chat.config';

describe('loadChatConfig', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-chatcfg-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('파일 없으면 기본값이 간다', () => {
    expect(loadChatConfig(dir, {})).toEqual({ enabled: true, port: 47800, bind: '127.0.0.1' });
  });

  it('chat.json 값을 쓴다', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ enabled: false, port: 5000, bind: '0.0.0.0' }));
    expect(loadChatConfig(dir, {})).toEqual({ enabled: false, port: 5000, bind: '0.0.0.0' });
  });

  it('env가 파일보다 우선한다', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ port: 5000 }));
    const cfg = loadChatConfig(dir, { ENGRAM_CHAT_PORT: '6000', ENGRAM_CHAT_BIND: '0.0.0.0' });
    expect(cfg.port).toBe(6000);
    expect(cfg.bind).toBe('0.0.0.0');
  });

  it('비유효한 env/파일 port는 기본값으로 돌아간다(NaN 값)', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ port: 'abc' }));
    expect(loadChatConfig(dir, { ENGRAM_CHAT_PORT: 'xyz' }).port).toBe(47800);
    expect(loadChatConfig(dir, { ENGRAM_CHAT_PORT: '-1' }).port).toBe(47800);
  });

  it('깨진 JSON은 기본값', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), '{broken');
    expect(loadChatConfig(dir, {}).enabled).toBe(true);
  });

  it('유효하지만 객체가 아닌 JSON(null 등)도 기본값(크래시 없음)', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), 'null');
    expect(loadChatConfig(dir, {})).toEqual({ enabled: true, port: 47800, bind: '127.0.0.1' });
    fs.writeFileSync(path.join(dir, 'chat.json'), '123');
    expect(loadChatConfig(dir, {}).port).toBe(47800);
  });

  it('소수 port는 무시하고 기본값', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ port: 3000.5 }));
    expect(loadChatConfig(dir, {}).port).toBe(47800);
  });
});
