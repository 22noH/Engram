import * as path from 'path';
import { SupervisorPort, ServiceSpec } from './supervisor.port';
import type { WindowsSupervisor } from './windows-supervisor';
import { LinuxSupervisor } from './linux-supervisor';
import { MacosSupervisor } from './macos-supervisor';

// 상주(main) + watchdog 두 서비스 스펙. engram service가 둘 다에 verb 적용.
export function buildServiceSpecs(repoRoot: string, dataDir: string): ServiceSpec[] {
  return [
    { name: 'Engram', scriptPath: path.join(repoRoot, 'dist', 'src', 'main.js'), dataDir },
    { name: 'EngramWatchdog', scriptPath: path.join(repoRoot, 'dist', 'src', 'watchdog.js'), dataDir },
  ];
}

// process.platform으로 OS 어댑터 선택(설계 §10.1). OS별로 갈리는 유일한 코드.
export function createSupervisor(platform: NodeJS.Platform, spec: ServiceSpec): SupervisorPort {
  switch (platform) {
    case 'win32': {
      // node-windows는 모듈 최상단에서 process.platform!=='win32'면 즉시 throw한다(호출 시점이
      // 아니라 require 시점) — 정적 import였다면 non-win32 환경(예: 리눅스 도커 데몬)에서 이 파일이
      // 속한 모듈 그래프를 로드하기만 해도 죽는다. win32 분기 안에서만 지연 require해 그 경로를
      // 실제로 타지 않는 한 node-windows를 건드리지 않게 한다. 타입은 import type(컴파일 시 소거)로만.
      const { WindowsSupervisor } = require('./windows-supervisor') as typeof import('./windows-supervisor');
      return new WindowsSupervisor(spec);
    }
    case 'linux': return new LinuxSupervisor(spec);
    case 'darwin': return new MacosSupervisor(spec);
    default: throw new Error(`미지원 플랫폼: ${platform} (Windows·Linux·macOS만 지원)`);
  }
}
