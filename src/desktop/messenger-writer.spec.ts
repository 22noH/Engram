import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { saveDiscordToken } from './messenger-writer';

describe('saveDiscordToken', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-msgr-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('파일이 없으면 만들어서 저장', () => {
    saveDiscordToken(tmp, 'tok-123');
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'messenger.json'), 'utf8'));
    expect(cfg).toEqual({ provider: 'discord', token: 'tok-123' });
  });

  it('기존 키를 보존하며 병합', () => {
    fs.writeFileSync(path.join(tmp, 'messenger.json'), JSON.stringify({ 기타옵션: true }));
    saveDiscordToken(tmp, 'tok-456');
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'messenger.json'), 'utf8'));
    expect(cfg).toEqual({ 기타옵션: true, provider: 'discord', token: 'tok-456' });
  });

  it('깨진 JSON은 새로 쓴다', () => {
    fs.writeFileSync(path.join(tmp, 'messenger.json'), '{깨짐');
    saveDiscordToken(tmp, 'tok-789');
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'messenger.json'), 'utf8'));
    expect(cfg.token).toBe('tok-789');
  });
});
