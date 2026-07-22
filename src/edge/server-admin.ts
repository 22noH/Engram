import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { PathResolver } from '../pal/path-resolver';
import { AccountStore } from './auth/account-store';
import { ensureSetupCode } from './auth/setup-code';
import { ChatStore } from './messenger/chat-store';
import { loadChatConfig } from './messenger/chat.config';

// engram-server CLI(S5 Task 1)가 부르는 순수 로직. admin-http.ts의 웹 콘솔 계산을 터미널에서
// 재현한다 — 스토어/헬퍼를 그대로 재사용해 로직 중복 0(플랜 Global Constraints). Nest 부트 없음:
// 여기서 만드는 스토어는 전부 plain class 직접 생성(new AccountStore(...) 등).
// 함수는 전부 순수(process.exit·console 없음) — CLI 엔트리(server-cli.ts)가 IO/종료코드를 맡는다.

export interface ServerStatus {
  lastHeartbeatMs: number | null;
  chatBytes: number;
  knowledgeBytes: number;
  memberCount: number;
  channelCount: number;
  listening: boolean;
}

export interface SetupResult {
  code: string | null;
  alreadyConfigured: boolean;
  consoleUrl: string;
}

// admin-http.ts:983 dirSizeBytes(private 메서드)와 동일한 계산을 여기 복제한다(브리프 결정 —
// admin-http.ts는 CLI가 의존하기엔 무거운 파일이라 export 추출 대신 복제 택. 계약이 단순하고
// 안정적이라[재귀 readdir+statSync, 없는 디렉터리=0, 개별 항목 실패 skip] 복제 쪽이 결합을 줄인다).
export function dirSizeBytes(dir: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // 디렉터리 없음 = 0
  }
  let total = 0;
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSizeBytes(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch { /* 개별 항목 통계 실패는 skip */ }
  }
  return total;
}

// 그 포트에 127.0.0.1로 TCP 접속을 시도해 "지금 뭔가 리슨 중인가"만 확인한다(누가·무엇인지는
// 판별하지 않음 — 로컬 CLI에서 흔한 관용, admin-http 헬스체크와 동일 결). 짧은 타임아웃으로
// 접속 거부/무응답을 빠르게 false로 접는다(CLI가 멈춰 보이면 안 됨).
function probeListening(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

// admin-http.ts:956 getStatus와 동일 계산(heartbeat 파일·dirSize·historyBytes·counts) + 리슨 여부.
// uptimeSec은 넣지 않는다 — CLI는 매번 새 프로세스라 process.uptime()이 무의미(브리프 지시).
// 대신 lastHeartbeatMs(상주 프로세스가 60초마다 갱신하는 파일)로 "최근에 살아있었나"를 본다.
export async function runStatus(paths: PathResolver): Promise<ServerStatus> {
  const accounts = new AccountStore(paths.getStateDir());
  const chatCfg = loadChatConfig(paths.getConfigDir());
  const chat = new ChatStore(path.join(paths.getStateDir(), 'chat'), chatCfg.retention);

  let lastHeartbeatMs: number | null = null;
  try {
    const raw = fs.readFileSync(paths.getHeartbeatPath(), 'utf8').trim();
    const n = Number(raw);
    if (Number.isFinite(n)) lastHeartbeatMs = n;
  } catch { /* 파일 없음(상주 미가동/최초 부팅 전) — null 유지 */ }

  const knowledgeBytes = dirSizeBytes(paths.getWikiDir()) + dirSizeBytes(paths.getRagDir());
  const listening = await probeListening(chatCfg.port);

  return {
    lastHeartbeatMs,
    chatBytes: chat.historyBytes(),
    knowledgeBytes,
    memberCount: accounts.list().length,
    channelCount: chat.listChannels().length,
    listening,
  };
}

function consoleUrlFor(bind: string, port: number): string {
  // 0.0.0.0(전체 인터페이스 바인드)은 그 자체로 접속 가능한 주소가 아니라 안내에는 부적절
  // — 로컬에서 관리자가 열어볼 수 있는 localhost로 바꿔 보여준다(admin-http buildPreset의
  // hostHint 관례와 같은 결: "접속 가능한 최선의 힌트"를 보여주는 것이 목적).
  const host = bind === '0.0.0.0' ? 'localhost' : bind;
  return `http://${host}:${port}/admin`;
}

// accounts.count()>0(owner 이미 있음)이면 코드를 만들지 않고 안내만(1회용 셋업 코드 재사용 방지
// — setup-code.ts의 계약과 동일: 첫 owner 생성 성공 시 clearSetupCode로 소멸).
export function runSetup(paths: PathResolver): SetupResult {
  const accounts = new AccountStore(paths.getStateDir());
  const chatCfg = loadChatConfig(paths.getConfigDir());
  const consoleUrl = consoleUrlFor(chatCfg.bind, chatCfg.port);
  if (accounts.count() > 0) {
    return { code: null, alreadyConfigured: true, consoleUrl };
  }
  return { code: ensureSetupCode(paths.getStateDir()), alreadyConfigured: false, consoleUrl };
}
