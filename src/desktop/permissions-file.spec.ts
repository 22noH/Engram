import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCommandMode, setCommandMode, getPermissionDetails, setPermissionList } from './permissions-file';

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

describe('getPermissionDetails / setPermissionList', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-perm-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const file = () => path.join(tmp, 'permissions.json');
  const read = () => JSON.parse(fs.readFileSync(file(), 'utf8'));

  it('읽기: 미지정 commands는 null, 배열은 그대로', () => {
    expect(getPermissionDetails(tmp)).toEqual({ writePaths: [], denyPaths: [], commands: null });
    fs.writeFileSync(file(), JSON.stringify({ default: 'deny', allow: { tools: {}, writePaths: ['C:\\a'], denyPaths: [], commands: [] } }));
    expect(getPermissionDetails(tmp)).toEqual({ writePaths: ['C:\\a'], denyPaths: [], commands: [] });
  });
  it('쓰기: 부분 갱신(다른 필드·commandMode 보존), 골격 없으면 생성', () => {
    fs.writeFileSync(file(), JSON.stringify({ default: 'deny', allow: { tools: { dev: ['Bash'] }, writePaths: [], denyPaths: [], commandMode: 'allowlist' } }));
    setPermissionList(tmp, 'writePaths', ['C:\\src']);
    const cfg = read();
    expect(cfg.allow.writePaths).toEqual(['C:\\src']);
    expect(cfg.allow.tools).toEqual({ dev: ['Bash'] });
    expect(cfg.allow.commandMode).toBe('allowlist');
  });
  it('commands: 배열 설정·null이면 필드 삭제(내장 기본 복귀)', () => {
    setPermissionList(tmp, 'commands', ['npm', 'git']);
    expect(read().allow.commands).toEqual(['npm', 'git']);
    setPermissionList(tmp, 'commands', null);
    expect('commands' in read().allow).toBe(false);
  });
  it('깨진 파일이면 골격 재작성(setCommandMode와 동일 결)', () => {
    fs.writeFileSync(file(), '{깨진');
    setPermissionList(tmp, 'denyPaths', ['C:\\Windows']);
    expect(read().allow.denyPaths).toEqual(['C:\\Windows']);
  });
});
