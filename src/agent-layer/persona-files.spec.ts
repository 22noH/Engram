import { PersonaRegistry } from './persona-registry';
import * as path from 'path';

describe('PersonaFiles', () => {
  it('8팀 페르소나가 모두 로드된다', async () => {
    const reg = new PersonaRegistry(path.join(__dirname, '../../personas'));
    await reg.load();
    const names = reg.all().map((p) => p.name).sort();
    expect(names).toEqual(['Academy', 'Brand', 'Career', 'Infra', 'Manager', 'Recon', 'Record', 'Trend']);
    expect(reg.get('Trend')?.tools).toContain('WebSearch');
    expect(reg.get('Manager')?.board).toBe('chair');
  });
});
