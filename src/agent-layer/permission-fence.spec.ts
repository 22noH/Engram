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

it('spawnFlags: denyPath 하위 writePath도 --add-dir에서 제외(완전일치 아님)', async () => {
  const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: { Trend: ['WebSearch'] }, writePaths: ['C:/engram/plugins', 'C:/ok'], denyPaths: ['C:/engram'] } }));
  await fence.load();
  const flags = fence.spawnFlags(persona({ tools: ['WebSearch'] }) as any);
  expect(flags).toContain('C:/ok');
  expect(flags).not.toContain('C:/engram/plugins'); // engram 하위 → codingFlags·assertWritable과 동일하게 제외
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

it('assertWritable는 denyPath 하위 디렉터리도 거부, writePath 하위는 허용', () => {
  const f = new PermissionFence('x');
  (f as any).cfg = { default: 'deny', allow: { tools: {}, writePaths: ['C:/proj'], denyPaths: ['C:/engram'] } };
  expect(() => f.assertWritable('C:/engram/src/main.ts')).toThrow(); // deny 하위
  expect(() => f.assertWritable('C:/proj/sub/a.ts')).not.toThrow();   // write 하위 허용
  expect(() => f.assertWritable('C:/PROJ')).not.toThrow();            // Windows 대소문자 무감지
});

it('engramRoot 하드 백스톱: 빈 설정이어도 engramRoot 내부 경로는 항상 거부', () => {
  // 설정이 완전히 비어있어도(denyPaths=[]) engramRoot를 넘기면 해당 경로·하위 모두 거부.
  const root = 'C:/engram-repo';
  const f = new PermissionFence('x', root);
  // cfg는 EMPTY() 기본값(denyPaths=[], writePaths=[])
  expect(() => f.assertWritable('C:/engram-repo')).toThrow('Engram 자기 저장소는 수정 불가(자기수정 차단)');
  expect(() => f.assertWritable('C:/engram-repo/src/agent-layer/foo.ts')).toThrow('Engram 자기 저장소는 수정 불가(자기수정 차단)');
  // 자동모드: writePaths 비어 있으면 백스톱 밖 경로는 허용(명시 타깃 = 동의).
  expect(() => f.assertWritable('C:/other-proj')).not.toThrow();
});

it('assertWritable: 시스템 폴더는 설정 무관 항상 거부', () => {
  const f = new PermissionFence('x');
  (f as any).cfg = { default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } };
  expect(() => f.assertWritable('C:/Windows/System32')).toThrow('시스템 폴더');
  expect(() => f.assertWritable('C:/Program Files/foo')).toThrow('시스템 폴더');
});

it('assertWritable: writePaths 비어 있으면 자동 허용, 지정되면 엄격 allowlist', () => {
  const auto = new PermissionFence('x', 'C:/engram');
  (auto as any).cfg = { default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } };
  expect(() => auto.assertWritable('C:/Users/User/proj')).not.toThrow(); // 자동: 백스톱 밖 허용
  const strict = new PermissionFence('x');
  (strict as any).cfg = { default: 'deny', allow: { tools: {}, writePaths: ['C:/proj'], denyPaths: [] } };
  expect(() => strict.assertWritable('C:/proj/sub')).not.toThrow();
  expect(() => strict.assertWritable('C:/other')).toThrow('writePaths 밖'); // 지정됐으니 밖 거부
});

it('codingAutoFlags: 표준 toolset + 백스톱 밖 폴더만 add-dir', () => {
  const f = new PermissionFence('x', 'C:/engram');
  (f as any).cfg = { default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } };
  const flags = f.codingAutoFlags(['C:/proj', 'C:/engram/x']);
  expect(flags).toContain('--allowedTools');
  expect(flags.join(',')).toContain('Edit'); // 파일 도구
  expect(flags.join(',')).not.toContain('Bash'); // Bash는 울타리 탈출 위험으로 자동모드 제외
  expect(flags).toContain('--add-dir');
  expect(flags).toContain('C:/proj');
  expect(flags).not.toContain('C:/engram/x'); // 백스톱(자기 repo 하위) 제외
});

it('assertWritable: C:/ProgramData도 시스템 폴더로 거부', () => {
  const f = new PermissionFence('x');
  (f as any).cfg = { default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } };
  expect(() => f.assertWritable('C:/ProgramData/foo')).toThrow('시스템 폴더');
});
