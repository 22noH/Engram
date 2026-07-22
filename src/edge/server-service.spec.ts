import { EventEmitter } from 'events';
import { PathResolver } from '../pal/path-resolver';
import type { ServiceSpec, ServiceStatus, SupervisorPort } from '../pal/supervisor/supervisor.port';
import {
  FIREWALL_RULE_NAME, NON_WINDOWS_GUIDANCE, SERVICE_NAME, addFirewallRule, buildServerServiceSpec,
  installService, removeFirewallRule, runForeground, serviceControl, uninstallService,
  type ForegroundDeps, type NetshRunner, type ServiceDeps,
} from './server-service';

// TDD(S5 Task 3 브리프 Step 1): fake supervisor + fake netsh 러너를 주입해 순수 로직만 검증한다.
// 실 node-windows·실 netsh는 여기서 건드리지 않는다(윈도우 전용·관리자 권한 필요 — CI에서 못 돌림).

function fakeSupervisor(overrides: Partial<Record<keyof SupervisorPort, () => unknown>> = {}): SupervisorPort {
  return {
    install: jest.fn(overrides.install ?? (async () => undefined)),
    uninstall: jest.fn(overrides.uninstall ?? (async () => undefined)),
    start: jest.fn(overrides.start ?? (async () => undefined)),
    stop: jest.fn(overrides.stop ?? (async () => undefined)),
    status: jest.fn(overrides.status ?? (async () => 'running' as ServiceStatus)),
  } as unknown as SupervisorPort;
}

function makeDeps(opts: {
  platform?: NodeJS.Platform;
  supervisor?: SupervisorPort;
  runNetsh?: NetshRunner;
  port?: number;
}): ServiceDeps & { createSupervisorSpy: jest.Mock } {
  const supervisor = opts.supervisor ?? fakeSupervisor();
  const createSupervisorSpy = jest.fn(() => supervisor);
  return {
    platform: opts.platform ?? 'win32',
    paths: new PathResolver('C:/fake-data'),
    repoRoot: 'C:/fake-repo',
    createSupervisor: createSupervisorSpy as unknown as ServiceDeps['createSupervisor'],
    runNetsh: opts.runNetsh ?? jest.fn(async () => undefined),
    loadChatConfig: () => ({ port: opts.port ?? 47800 }),
    createSupervisorSpy,
  };
}

describe('buildServerServiceSpec', () => {
  it('name=EngramServer·scriptPath=dist/src/main.js(레포 루트 기준)·dataDir 그대로', () => {
    const spec: ServiceSpec = buildServerServiceSpec('C:/repo', 'C:/data');
    expect(spec.name).toBe('EngramServer');
    expect(spec.scriptPath.replace(/\\/g, '/')).toBe('C:/repo/dist/src/main.js');
    expect(spec.dataDir).toBe('C:/data');
    expect(SERVICE_NAME).toBe('EngramServer');
  });
});

describe('addFirewallRule / removeFirewallRule', () => {
  it('add: netsh에 name·dir=in·action=allow·protocol=TCP·localport 인자를 넘긴다', async () => {
    const runNetsh: NetshRunner = jest.fn(async () => undefined);
    const r = await addFirewallRule(runNetsh, 47800);
    expect(r.ok).toBe(true);
    expect(runNetsh).toHaveBeenCalledWith([
      'advfirewall', 'firewall', 'add', 'rule',
      `name=${FIREWALL_RULE_NAME}`, 'dir=in', 'action=allow', 'protocol=TCP', 'localport=47800',
    ]);
  });

  it('add: netsh 실패(비관리자 모사) → throw 아닌 안내 반환', async () => {
    const runNetsh: NetshRunner = jest.fn(async () => { throw new Error('요청한 작업을 수행하려면 상승된 권한이 필요합니다'); });
    const r = await addFirewallRule(runNetsh, 47800);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('관리자');
  });

  it('remove: netsh delete rule 인자(name)로 호출', async () => {
    const runNetsh: NetshRunner = jest.fn(async () => undefined);
    const r = await removeFirewallRule(runNetsh);
    expect(r.ok).toBe(true);
    expect(runNetsh).toHaveBeenCalledWith(['advfirewall', 'firewall', 'delete', 'rule', `name=${FIREWALL_RULE_NAME}`]);
  });

  it('remove: 규칙이 없어 netsh가 실패해도 무해(ok:true)', async () => {
    const runNetsh: NetshRunner = jest.fn(async () => { throw new Error('No rules match the specified criteria'); });
    const r = await removeFirewallRule(runNetsh);
    expect(r.ok).toBe(true);
  });
});

