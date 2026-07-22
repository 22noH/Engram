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

  // node-windows는 non-win32에서 require 시점(호출 시점 아님)에 즉시 throw한다 — 예전엔
  // windows-supervisor를 정적 import해서, 리눅스 도커 데몬처럼 win32 분기를 전혀 안 타도
  // supervisor.factory 모듈을 로드하는 순간 죽었다(Task 4 리뷰 Critical). 회귀 방지:
  // non-win32 분기는 './windows-supervisor'(→node-windows)를 절대 require하면 안 된다.
  it('non-win32 플랫폼은 windows-supervisor를 require하지 않는다(지연+분기 로딩 회귀 방지)', () => {
    jest.isolateModules(() => {
      jest.doMock('./windows-supervisor', () => {
        throw new Error('non-win32 경로에서 windows-supervisor가 require됨 — 회귀');
      });
      const { createSupervisor: freshCreateSupervisor } = require('./supervisor.factory');
      for (const p of ['linux', 'darwin'] as NodeJS.Platform[]) {
        expect(() => freshCreateSupervisor(p, spec)).not.toThrow();
      }
    });
  });

  it('win32 플랫폼은 여전히 windows-supervisor를 통해 WindowsSupervisor를 만든다', () => {
    jest.isolateModules(() => {
      const make = jest.fn().mockImplementation(() => ({ install: jest.fn(), status: jest.fn() }));
      jest.doMock('./windows-supervisor', () => ({ WindowsSupervisor: make }));
      const { createSupervisor: freshCreateSupervisor } = require('./supervisor.factory');
      const s = freshCreateSupervisor('win32', spec);
      expect(make).toHaveBeenCalledWith(spec);
      expect(typeof s.install).toBe('function');
    });
  });
});
