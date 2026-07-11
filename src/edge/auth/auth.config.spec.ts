import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadAuthSettings, saveAuthSettings, OIDC_PRESETS } from './auth.config';

describe('auth.config', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('없으면 빈 설정, save→load 왕복', () => {
    expect(loadAuthSettings(dir)).toEqual({});
    saveAuthSettings(dir, { serverName: 'Team', oidc: { issuer: 'https://idp', clientId: 'c', clientSecret: 's' } });
    expect(loadAuthSettings(dir).serverName).toBe('Team');
    expect(loadAuthSettings(dir).oidc?.issuer).toBe('https://idp');
  });

  it('손상 파일 → 빈 설정 / 프리셋에 google', () => {
    fs.writeFileSync(path.join(dir, 'auth.json'), '{bad');
    expect(loadAuthSettings(dir)).toEqual({});
    expect(OIDC_PRESETS.google).toBe('https://accounts.google.com');
  });
});
