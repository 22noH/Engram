import { SpecialistAgent } from './specialist-agent';
import { PersonaRegistry } from './persona-registry';
import { PermissionFence } from './permission-fence';
import { FakeBrain } from '../brain/fake-brain';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';

function reg(): PersonaRegistry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sp-'));
  fs.writeFileSync(path.join(dir, 'brand.md'), '---\nname: Brand\nrole: 마케팅\nbrain: claude\n---\n마케팅 관점으로 본다');
  const r = new PersonaRegistry(dir);
  return r;
}
const fakeRag = { search: async () => [] } as any;
const fakeFence = { allowedTools: () => [], spawnFlags: () => [] } as any;

it('페르소나 프롬프트로 두뇌를 호출해 기여를 반환', async () => {
  const r = reg(); await r.load();
  const brain = new FakeBrain({ text: 'Brand 의견', costUsd: 0, isError: false });
  const sp = new SpecialistAgent(r, fakeFence, () => brain, fakeRag, { warn() {}, error() {} } as any);
  const out = await sp.contribute('Brand', '런칭 전략?', 'default');
  expect(out).toBe('Brand 의견');
});

it('없는 페르소나는 throw', async () => {
  const r = reg(); await r.load();
  const sp = new SpecialistAgent(r, fakeFence, () => new FakeBrain(), fakeRag, { warn() {}, error() {} } as any);
  await expect(sp.contribute('Ghost', 'q', 'default')).rejects.toThrow();
});
