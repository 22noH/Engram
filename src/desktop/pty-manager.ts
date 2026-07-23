// 코드 패널 터미널(스펙: docs/superpowers/specs/2026-07-23-code-panel-design.md) — 순수 로직.
// node-pty는 아래 defaultSpawnFactory 안에서만 require된다: 유닛테스트는 가짜 SpawnFactory를
// 주입해 네이티브 모듈 없이도 돌아간다(module load 시점에 require하지 않음).
import * as fs from 'fs';

// 실제 pty 프로세스가 만족해야 하는 최소 구조(node-pty의 IPty와 구조적으로 호환).
export interface PtyLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type SpawnFactory = (shell: string, cwd: string) => PtyLike;

// 셸 선택 규칙(스펙 §터미널 verbatim): 윈도우=PowerShell, 맥=zsh, 그 외=$SHELL(없으면 bash).
export function pickShell(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'powershell.exe';
  if (platform === 'darwin') return 'zsh';
  return process.env.SHELL || 'bash';
}

// 패널 재오픈 시 최근 출력을 다시 보여주기 위한 리플레이 버퍼 cap.
// 리뷰 지적: UTF-16 코드유닛(string.length) 기준으로 캡을 걸면 한글 등 멀티바이트 출력이
// 실제로는 명목상 cap의 최대 3배까지 쌓일 수 있다 — Buffer.byteLength(UTF-8) 기준으로 잰다.
const REPLAY_CAP_BYTES = 200 * 1024; // ~200KB(UTF-8 바이트)

function appendCapped(buf: string, chunk: string, capBytes: number): string {
  const next = buf + chunk;
  const nextBuf = Buffer.from(next, 'utf8');
  if (nextBuf.length <= capBytes) return next;
  // 뒤에서부터 capBytes 바이트 지점을 자르되, 그 지점이 UTF-8 문자 중간(연속 바이트
  // 0x80~0xBF)이면 문자 경계까지 앞으로 당긴다 — 뒤로 밀면 cap을 넘을 수 있지만 앞으로
  // 당기는 건 결과를 더 작게만 만들어 cap 초과가 절대 없다(경계에서 잘린 첫 글자 하나를
  // 통째로 버리는 것 — U+FFFD 치환으로 바이트가 늘어나는 것보다 정확).
  let start = nextBuf.length - capBytes;
  while (start < nextBuf.length && (nextBuf[start] & 0xc0) === 0x80) start++;
  return nextBuf.subarray(start).toString('utf8');
}

interface Session {
  sid: string;
  channelId: string;
  shell: string;
  proc: PtyLike;
  buffer: string;
}

let seq = 0;
function nextSid(): string {
  seq += 1;
  return `pty-${Date.now().toString(36)}-${seq}`;
}

// node-pty 실 스폰(Electron 메인 전용). require를 함수 안에 둬 유닛테스트 로드시 네이티브
// 모듈을 건드리지 않는다.
export const defaultSpawnFactory: SpawnFactory = (shell, cwd) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pty = require('node-pty') as typeof import('node-pty');
  return pty.spawn(shell, [], {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
    cwd,
    env: process.env as { [key: string]: string },
  });
};

export class PtyManager {
  private sessions = new Map<string, Session>(); // sid -> session
  private byChannel = new Map<string, string>(); // channelId -> sid
  private dataCbs: Array<(sid: string, data: string) => void> = [];
  private exitCbs: Array<(sid: string, code: number) => void> = [];

  constructor(
    private readonly spawnFactory: SpawnFactory = defaultSpawnFactory,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  // 채널당 1세션: 기존 세션이 있으면 그대로 반환(cwd 무시), 없으면 새로 스폰.
  start(channelId: string, cwd: string): { sid: string; shell: string } | { error: string } {
    const existingSid = this.byChannel.get(channelId);
    if (existingSid) {
      const existing = this.sessions.get(existingSid);
      if (existing) return { sid: existing.sid, shell: existing.shell };
      this.byChannel.delete(channelId); // 매핑만 남고 세션은 유실된 경우 정리 후 새로 스폰
    }
    // 리뷰 지적: cwd가 문자열이 아니거나 실존하지 않으면 스폰 전에 걸러낸다(스폰 자체가
    // throw하거나, 셸이 뜨자마자 즉시 죽는 것보다 원인이 분명한 에러를 준다).
    if (typeof cwd !== 'string' || !fs.existsSync(cwd)) {
      return { error: 'invalid cwd' };
    }
    const shell = pickShell(this.platform);
    try {
      const proc = this.spawnFactory(shell, cwd);
      const sid = nextSid();
      const session: Session = { sid, channelId, shell, proc, buffer: '' };
      this.sessions.set(sid, session);
      this.byChannel.set(channelId, sid);
      proc.onData((data) => {
        session.buffer = appendCapped(session.buffer, data, REPLAY_CAP_BYTES);
        for (const cb of this.dataCbs) {
          try {
            cb(sid, data);
          } catch {
            // never-throw: 구독자 에러가 다른 구독자·매니저를 건드리지 않게 격리
          }
        }
      });
      proc.onExit(({ exitCode }) => {
        this.sessions.delete(sid);
        if (this.byChannel.get(channelId) === sid) this.byChannel.delete(channelId);
        for (const cb of this.exitCbs) {
          try {
            cb(sid, exitCode);
          } catch {
            // never-throw
          }
        }
      });
      return { sid, shell };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  write(sid: string, data: string): void {
    const s = this.sessions.get(sid);
    if (!s) return;
    try {
      s.proc.write(data);
    } catch {
      // never-throw
    }
  }

  resize(sid: string, cols: number, rows: number): void {
    const s = this.sessions.get(sid);
    if (!s) return;
    try {
      s.proc.resize(cols, rows);
    } catch {
      // never-throw
    }
  }

  kill(sid: string): void {
    const s = this.sessions.get(sid);
    if (!s) return;
    try {
      s.proc.kill();
    } catch {
      // never-throw
    }
    this.sessions.delete(sid);
    if (this.byChannel.get(s.channelId) === sid) this.byChannel.delete(s.channelId);
  }

  killAll(): void {
    for (const sid of Array.from(this.sessions.keys())) this.kill(sid);
  }

  // 패널 재오픈용 최근 출력 버퍼(cap ~200KB). 세션 없으면 빈 문자열.
  replay(sid: string): string {
    return this.sessions.get(sid)?.buffer ?? '';
  }

  onData(cb: (sid: string, data: string) => void): void {
    this.dataCbs.push(cb);
  }

  onExit(cb: (sid: string, code: number) => void): void {
    this.exitCbs.push(cb);
  }
}
