import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadChatConfig } from '../edge/messenger/chat.config';
import { getChatRetention, setChatRetention } from './chat-retention-file';

describe('getChatRetention', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-chatret-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('새 config dir(파일 없음) → 기본 무제한 + autoCompact true', () => {
    expect(getChatRetention(dir)).toEqual({ retention: { mode: 'unlimited' }, autoCompact: true });
  });

  it('chat.json에 저장된 값을 그대로 읽는다', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ retention: { mode: 'count', value: 500 }, autoCompact: false }));
    expect(getChatRetention(dir)).toEqual({ retention: { mode: 'count', value: 500 }, autoCompact: false });
  });

  it('retention만 저장돼 있으면 autoCompact는 기본 true로 채워진다', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ retention: { mode: 'days', value: 30 } }));
    expect(getChatRetention(dir)).toEqual({ retention: { mode: 'days', value: 30 }, autoCompact: true });
  });
});

describe('setChatRetention', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-chatret-set-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('유효한 retention+autoCompact를 저장하고 loadChatConfig로 왕복 확인', () => {
    setChatRetention(dir, { mode: 'count', value: 1000 }, true);
    const cfg = loadChatConfig(dir, {});
    expect(cfg.retention).toEqual({ mode: 'count', value: 1000 });
    expect(cfg.autoCompact).toBe(true);
  });

  it('days 프리셋도 저장된다', () => {
    setChatRetention(dir, { mode: 'days', value: 90 }, false);
    const cfg = loadChatConfig(dir, {});
    expect(cfg.retention).toEqual({ mode: 'days', value: 90 });
    expect(cfg.autoCompact).toBe(false);
  });

  it('unlimited 프리셋도 저장된다', () => {
    setChatRetention(dir, { mode: 'unlimited' }, true);
    expect(loadChatConfig(dir, {}).retention).toEqual({ mode: 'unlimited' });
  });

  it('무효 retention(잘못된 mode)은 무시되고 기존 값을 보존(파일 없었으면 필드 자체가 안 생김)', () => {
    setChatRetention(dir, { mode: 'bogus' }, true);
    expect(loadChatConfig(dir, {}).retention).toBeUndefined();
    expect(loadChatConfig(dir, {}).autoCompact).toBe(true);
  });

  it('무효 retention(count인데 value<=0)은 무시', () => {
    setChatRetention(dir, { mode: 'count', value: -5 }, true);
    expect(loadChatConfig(dir, {}).retention).toBeUndefined();
  });

  it('무효 retention(count인데 소수 value)은 무시', () => {
    setChatRetention(dir, { mode: 'count', value: 1.5 }, true);
    expect(loadChatConfig(dir, {}).retention).toBeUndefined();
  });

  it('무효 retention이어도 기존 저장된 값은 그대로 보존된다(덮어쓰지 않음)', () => {
    setChatRetention(dir, { mode: 'count', value: 1000 }, true);
    setChatRetention(dir, { mode: 'bogus' }, false);
    const cfg = loadChatConfig(dir, {});
    expect(cfg.retention).toEqual({ mode: 'count', value: 1000 }); // 무효값이 기존 값을 밀어내지 않음
    expect(cfg.autoCompact).toBe(false); // autoCompact는 유효했으니 갱신됨
  });

  it('비boolean autoCompact는 무시되고 기존 값 보존', () => {
    setChatRetention(dir, { mode: 'unlimited' }, 'yes');
    expect(loadChatConfig(dir, {}).autoCompact).toBeUndefined();
  });

  it('retention이 null/undefined/문자열이어도 크래시 없이 무시', () => {
    expect(() => setChatRetention(dir, null, true)).not.toThrow();
    expect(() => setChatRetention(dir, undefined, true)).not.toThrow();
    expect(() => setChatRetention(dir, 'unlimited', true)).not.toThrow();
    expect(loadChatConfig(dir, {}).retention).toBeUndefined();
  });
});
