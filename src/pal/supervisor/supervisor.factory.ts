import { SupervisorPort, ServiceSpec } from './supervisor.port';
import { WindowsSupervisor } from './windows-supervisor';
import { LinuxSupervisor } from './linux-supervisor';
import { MacosSupervisor } from './macos-supervisor';

// process.platform으로 OS 어댑터 선택(설계 §10.1). OS별로 갈리는 유일한 코드.
export function createSupervisor(platform: NodeJS.Platform, spec: ServiceSpec): SupervisorPort {
  switch (platform) {
    case 'win32': return new WindowsSupervisor(spec);
    case 'linux': return new LinuxSupervisor(spec);
    case 'darwin': return new MacosSupervisor(spec);
    default: throw new Error(`미지원 플랫폼: ${platform} (Windows·Linux·macOS만 지원)`);
  }
}
