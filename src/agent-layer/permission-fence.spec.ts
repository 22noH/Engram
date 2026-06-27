import { PermissionFence } from './permission-fence';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const persona = (over: any = {}) => ({ name: 'Trend', role: '', brain: 'claude', tools: ['WebSearch', 'Bash'], invocation: ['summon'], prompt: '', ...over });

function tmpFence(cfg: any): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-fence-'));
  const p = path.join(dir, 'permissions.json');
  if (cfg) fs.writeFileSync(p, JSON.stringify(cfg));
  return p;
}

it('persona.tools ∩ allow.tools 만 허용', async () => {
  const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: { Trend: ['WebSearch'] }, writePaths: [], denyPaths: [] } }));
  await fence.load();
  expect(fence.allowedTools(persona() as any)).toEqual(['WebSearch']); // Bash는 허용목록에 없어 탈락
});

it('claude 하네스가 아니면 도구 0', async () => {
  const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: { Trend: ['WebSearch'] }, writePaths: [], denyPaths: [] } }));
  await fence.load();
  expect(fence.allowedTools(persona({ brain: 'gemini' }) as any)).toEqual([]);
});

it('설정 파일 없으면 default-deny(도구 0)', async () => {
  const fence = new PermissionFence(tmpFence(null));
  await fence.load();
  expect(fence.allowedTools(persona() as any)).toEqual([]);
});

it('spawnFlags: denyPaths에 있는 writePath는 --add-dir에서 제외', async () => {
  const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: { Trend: ['WebSearch'] }, writePaths: ['C:/ok', 'C:/danger'], denyPaths: ['C:/danger'] } }));
  await fence.load();
  const flags = fence.spawnFlags(persona({ tools: ['WebSearch'] }) as any);
  expect(flags).toContain('--allowedTools');
  expect(flags).toContain('WebSearch');
  expect(flags).toContain('C:/ok');
  expect(flags).not.toContain('C:/danger');
});

it('spawnFlags: 허용 도구 없으면 빈 배열', async () => {
  const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: {}, writePaths: ['C:/ok'], denyPaths: [] } }));
  await fence.load();
  expect(fence.spawnFlags(persona() as any)).toEqual([]);
});

it('load: 깨진 JSON도 default-deny로 폴백', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-fence-'));
  const p = path.join(dir, 'permissions.json');
  fs.writeFileSync(p, 'not json{{{');
  const fence = new PermissionFence(p);
  await fence.load();
  expect(fence.allowedTools(persona() as any)).toEqual([]);
});

it('assertWritable는 denyPaths 내 타깃을 거부', () => {
  const f = new PermissionFence('x');
  (f as any).cfg = { default: 'deny', allow: { tools: {}, writePaths: ['C:/proj'], denyPaths: ['C:/engram'] } };
  expect(() => f.assertWritable('C:/engram')).toThrow();
  expect(() => f.assertWritable('C:/proj')).not.toThrow();
  expect(() => f.assertWritable('C:/other')).toThrow(); // writePaths 밖
});

it('codingFlags는 allowedTools + add-dir', () => {
  const f = new PermissionFence('x');
  (f as any).cfg = { default: 'deny', allow: { tools: { Dev: ['Bash', 'Edit', 'Write'] }, writePaths: [], denyPaths: [] } };
  const persona = { name: 'Dev', brain: 'claude', tools: ['Bash', 'Edit', 'Write'] } as any;
  const flags = f.codingFlags(persona, ['C:/proj']);
  expect(flags).toEqual(['--allowedTools', 'Bash,Edit,Write', '--add-dir', 'C:/proj']);
});
