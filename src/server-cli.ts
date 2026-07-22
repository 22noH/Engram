#!/usr/bin/env node
import { PathResolver } from './pal/path-resolver';
import { runSetup, runStatus, type ServerStatus, type SetupResult } from './edge/server-admin';

// engram-server CLI 엔트리(S5 Task 1 — 스펙 §2.1). Nest 부트 없음(경량·빠른 시작) — 이 파일은
// argv 파싱과 사람이 읽는 출력 포맷만 맡는다. 실제 계산은 전부 edge/server-admin.ts의 순수
// 함수(스토어를 데이터 디렉터리에서 직접 구성)에 위임한다(house rule: 로직 중복 0).

export const KNOWN_COMMANDS = ['setup', 'status', 'user', 'group', 'config', 'preset', 'start', 'service'] as const;
export type KnownCommand = (typeof KNOWN_COMMANDS)[number];

// user/group/config/preset/start/service는 이 태스크의 범위 밖(S5 Task 2~4에서 구현) — help에는
// 나열하되 지금은 "아직 구현되지 않음" 안내만 하고 종료한다.
const IMPLEMENTED: ReadonlySet<string> = new Set(['setup', 'status']);

export const USAGE = `사용법: engram-server <command>

  setup                   1회용 셋업 코드 생성/표시(이미 관리자 계정이 있으면 안내만)
  status                  서버 상태(하트비트·용량·멤버/채널 수·포트 리슨 여부)
  user <...>              멤버 관리(승인·정지·비번 재설정) — 준비 중
  group <...>             그룹 관리(생성·삭제·권한) — 준비 중
  config <...>            서버 설정(포트·바인드·보존정책 등) — 준비 중
  preset <...>            클라이언트 배포용 preset.json 내보내기 — 준비 중
  start                   포그라운드로 데몬 실행 — 준비 중
  service <...>           윈도우 서비스 설치/제거/제어 — 준비 중
  --help, -h              이 도움말

데이터 디렉터리는 ENGRAM_DATA_DIR 환경변수(미설정 시 <실행 위치>/runtime)를 사용합니다.
`;

// argv[0]을 분류만 하는 순수 함수(테스트 용이성을 위해 IO/종료코드 결정과 분리).
export type CommandKind = 'known-implemented' | 'known-pending' | 'help' | 'unknown';

export function classifyCommand(cmd: string | undefined): CommandKind {
  if (cmd === undefined || cmd === '--help' || cmd === '-h') return 'help';
  if (!(KNOWN_COMMANDS as readonly string[]).includes(cmd)) return 'unknown';
  return IMPLEMENTED.has(cmd) ? 'known-implemented' : 'known-pending';
}

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return `${n} B`;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function formatStatus(s: ServerStatus): string {
  const hb = s.lastHeartbeatMs === null ? '없음(상주 미확인)' : new Date(s.lastHeartbeatMs).toLocaleString();
  return [
    `리슨 중: ${s.listening ? '예' : '아니오'}`,
    `마지막 하트비트: ${hb}`,
    `채팅 기록: ${humanBytes(s.chatBytes)}`,
    `지식(위키+RAG): ${humanBytes(s.knowledgeBytes)}`,
    `멤버: ${s.memberCount}명`,
    `채널: ${s.channelCount}개`,
    '',
  ].join('\n');
}

export function formatSetup(r: SetupResult): string {
  if (r.alreadyConfigured) {
    return `이미 설정 완료(관리자 계정이 있습니다). 콘솔: ${r.consoleUrl}\n`;
  }
  return [
    `셋업 코드: ${r.code}`,
    `콘솔에서 이 코드로 관리자 계정을 만드세요: ${r.consoleUrl}`,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const [cmd] = process.argv.slice(2);
  const kind = classifyCommand(cmd);
  const paths = new PathResolver();

  switch (kind) {
    case 'help':
      process.stdout.write(USAGE);
      return;
    case 'unknown':
      process.stderr.write(`알 수 없는 명령: ${cmd}\n\n${USAGE}`);
      process.exitCode = 1;
      return;
    case 'known-pending':
      process.stdout.write(`'${cmd}' 명령은 아직 구현되지 않았습니다(다음 작업에서 추가 예정).\n`);
      process.exitCode = 1;
      return;
    case 'known-implemented':
      break;
  }

  if (cmd === 'status') {
    process.stdout.write(formatStatus(await runStatus(paths)));
  } else if (cmd === 'setup') {
    process.stdout.write(formatSetup(runSetup(paths)));
  }
}

// require.main 가드: 이 모듈이 import될 때(예: server-cli.spec.ts에서 classifyCommand 등 순수
// 함수만 쓰려고 import) main()이 부작용(실 데이터 디렉터리 접근·TCP 프로브·stdout 출력)을 내며
// 즉시 실행되지 않게 한다 — 직접 실행(`node dist/src/server-cli.js`)될 때만 발화.
if (require.main === module) {
  void main();
}