describe('installService', () => {
  it('supervisor.install 호출 + netsh add rule(localport=config port) 인자 검증', async () => {
    const supervisor = fakeSupervisor();
    const deps = makeDeps({ supervisor, port: 51234 });
    const r = await installService(deps);
    expect(r.ok).toBe(true);
    expect(supervisor.install).toHaveBeenCalledTimes(1);
    expect(deps.runNetsh).toHaveBeenCalledWith(expect.arrayContaining(['localport=51234']));
    expect(deps.createSupervisorSpy).toHaveBeenCalledWith('win32', expect.objectContaining({ name: 'EngramServer' }));
  });

  it('두 번 호출해도 무해(멱등) — 매번 install/netsh 재실행', async () => {
    const supervisor = fakeSupervisor();
    const deps = makeDeps({ supervisor });
    await installService(deps);
    await installService(deps);
    expect(supervisor.install).toHaveBeenCalledTimes(2);
    expect(deps.runNetsh).toHaveBeenCalledTimes(2);
  });

  it('netsh 실패(비관리자 모사) → throw 아닌 안내 반환(서비스 자체는 이미 설치됨)', async () => {
    const supervisor = fakeSupervisor();
    const runNetsh: NetshRunner = jest.fn(async () => { throw new Error('elevation required'); });
    const deps = makeDeps({ supervisor, runNetsh });
    const r = await installService(deps);
    expect(r.ok).toBe(true); // 서비스 설치는 성공, 방화벽만 실패 — 크래시 아님
    expect(r.message).toContain('관리자');
  });

  it('supervisor.install 자체가 실패(비관리자 모사) → throw 아닌 안내 반환, netsh는 호출 안 함', async () => {
    const supervisor = fakeSupervisor({ install: async () => { throw new Error('access denied'); } });
    const deps = makeDeps({ supervisor });
    const r = await installService(deps);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('관리자');
    expect(deps.runNetsh).not.toHaveBeenCalled();
  });

  it('비윈도우 platform → 서비스 안내 메시지, supervisor/netsh 미호출', async () => {
    const deps = makeDeps({ platform: 'linux' });
    const r = await installService(deps);
    expect(r.ok).toBe(false);
    expect(r.message).toBe(NON_WINDOWS_GUIDANCE);
    expect(deps.createSupervisorSpy).not.toHaveBeenCalled();
    expect(deps.runNetsh).not.toHaveBeenCalled();
  });
});

describe('uninstallService', () => {
  it('supervisor.uninstall 호출 + netsh delete rule 호출', async () => {
    const supervisor = fakeSupervisor();
    const deps = makeDeps({ supervisor });
    const r = await uninstallService(deps);
    expect(r.ok).toBe(true);
    expect(supervisor.uninstall).toHaveBeenCalledTimes(1);
    expect(deps.runNetsh).toHaveBeenCalledWith(expect.arrayContaining(['delete']));
  });

  it('두 번 호출해도 무해(멱등) — netsh가 두 번째엔 "규칙 없음"으로 실패해도 ok', async () => {
    const supervisor = fakeSupervisor();
    let call = 0;
    const runNetsh: NetshRunner = jest.fn(async () => {
      call++;
      if (call > 1) throw new Error('No rules match the specified criteria');
    });
    const deps = makeDeps({ supervisor, runNetsh });
    const r1 = await uninstallService(deps);
    const r2 = await uninstallService(deps);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(supervisor.uninstall).toHaveBeenCalledTimes(2);
  });

  it('비윈도우 platform → 서비스 안내 메시지, supervisor 미호출', async () => {
    const deps = makeDeps({ platform: 'darwin' });
    const r = await uninstallService(deps);
    expect(r.ok).toBe(false);
    expect(r.message).toBe(NON_WINDOWS_GUIDANCE);
    expect(deps.createSupervisorSpy).not.toHaveBeenCalled();
  });
});

describe('serviceControl', () => {
  it('start/stop → supervisor 위임', async () => {
    const supervisor = fakeSupervisor();
    const deps = makeDeps({ supervisor });
    expect((await serviceControl('start', deps)).ok).toBe(true);
    expect(supervisor.start).toHaveBeenCalledTimes(1);
    expect((await serviceControl('stop', deps)).ok).toBe(true);
    expect(supervisor.stop).toHaveBeenCalledTimes(1);
  });

  it('status → supervisor.status 결과를 그대로 반영', async () => {
    const supervisor = fakeSupervisor({ status: async () => 'not-installed' as ServiceStatus });
    const deps = makeDeps({ supervisor });
    const r = await serviceControl('status', deps);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('not-installed');
  });

  it('비윈도우 platform → 서비스 안내 메시지, supervisor 미호출', async () => {
    const deps = makeDeps({ platform: 'linux' });
    const r = await serviceControl('status', deps);
    expect(r.ok).toBe(false);
    expect(r.message).toBe(NON_WINDOWS_GUIDANCE);
    expect(deps.createSupervisorSpy).not.toHaveBeenCalled();
  });
});

describe('runForeground', () => {
  class FakeChild extends EventEmitter {}

  it('node dist/src/main.js를 spawn(stdio 상속·ENGRAM_DATA_DIR 주입)하고 종료코드를 그대로 반환', async () => {
    const child = new FakeChild();
    let capturedArgs: { execPath: string; args: string[]; opts: unknown } | undefined;
    const deps: ForegroundDeps = {
      paths: new PathResolver('C:/fake-data'),
      repoRoot: 'C:/fake-repo',
      env: { PATH: 'x' } as NodeJS.ProcessEnv,
      spawnFn: ((execPath: string, args: string[], opts: unknown) => {
        capturedArgs = { execPath, args, opts };
        return child as unknown as ReturnType<ForegroundDeps['spawnFn']>;
      }) as ForegroundDeps['spawnFn'],
    };
    const resultP = runForeground(deps);
    expect(capturedArgs?.args[0].replace(/\\/g, '/')).toBe('C:/fake-repo/dist/src/main.js');
    expect((capturedArgs?.opts as { stdio: string }).stdio).toBe('inherit');
    expect((capturedArgs?.opts as { env: NodeJS.ProcessEnv }).env.ENGRAM_DATA_DIR).toBe('C:/fake-data');
    child.emit('exit', 0);
    expect(await resultP).toBe(0);
  });

  it('비정상 종료코드도 그대로 전파', async () => {
    const child = new FakeChild();
    const deps: ForegroundDeps = {
      paths: new PathResolver('C:/fake-data'),
      repoRoot: 'C:/fake-repo',
      env: {} as NodeJS.ProcessEnv,
      spawnFn: (() => child as unknown as ReturnType<ForegroundDeps['spawnFn']>) as ForegroundDeps['spawnFn'],
    };
    const resultP = runForeground(deps);
    child.emit('exit', 1);
    expect(await resultP).toBe(1);
  });
});
