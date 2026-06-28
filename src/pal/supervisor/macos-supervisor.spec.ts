import { MacosSupervisor } from './macos-supervisor';

describe('MacosSupervisor.buildPlist', () => {
  it('plist에 라벨·KeepAlive·RunAtLoad·환경·실행인자를 담는다', () => {
    const plist = new MacosSupervisor({ name: 'com.engram.daemon', scriptPath: '/app/main.js', dataDir: '/data' }).buildPlist();
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('com.engram.daemon');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('ENGRAM_DATA_DIR');
    expect(plist).toContain('/app/main.js');
  });
});
