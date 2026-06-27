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

it('assertWritable는 denyPath 하위 디렉터리도 거부, writePath 하위는 허용', () => {
  const f = new PermissionFence('x');
  (f as any).cfg = { default: 'deny', allow: { tools: {}, writePaths: ['C:/proj'], denyPaths: ['C:/engram'] } };
  expect(() => f.assertWritable('C:/engram/src/main.ts')).toThrow(); // deny 하위
  expect(() => f.assertWritable('C:/proj/sub/a.ts')).not.toThrow();   // write 하위 허용
  expect(() => f.assertWritable('C:/PROJ')).not.toThrow();            // Windows 대소문자 무감지
});

it('codingFlags는 denyPath 하위 writePath를 add-dir에서 제외', () => {
  const f = new PermissionFence('x');
  (f as any).cfg = { default: 'deny', allow: { tools: { Dev: ['Bash'] }, writePaths: [], denyPaths: ['C:/engram'] } };
  const persona = { name: 'Dev', brain: 'claude', tools: ['Bash'] } as any;
  const flags = f.codingFlags(persona, ['C:/engram/plugins', 'C:/proj']);
  expect(flags).toEqual(['--allowedTools', 'Bash', '--add-dir', 'C:/proj']); // engram 하위 제외
});

it('engramRoot 하드 백스톱: 빈 설정이어도 engramRoot 내부 경로는 항상 거부', () => {
  // 설정이 완전히 비어있어도(denyPaths=[]) engramRoot를 넘기면 해당 경로·하위 모두 거부.
  const root = 'C:/engram-repo';
  const f = new PermissionFence('x', root);
  // cfg는 EMPTY() 기본값(denyPaths=[], writePaths=[])
  expect(() => f.assertWritable('C:/engram-repo')).toThrow('Engram 자기 저장소는 수정 불가(자기수정 차단)');
  expect(() => f.assertWritable('C:/engram-repo/src/agent-layer/foo.ts')).toThrow('Engram 자기 저장소는 수정 불가(자기수정 차단)');
  // engramRoot 밖이면 일반 writePaths 검사로 이동(여기선 writePaths도 비어 '밖' 오류)
  expect(() => f.assertWritable('C:/other-proj')).toThrow('writePaths 밖');
});
