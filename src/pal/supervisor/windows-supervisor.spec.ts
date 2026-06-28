import { WindowsSupervisor } from './windows-supervisor';

describe('WindowsSupervisor', () => {
  it('install은 name·script·env(ENGRAM_DATA_DIR)로 서비스를 구성한다', async () => {
    let opts: any;
    const fakeServiceFactory = (o: any) => {
      opts = o;
      const handlers: Record<string, () => void> = {};
      return { on: (e: string, cb: () => void) => { handlers[e] = cb; }, install: () => handlers['install']?.(), uninstall: () => {}, start: () => {}, stop: () => {} };
    };
    const sup = new WindowsSupervisor({ name: 'Engram', scriptPath: 'C:/app/main.js', dataDir: 'C:/data' }, fakeServiceFactory as any);
    await sup.install();
    expect(opts.name).toBe('Engram');
    expect(opts.script).toBe('C:/app/main.js');
    expect(opts.env).toEqual([{ name: 'ENGRAM_DATA_DIR', value: 'C:/data' }]);
  });
});
