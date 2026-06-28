import { createSupervisor } from './supervisor.factory';

const spec = { name: 'Engram', scriptPath: '/app/main.js', dataDir: '/data' };

describe('createSupervisor', () => {
  it('지원 플랫폼은 SupervisorPort를 반환', () => {
    for (const p of ['win32', 'linux', 'darwin'] as NodeJS.Platform[]) {
      const s = createSupervisor(p, spec);
      expect(typeof s.install).toBe('function');
      expect(typeof s.status).toBe('function');
    }
  });

  it('미지원 플랫폼은 명확히 throw', () => {
    expect(() => createSupervisor('aix' as NodeJS.Platform, spec)).toThrow(/미지원/);
  });
});
