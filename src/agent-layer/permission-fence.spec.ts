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
