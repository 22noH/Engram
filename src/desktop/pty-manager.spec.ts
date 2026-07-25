import * as path from 'path';
import { PtyManager, PtyLike, SpawnFactory, pickShell } from './pty-manager';

// 실존해야 하는 cwd 검증(리뷰 T1 minor 2) 테스트용 — 이 스펙 파일 자신의 디렉터리는 항상 존재.
const VALID_CWD = __dirname;
const VALID_CWD_2 = path.dirname(__dirname); // 다른 실존 경로(재사용 테스트에서 "무시됨"을 보여주는 용도)

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
    const r = mgr.start('ch1', VALID_CWD);
    expect('error' in r).toBe(false);
    const ok = r as { sid: string; shell: string };
    expect(ok.shell).toBe('powershell.exe');
    expect(typeof ok.sid).toBe('string');
    expect(calls).toEqual([{ shell: 'powershell.exe', cwd: VALID_CWD }]);
  });

  it('같은 채널로 다시 start() — 기존 세션 재사용(spawnFactory 재호출 없음, cwd 변경 무시)', () => {
    const { factory, calls } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const r1 = mgr.start('ch1', VALID_CWD) as { sid: string };
    const r2 = mgr.start('ch1', VALID_CWD_2) as { sid: string };
    expect(r2.sid).toBe(r1.sid);
    expect(calls.length).toBe(1);
  });

  it('다른 채널은 별도 세션(별도 sid)', () => {
    const { factory } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const r1 = mgr.start('ch1', VALID_CWD) as { sid: string };
    const r2 = mgr.start('ch2', VALID_CWD) as { sid: string };
    expect(r1.sid).not.toBe(r2.sid);
  });

  it('spawnFactory가 throw하면 {error}를 반환(never-throw)', () => {
    const factory: SpawnFactory = () => {
      throw new Error('spawn boom');
    };
    const mgr = new PtyManager(factory, 'win32');
    const r = mgr.start('ch1', VALID_CWD);
    expect('error' in r).toBe(true);
    expect((r as { error: string }).error).toContain('spawn boom');
  });

  it('cwd가 문자열이 아니면 스폰 전에 {error: "invalid cwd"}(spawnFactory 미호출)', () => {
    const { factory, calls } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const r = mgr.start('ch1', undefined as unknown as string);
    expect(r).toEqual({ error: 'invalid cwd' });
    expect(calls.length).toBe(0);
  });

  it('cwd가 실존하지 않으면 스폰 전에 {error: "invalid cwd"}(spawnFactory 미호출)', () => {
    const { factory, calls } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const r = mgr.start('ch1', 'C:/definitely-does-not-exist-engram-pty-test');
    expect(r).toEqual({ error: 'invalid cwd' });
    expect(calls.length).toBe(0);
  });

  it('write()는 해당 세션의 proc.write로 위임', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const { sid } = mgr.start('ch1', VALID_CWD) as { sid: string };
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
    const { sid } = mgr.start('ch1', VALID_CWD) as { sid: string };
    procs[0].writeThrows = true;
    expect(() => mgr.write(sid, 'x')).not.toThrow();
  });

  it('resize()는 해당 세션의 proc.resize로 위임', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const { sid } = mgr.start('ch1', VALID_CWD) as { sid: string };
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
    const { sid } = mgr.start('ch1', VALID_CWD) as { sid: string };
    mgr.kill(sid);
    expect(procs[0].killed).toBe(true);
    const r2 = mgr.start('ch1', VALID_CWD) as { sid: string };
    expect(r2.sid).not.toBe(sid);
    expect(calls.length).toBe(2);
  });

  it('kill()은 미존재 sid·proc.kill이 throw해도 삼킨다(never-throw)', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    expect(() => mgr.kill('nope')).not.toThrow();
    const { sid } = mgr.start('ch1', VALID_CWD) as { sid: string };
    procs[0].killThrows = true;
    expect(() => mgr.kill(sid)).not.toThrow();
  });

  it('killAll()은 살아있는 모든 세션을 kill', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    mgr.start('ch1', VALID_CWD);
    mgr.start('ch2', VALID_CWD);
    mgr.killAll();
    expect(procs.every((p) => p.killed)).toBe(true);
  });

  // 독 패널(2026-07-25): 한 채널에 터미널 탭이 여러 개다 → 키가 `채널#탭id`로 늘어난다.
  // killAll이 "채널 하나당 하나"가 아니라 **키 개수만큼** 전부 정리해야 고아가 안 남는다.
  it('killAll()은 한 채널의 여러 키(탭) 세션도 전부 kill한다 — 독 패널 고아 방지', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    mgr.start('ch1#t1', VALID_CWD);
    mgr.start('ch1#t2', VALID_CWD);
    mgr.start('ch1#srv-a', VALID_CWD);
    expect(procs).toHaveLength(3);
    mgr.killAll();
    expect(procs.every((p) => p.killed)).toBe(true);
  });

  it('start()는 새로 스폰했는지(created)를 알려준다 — 서버 명령 자동 입력은 새 세션에만', () => {
    const { factory } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const r1 = mgr.start('ch1', VALID_CWD) as { created: boolean };
    const r2 = mgr.start('ch1', VALID_CWD) as { created: boolean };
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false); // 재사용(리플레이) — 명령을 또 치면 서버가 두 번 뜬다
  });

  it('killKey()는 키로 세션을 죽인다(탭을 닫을 때 sid를 몰라도 정리 가능)', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    mgr.start('ch1#t1', VALID_CWD);
    mgr.start('ch1#t2', VALID_CWD);
    mgr.killKey('ch1#t1');
    expect(procs[0].killed).toBe(true);
    expect(procs[1].killed).toBe(false);
    // 죽인 키로 다시 start하면 새 세션이 뜬다(매핑도 같이 지워졌다는 뜻)
    const r = mgr.start('ch1#t1', VALID_CWD) as { created: boolean };
    expect(r.created).toBe(true);
  });

  it('aliveKeys()는 살아있는 키만 돌려준다 — 서버 "실행 중" 표시가 거짓말하지 않게', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    mgr.start('ch1#a', VALID_CWD);
    mgr.start('ch1#b', VALID_CWD);
    expect(mgr.aliveKeys(['ch1#a', 'ch1#b', 'ch1#never'])).toEqual(['ch1#a', 'ch1#b']);
    mgr.killKey('ch1#a');
    expect(mgr.aliveKeys(['ch1#a', 'ch1#b'])).toEqual(['ch1#b']);
    procs[1].fireExit(0); // 서버가 스스로 죽은 경우도 반영된다
    expect(mgr.aliveKeys(['ch1#a', 'ch1#b'])).toEqual([]);
  });

  it('killKey()는 없는 키·kill throw를 삼킨다(never-throw)', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    expect(() => mgr.killKey('nope')).not.toThrow();
    mgr.start('ch1', VALID_CWD);
    procs[0].killThrows = true;
    expect(() => mgr.killKey('ch1')).not.toThrow();
  });

  it('onData 구독자는 (sid, data)로 팬아웃 수신', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const { sid } = mgr.start('ch1', VALID_CWD) as { sid: string };
    const received: Array<[string, string]> = [];
    mgr.onData((s, d) => received.push([s, d]));
    procs[0].fireData('hello');
    expect(received).toEqual([[sid, 'hello']]);
  });

  it('onData 구독자가 throw해도 다른 구독자·매니저는 영향 없음(never-throw)', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    mgr.start('ch1', VALID_CWD) as { sid: string };
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
    const { sid } = mgr.start('ch1', VALID_CWD) as { sid: string };
    const received: Array<[string, number]> = [];
    mgr.onExit((s, c) => received.push([s, c]));
    procs[0].fireExit(1);
    expect(received).toEqual([[sid, 1]]);
    const r2 = mgr.start('ch1', VALID_CWD) as { sid: string };
    expect(r2.sid).not.toBe(sid);
    expect(calls.length).toBe(2);
  });

  it('replay()는 지금까지의 출력을 버퍼로 반환', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const { sid } = mgr.start('ch1', VALID_CWD) as { sid: string };
    procs[0].fireData('foo');
    procs[0].fireData('bar');
    expect(mgr.replay(sid)).toBe('foobar');
  });

  it('replay()는 미존재 sid에 대해 빈 문자열', () => {
    const { factory } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    expect(mgr.replay('nope')).toBe('');
  });

  it('replay 버퍼는 ~200KB(바이트)로 캡(앞부분을 잘라 최신 데이터 유지)', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const { sid } = mgr.start('ch1', VALID_CWD) as { sid: string };
    const chunk = 'x'.repeat(50 * 1024); // 50KB(ASCII라 바이트=문자수)
    for (let i = 0; i < 6; i++) procs[0].fireData(chunk); // 300KB 유입
    const buf = mgr.replay(sid);
    expect(Buffer.byteLength(buf, 'utf8')).toBeLessThanOrEqual(200 * 1024);
    expect(buf.endsWith('x')).toBe(true); // 최신 데이터가 남아있음
  });

  it('replay 버퍼 캡은 UTF-16 코드유닛이 아니라 UTF-8 바이트 기준(리뷰 T1 minor 1 — 한글 등 멀티바이트 출력)', () => {
    const { factory, procs } = makeFactory();
    const mgr = new PtyManager(factory, 'win32');
    const { sid } = mgr.start('ch1', VALID_CWD) as { sid: string };
    // 한글 한 글자는 UTF-8로 3바이트지만 UTF-16 코드유닛(string.length)으로는 1 — 문자수 기준
    // cap이었다면 실제 바이트가 캡의 최대 3배까지 쌓일 수 있었다.
    const koreanChunk = '가'.repeat(10 * 1024); // 10*1024 문자 = 30KB(UTF-8)
    for (let i = 0; i < 20; i++) procs[0].fireData(koreanChunk); // 문자수 기준 200KB, 바이트 기준 600KB 유입
    const buf = mgr.replay(sid);
    expect(Buffer.byteLength(buf, 'utf8')).toBeLessThanOrEqual(200 * 1024);
  });
});
