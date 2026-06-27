import { PersonaRegistry } from './persona-registry';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function tmpPersonas(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-persona-'));
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
  return dir;
}

it('frontmatter를 파싱하고 name으로 조회한다', async () => {
  const dir = tmpPersonas({
    'trend.md': '---\nname: Trend\nrole: 시장 분석\nbrain: claude\ntools: [WebSearch]\n---\n시장을 본다',
  });
  const reg = new PersonaRegistry(dir);
  await reg.load();
  const p = reg.get('Trend');
  expect(p?.role).toBe('시장 분석');
  expect(p?.tools).toEqual(['WebSearch']);
  expect(p?.prompt.trim()).toBe('시장을 본다');
  expect(reg.get('Trend')?.invocation).toEqual(['summon']); // 기본값
});

it('name 없는 파일은 스킵', async () => {
  const dir = tmpPersonas({ 'bad.md': '---\nrole: x\n---\nbody' });
  const reg = new PersonaRegistry(dir);
  await reg.load();
  expect(reg.all()).toHaveLength(0);
});
