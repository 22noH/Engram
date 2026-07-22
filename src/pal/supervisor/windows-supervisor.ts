import { Service } from 'node-windows';
import { SupervisorPort, ServiceStatus, ServiceSpec } from './supervisor.port';

type ServiceFactory = (opts: ConstructorParameters<typeof Service>[0]) => Service;

// Windows 서비스 어댑터(spec B2). node-windows로 SCM 등록 — 부팅 자동시작·죽으면 재시작·백오프는 SCM이 네이티브 제공.
export class WindowsSupervisor implements SupervisorPort {
  private readonly make: ServiceFactory;
  constructor(private readonly spec: ServiceSpec, make?: ServiceFactory) {
    this.make = make ?? ((o) => new Service(o));
  }

  private build(): Service {
    return this.make({
      name: this.spec.name,
      description: 'Engram 24/7 상주 지식 코어',
      script: this.spec.scriptPath,
      env: [{ name: 'ENGRAM_DATA_DIR', value: this.spec.dataDir }],
      wait: 2,   // 재시작 대기 시작값(초)
      grow: 0.5, // 백오프 증가율
    });
  }

  private once(svc: Service, event: 'install' | 'uninstall' | 'start' | 'stop', action: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      svc.on(event, () => resolve());
      svc.on('alreadyinstalled', () => resolve());
      // uninstall(설치 안 된 서비스)은 node-windows가 'uninstall'이 아닌 'alreadyuninstalled'를 emit — 멱등 요구(S5) 위해 동일 처리.
      svc.on('alreadyuninstalled', () => resolve());
      // install(파일 일부 누락된 손상 설치 감지 시)은 node-windows가 여기서 return하고 설치를 진행/복구하지 않음(daemon.js install()) —
      // 즉 install이 완료되지 않았으므로 resolve로 위장하면 거짓 성공 보고가 됨 → 명확한 실패로 reject.
      svc.on('invalidinstallation', () => reject(new Error('invalid existing installation — uninstall first')));
      svc.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
      action();
    });
  }

  async install(): Promise<void> { const s = this.build(); await this.once(s, 'install', () => s.install()); }
  async uninstall(): Promise<void> { const s = this.build(); await this.once(s, 'uninstall', () => s.uninstall()); }
  async start(): Promise<void> { const s = this.build(); await this.once(s, 'start', () => s.start()); }
  async stop(): Promise<void> { const s = this.build(); await this.once(s, 'stop', () => s.stop()); }
  async status(): Promise<ServiceStatus> { return this.build().exists ? 'running' : 'not-installed'; }
}
