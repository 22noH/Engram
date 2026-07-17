import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCommandMode, setCommandMode } from './permissions-file';

describe('permissions-file commandMode', () => {
  it('파일 없거나 미지정 → auto', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-pf-'));
    try {
      expect(getCommandMode(dir)).toBe('auto');
      fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify({ default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } }));
      expect(getCommandMode(dir)).toBe('auto');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('setCommandMode는 allow.commandMode만 갱신, 나머지 보존', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-pf2-'));
    try {
      fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify({ default: 'deny', allow: { tools: { Dev: ['Edit'] }, writePaths: ['C:/p'], denyPaths: [] } }));
      setCommandMode(dir, 'off');
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'permissions.json'), 'utf8'));
      expect(raw.allow.commandMode).toBe('off');
      expect(raw.allow.tools).toEqual({ Dev: ['Edit'] });     // 보존
      expect(raw.allow.writePaths).toEqual(['C:/p']);          // 보존
      expect(getCommandMode(dir)).toBe('off');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('파일 없을 때 setCommandMode는 골격 생성', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-pf3-'));
    try {
      setCommandMode(dir, 'allowlist');
      expect(getCommandMode(dir)).toBe('allowlist');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
