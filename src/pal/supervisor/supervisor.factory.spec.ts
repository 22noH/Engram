import { createSupervisor, buildServiceSpecs } from './supervisor.factory';

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

  it('buildServiceSpecs는 상주+watchdog 두 스펙을 만든다', () => {
    const specs = buildServiceSpecs('/repo', '/data');
    expect(specs.map((s) => s.name)).toEqual(['Engram', 'EngramWatchdog']);
    expect(specs[0].scriptPath.replace(/\\/g, '/')).toBe('/repo/dist/src/main.js');
    expect(specs[1].scriptPath.replace(/\\/g, '/')).toBe('/repo/dist/src/watchdog.js');
    expect(specs.every((s) => s.dataDir === '/data')).toBe(true);
  });
});
