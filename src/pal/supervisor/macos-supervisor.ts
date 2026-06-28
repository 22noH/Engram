import { SupervisorPort, ServiceStatus, ServiceSpec } from './supervisor.port';

export class MacosSupervisor implements SupervisorPort {
  constructor(private readonly spec: ServiceSpec) {}
  async install(): Promise<void> { throw new Error('미구현(Task 8)'); }
  async uninstall(): Promise<void> { throw new Error('미구현'); }
  async start(): Promise<void> { throw new Error('미구현'); }
  async stop(): Promise<void> { throw new Error('미구현'); }
  async status(): Promise<ServiceStatus> { return 'not-installed'; }
}
