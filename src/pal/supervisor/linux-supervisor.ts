import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { SupervisorPort, ServiceStatus, ServiceSpec } from './supervisor.port';

// Linux systemd 어댑터(설계 §10.1). user 단위 서비스 — Restart=always + WatchdogSec(멈춤 감지 네이티브).
export class LinuxSupervisor implements SupervisorPort {
  constructor(private readonly spec: ServiceSpec) {}

  buildUnit(): string {
    return [
      '[Unit]',
      'Description=Engram 24/7 상주 지식 코어',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart="${process.execPath}" "${this.spec.scriptPath}"`,
      `Environment=ENGRAM_DATA_DIR=${this.spec.dataDir}`,
      'Restart=always',
      'RestartSec=2',
      'WatchdogSec=120',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
  }

  private unitPath(): string {
    return path.join(os.homedir(), '.config', 'systemd', 'user', `${this.spec.name}.service`);
  }

  async install(): Promise<void> {
    const p = this.unitPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, this.buildUnit());
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', this.spec.name]);
  }
  async uninstall(): Promise<void> {
    execFileSync('systemctl', ['--user', 'disable', this.spec.name]);
    try { fs.unlinkSync(this.unitPath()); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } // 이미 없음만 무시
    execFileSync('systemctl', ['--user', 'daemon-reload']);
  }
  async start(): Promise<void> { execFileSync('systemctl', ['--user', 'start', this.spec.name]); }
  async stop(): Promise<void> { execFileSync('systemctl', ['--user', 'stop', this.spec.name]); }
  async status(): Promise<ServiceStatus> {
    try {
      const out = execFileSync('systemctl', ['--user', 'is-active', this.spec.name]).toString().trim();
      return out === 'active' ? 'running' : 'stopped';
    } catch { return 'not-installed'; }
  }
}
