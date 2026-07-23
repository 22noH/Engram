import { PtyManager, PtyLike, SpawnFactory, pickShell } from './pty-manager';

// 가짜 pty 프로세스: onData/onExit 콜백을 캡처해 테스트에서 직접 발화시킨다.
class FakePty implements PtyLike {
  dataCbs: Array<(data: string) => void> = [];
  exitCbs: Array<(e: { exitCode: number }) => void> = [];
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;
  killThrows = false;
  writeThrows = false;

  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb);
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCbs.push(cb);
  }
  write(data: string): void {
    if (this.writeThrows) throw new Error('write boom');
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  kill(): void {
    if (this.killThrows) throw new Error('kill boom');
    this.killed = true;
  }
  fireData(data: string): void {
    for (const cb of this.dataCbs) cb(data);
  }
  fireExit(exitCode: number): void {
    for (const cb of this.exitCbs) cb({ exitCode });
  }
}

function makeFactory(): { factory: SpawnFactory; procs: FakePty[]; calls: Array<{ shell: string; cwd: string }> } {
  const procs: FakePty[] = [];
  const calls: Array<{ shell: string; cwd: string }> = [];
  const factory: SpawnFactory = (shell, cwd) => {
    calls.push({ shell, cwd });
    const p = new FakePty();
    procs.push(p);
    return p;
  };
  return { factory, procs, calls };
}

describe('pickShell', () => {
  it('win32 → powershell.exe', () => {
    expect(pickShell('win32')).toBe('powershell.exe');
  });
  it('darwin → zsh', () => {
    expect(pickShell('darwin')).toBe('zsh');
  });
  it('그 외 → $SHELL(있으면) 아니면 bash', () => {
    const prev = process.env.SHELL;
    process.env.SHELL = '/usr/bin/fish';
    expect(pickShell('linux')).toBe('/usr/bin/fish');
    delete process.env.SHELL;
    expect(pickShell('linux')).toBe('bash');
    if (prev !== undefined) process.env.SHELL = prev;
  });
});

