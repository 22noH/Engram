import { LinuxSupervisor } from './linux-supervisor';

describe('LinuxSupervisor.buildUnit', () => {
  it('systemd 유닛에 재시작·환경·실행경로를 담는다', () => {
    const unit = new LinuxSupervisor({ name: 'engram', scriptPath: '/app/main.js', dataDir: '/data' }).buildUnit();
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('Environment="ENGRAM_DATA_DIR=/data"');
    expect(unit).toContain('ExecStart=');
    expect(unit).toContain('/app/main.js');
    expect(unit).toContain('WatchdogSec=');  // 멈춤 감지 네이티브(설계 §10.1)
    expect(unit).toContain('ExecStart="');           // 경로 따옴표(공백 안전)
    expect(unit).toContain('"/app/main.js"');         // scriptPath 따옴표 포함
  });
});
