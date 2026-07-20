import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildPreset, readPresetFile, writePresetFile } from './preset-file';
import { saveAuthSettings } from '../edge/auth/auth.config';

describe('preset-file', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-file-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  describe('readPresetFile', () => {
    it('파일 없음 → null', () => {
      expect(readPresetFile(dir)).toBeNull();
    });

    it('깨진 JSON → null', () => {
      fs.writeFileSync(path.join(dir, 'preset.json'), '{bad');
      expect(readPresetFile(dir)).toBeNull();
    });

    it('endpoint 없음 → null', () => {
      fs.writeFileSync(path.join(dir, 'preset.json'), JSON.stringify({ name: 'X' }));
      expect(readPresetFile(dir)).toBeNull();
    });

    it('name 없으면 기본값 Server', () => {
      fs.writeFileSync(path.join(dir, 'preset.json'), JSON.stringify({ endpoint: 'ws://1.2.3.4:47800' }));
      expect(readPresetFile(dir)).toEqual({ name: 'Server', endpoint: 'ws://1.2.3.4:47800' });
    });

    it('정상 파일 → 그대로', () => {
      fs.writeFileSync(path.join(dir, 'preset.json'), JSON.stringify({ name: 'Team', endpoint: 'ws://host:1234' }));
      expect(readPresetFile(dir)).toEqual({ name: 'Team', endpoint: 'ws://host:1234' });
    });
  });

  describe('writePresetFile', () => {
    it('쓰고 readPresetFile로 왕복', () => {
      writePresetFile(dir, { name: 'Team', endpoint: 'ws://host:1234' });
      expect(readPresetFile(dir)).toEqual({ name: 'Team', endpoint: 'ws://host:1234' });
    });

    it('configDir이 없으면 생성', () => {
      const nested = path.join(dir, 'nested', 'config');
      writePresetFile(nested, { name: 'X', endpoint: 'ws://a:1' });
      expect(fs.existsSync(path.join(nested, 'preset.json'))).toBe(true);
    });
  });

  describe('buildPreset', () => {
    it('serverName 없으면 기본 Engram Server, bind=127.0.0.1은 그대로 host', () => {
      expect(buildPreset(dir, { bind: '127.0.0.1', port: 47800 })).toEqual({
        name: 'Engram Server', endpoint: 'ws://127.0.0.1:47800',
      });
    });

    it('auth.json의 serverName을 이름으로 사용', () => {
      saveAuthSettings(dir, { serverName: 'My Team' });
      expect(buildPreset(dir, { bind: '127.0.0.1', port: 47800 }).name).toBe('My Team');
    });

    it('bind=0.0.0.0 + hostHint 있으면 hostHint를 host로', () => {
      const p = buildPreset(dir, { bind: '0.0.0.0', port: 5000, hostHint: '192.168.0.10' });
      expect(p.endpoint).toBe('ws://192.168.0.10:5000');
    });

    it('bind=0.0.0.0 + hostHint 없으면 플레이스홀더', () => {
      const p = buildPreset(dir, { bind: '0.0.0.0', port: 5000 });
      expect(p.endpoint).toBe('ws://YOUR-SERVER-IP:5000');
    });
  });
});
