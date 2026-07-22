import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadChatConfig, saveChatBootConfig } from './chat.config';

describe('loadChatConfig', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-chatcfg-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('파일 없으면 기본값이 간다', () => {
    expect(loadChatConfig(dir, {})).toEqual({ enabled: true, port: 47800, bind: '127.0.0.1', role: 'server' });
  });

  it('chat.json 값을 쓴다', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ enabled: false, port: 5000, bind: '0.0.0.0' }));
    expect(loadChatConfig(dir, {})).toEqual({ enabled: false, port: 5000, bind: '0.0.0.0', role: 'server' });
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
    expect(loadChatConfig(dir, {})).toEqual({ enabled: true, port: 47800, bind: '127.0.0.1', role: 'server' });
    fs.writeFileSync(path.join(dir, 'chat.json'), '123');
    expect(loadChatConfig(dir, {}).port).toBe(47800);
  });

  it('role: 기본 server, env/파일 brain, brain은 bind 강제 127.0.0.1', () => {
    expect(loadChatConfig(dir).role).toBe('server');
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ role: 'brain', bind: '0.0.0.0' }));
    const c = loadChatConfig(dir);
    expect(c.role).toBe('brain');
    expect(c.bind).toBe('127.0.0.1'); // brain은 원격 노출 불가
    expect(loadChatConfig(dir, { ENGRAM_CHAT_ROLE: 'brain' } as NodeJS.ProcessEnv).role).toBe('brain');
  });

  it('소수 port는 무시하고 기본값', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ port: 3000.5 }));
    expect(loadChatConfig(dir, {}).port).toBe(47800);
  });

  it('65535 초과 port는 무시하고 기본값', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ port: 99999 }));
    expect(loadChatConfig(dir, {}).port).toBe(47800);
  });
});

describe('saveChatBootConfig', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-chatcfg-save-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('파일 없음 → port/bind만 담긴 새 파일 생성, loadChatConfig 왕복', () => {
    saveChatBootConfig(dir, { port: 5000, bind: '0.0.0.0' });
    expect(loadChatConfig(dir, {})).toEqual({ enabled: true, port: 5000, bind: '0.0.0.0', role: 'server' });
  });

  it('기존 필드(language 등) 보존한 채 port만 부분 갱신', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ port: 1000, bind: '127.0.0.1', language: 'ko' }));
    saveChatBootConfig(dir, { port: 2000 });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'chat.json'), 'utf8'));
    expect(raw).toEqual({ port: 2000, bind: '127.0.0.1', language: 'ko' });
  });

  it('무효 port(범위 밖)는 조용히 무시하고 기존 값 보존', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ port: 1000 }));
    saveChatBootConfig(dir, { port: 99999 });
    expect(loadChatConfig(dir, {}).port).toBe(1000);
  });

  it('bind만 갱신(port 미지정) → port 기존 값 유지', () => {
    saveChatBootConfig(dir, { port: 3333 });
    saveChatBootConfig(dir, { bind: '0.0.0.0' });
    expect(loadChatConfig(dir, {})).toEqual({ enabled: true, port: 3333, bind: '0.0.0.0', role: 'server' });
  });
});

it('loadChatConfig reads optional language field', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ language: 'ko' }));
  expect(loadChatConfig(dir, {} as any).language).toBe('ko');
  expect(loadChatConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg2-')), {} as any).language).toBeUndefined();
});

describe('autoCompact (Task 5: clear-compact)', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-chatcfg-autocompact-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('파일 없으면 autoCompact는 undefined(호출부가 true로 취급 — 기본 켜짐)', () => {
    expect(loadChatConfig(dir, {}).autoCompact).toBeUndefined();
  });

  it('chat.json에 autoCompact:false가 있으면 그대로 읽힌다', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ autoCompact: false }));
    expect(loadChatConfig(dir, {}).autoCompact).toBe(false);
  });

  it('chat.json에 autoCompact:true가 있으면 그대로 읽힌다', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ autoCompact: true }));
    expect(loadChatConfig(dir, {}).autoCompact).toBe(true);
  });

  it('비boolean 값(문자열 등)은 무시하고 undefined', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ autoCompact: 'yes' }));
    expect(loadChatConfig(dir, {}).autoCompact).toBeUndefined();
  });

  it('saveChatBootConfig로 저장 후 loadChatConfig 왕복(false)', () => {
    saveChatBootConfig(dir, { autoCompact: false });
    expect(loadChatConfig(dir, {}).autoCompact).toBe(false);
  });

  it('saveChatBootConfig로 저장 후 loadChatConfig 왕복(true)', () => {
    saveChatBootConfig(dir, { autoCompact: true });
    expect(loadChatConfig(dir, {}).autoCompact).toBe(true);
  });

  it('saveChatBootConfig — autoCompact 미전달이면 기존 값 보존(부분갱신)', () => {
    saveChatBootConfig(dir, { autoCompact: false });
    saveChatBootConfig(dir, { port: 9999 }); // autoCompact 미전달
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'chat.json'), 'utf8'));
    expect(raw.autoCompact).toBe(false);
    expect(raw.port).toBe(9999);
  });

  it('saveChatBootConfig — retention과 함께 부분갱신해도 서로 침범하지 않는다', () => {
    saveChatBootConfig(dir, { retention: { mode: 'count', value: 100 }, autoCompact: false });
    const cfg = loadChatConfig(dir, {});
    expect(cfg.retention).toEqual({ mode: 'count', value: 100 });
    expect(cfg.autoCompact).toBe(false);
  });
});
