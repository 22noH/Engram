import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { SupervisorPort, ServiceStatus, ServiceSpec } from './supervisor.port';

// macOS launchd 어댑터(설계 §10.1). LaunchAgent plist — KeepAlive(죽으면 재시작) + RunAtLoad(부팅 시작).
export class MacosSupervisor implements SupervisorPort {
  constructor(private readonly spec: ServiceSpec) {}

  buildPlist(): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      `  <string>${this.spec.name}</string>`,
      '  <key>ProgramArguments</key>',
      `  <array><string>${process.execPath}</string><string>${this.spec.scriptPath}</string></array>`,
      '  <key>EnvironmentVariables</key>',
      `  <dict><key>ENGRAM_DATA_DIR</key><string>${this.spec.dataDir}</string></dict>`,
      '  <key>KeepAlive</key><true/>',
      '  <key>RunAtLoad</key><true/>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
  }

  private plistPath(): string {
    return path.join(os.homedir(), 'Library', 'LaunchAgents', `${this.spec.name}.plist`);
  }

  async install(): Promise<void> {
    const p = this.plistPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, this.buildPlist());
    execFileSync('launchctl', ['load', p]);
  }
  async uninstall(): Promise<void> {
    try { execFileSync('launchctl', ['unload', this.plistPath()]); } catch { /* 미로드 */ }
    try { fs.unlinkSync(this.plistPath()); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } // 이미 없음만 무시
  }
  async start(): Promise<void> { execFileSync('launchctl', ['start', this.spec.name]); }
  async stop(): Promise<void> { execFileSync('launchctl', ['stop', this.spec.name]); }
  async status(): Promise<ServiceStatus> {
    try {
      execFileSync('launchctl', ['list', this.spec.name]);
      return 'running';
    } catch { return 'not-installed'; }
  }
}