describe('PtyManager', () => {
  it('start()로 새 세션 생성 — sid·shell 반환, spawnFactory 1회 호출', () => {
    const { factory, calls } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const r = mgr.start('ch1', 'C:/repo');
    expect('error' in r).toBe(false);
    const ok = r as { sid: string; shell: string };
    expect(ok.shell).toBe('powershell.exe');
    expect(typeof ok.sid).toBe('string');
    expect(calls).toEqual([{ shell: 'powershell.exe', cwd: 'C:/repo' }]);
  });

  it('같은 채널로 다시 start() — 기존 세션 재사용(spawnFactory 재호출 없음)', () => {
    const { factory, calls } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const r1 = mgr.start('ch1', 'C:/repo') as { sid: string };
    const r2 = mgr.start('ch1', 'C:/repo-different-cwd') as { sid: string };
    expect(r2.sid).toBe(r1.sid);
    expect(calls.length).toBe(1);
  });

  it('다른 채널은 별도 세션(별도 sid)', () => {
    const { factory } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const r1 = mgr.start('ch1', 'C:/repo') as { sid: string };
    const r2 = mgr.start('ch2', 'C:/repo') as { sid: string };
    expect(r1.sid).not.toBe(r2.sid);
  });

  it('spawnFactory가 throw하면 {error}를 반환(never-throw)', () => {
    const factory: SpawnFactory = () => {
      throw new Error('spawn boom');
    };
    const mgr = new PtyManager(factory, 'win32');
    const r = mgr.start('ch1', 'C:/repo');
    expect('error' in r).toBe(true);
    expect((r as { error: string }).error).toContain('spawn boom');
  });

  it('write()는 해당 세션의 proc.write로 위임', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const { sid } = mgr.start('ch1', 'C:/repo') as { sid: string };
    mgr.write(sid, 'ls\r');
    expect(procs[0].writes).toEqual(['ls\r']);
  });

  it('write()는 미존재 sid에 대해 조용히 무시(never-throw)', () => {
    const { factory } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    expect(() => mgr.write('nope', 'x')).not.toThrow();
  });

  it('write()는 proc.write가 throw해도 삼킨다(never-throw)', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const { sid } = mgr.start('ch1', 'C:/repo') as { sid: string };
    procs[0].writeThrows = true;
    expect(() => mgr.write(sid, 'x')).not.toThrow();
  });

  it('resize()는 해당 세션의 proc.resize로 위임', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const { sid } = mgr.start('ch1', 'C:/repo') as { sid: string };
    mgr.resize(sid, 120, 40);
    expect(procs[0].resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('resize()는 미존재 sid에 대해 조용히 무시', () => {
    const { factory } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    expect(() => mgr.resize('nope', 80, 24)).not.toThrow();
  });

  it('kill()은 proc.kill() 호출 + 세션 제거(같은 채널 재start시 새 세션)', () => {
    const { factory, procs, calls } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const { sid } = mgr.start('ch1', 'C:/repo') as { sid: string };
    mgr.kill(sid);
    expect(procs[0].killed).toBe(true);
    const r2 = mgr.start('ch1', 'C:/repo') as { sid: string };
    expect(r2.sid).not.toBe(sid);
    expect(calls.length).toBe(2);
  });

  it('kill()은 미존재 sid·proc.kill이 throw해도 삼킨다(never-throw)', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    expect(() => mgr.kill('nope')).not.toThrow();
    const { sid } = mgr.start('ch1', 'C:/repo') as { sid: string };
    procs[0].killThrows = true;
    expect(() => mgr.kill(sid)).not.toThrow();
  });

  it('killAll()은 살아있는 모든 세션을 kill', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    mgr.start('ch1', 'C:/repo');
    mgr.start('ch2', 'C:/repo');
    mgr.killAll();
    expect(procs.every((p) => p.killed)).toBe(true);
  });

  it('onData 구독자는 (sid, data)로 팬아웃 수신', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const { sid } = mgr.start('ch1', 'C:/repo') as { sid: string };
    const received: Array<[string, string]> = [];
    mgr.onData((s, d) => received.push([s, d]));
    procs[0].fireData('hello');
    expect(received).toEqual([[sid, 'hello']]);
  });

  it('onData 구독자가 throw해도 다른 구독자·매니저는 영향 없음(never-throw)', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    mgr.start('ch1', 'C:/repo') as { sid: string };
    const received: string[] = [];
    mgr.onData(() => {
      throw new Error('subscriber boom');
    });
    mgr.onData((_s, d) => received.push(d));
    expect(() => procs[0].fireData('hi')).not.toThrow();
    expect(received).toEqual(['hi']);
  });

  it('onExit 구독자는 (sid, code) 수신 + 세션 정리(재start시 새 세션)', () => {
    const { factory, procs, calls } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const { sid } = mgr.start('ch1', 'C:/repo') as { sid: string };
    const received: Array<[string, number]> = [];
    mgr.onExit((s, c) => received.push([s, c]));
    procs[0].fireExit(1);
    expect(received).toEqual([[sid, 1]]);
    const r2 = mgr.start('ch1', 'C:/repo') as { sid: string };
    expect(r2.sid).not.toBe(sid);
    expect(calls.length).toBe(2);
  });

  it('replay()는 지금까지의 출력을 버퍼로 반환', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const { sid } = mgr.start('ch1', 'C:/repo') as { sid: string };
    procs[0].fireData('foo');
    procs[0].fireData('bar');
    expect(mgr.replay(sid)).toBe('foobar');
  });

  it('replay()는 미존재 sid에 대해 빈 문자열', () => {
    const { factory } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    expect(mgr.replay('nope')).toBe('');
  });

  it('replay 버퍼는 ~200KB로 캡(앞부분을 잘라 최신 데이터 유지)', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const { sid } = mgr.start('ch1', 'C:/repo') as { sid: string };
    const chunk = 'x'.repeat(50 * 1024); // 50KB
    for (let i = 0; i < 6; i++) procs[0].fireData(chunk); // 300KB 유입
    const buf = mgr.replay(sid);
    expect(buf.length).toBeLessThanOrEqual(200 * 1024);
    expect(buf.endsWith('x')).toBe(true); // 최신 데이터가 남아있음
  });
});
