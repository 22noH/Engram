#!/usr/bin/env node
import { PathResolver } from './pal/path-resolver';
import {
  CONFIG_KEYS, runConfigGet, runConfigSet, runGroupCreate, runGroupDelete, runGroupList,
  runGroupSetChannels, runGroupSetPerms, runPresetExport, runSetup, runStatus, runUserActivate, runUserApprove,
  runUserList, runUserResetPassword, runUserSuspend,
  type ActionResult, type ConfigKey, type ConfigSetResult, type ConfigView, type Group,
  type PresetExportResult, type ServerStatus, type SetupResult, type UserListItem, type UserResetResult,
} from './edge/server-admin';

// engram-server CLI 엔트리(S5 Task 1~2 — 스펙 §2.1). Nest 부트 없음(경량·빠른 시작) — 이 파일은
// argv 파싱과 사람이 읽는 출력 포맷만 맡는다. 실제 계산은 전부 edge/server-admin.ts의 순수
// 함수(스토어를 데이터 디렉터리에서 직접 구성)에 위임한다(house rule: 로직 중복 0).

export const KNOWN_COMMANDS = ['setup', 'status', 'user', 'group', 'config', 'preset', 'start', 'service'] as const;
export type KnownCommand = (typeof KNOWN_COMMANDS)[number];

// start/service는 이 태스크의 범위 밖(S5 Task 3에서 구현) — help에는 나열하되 지금은
// "아직 구현되지 않음" 안내만 하고 종료한다. user/group/config/preset은 Task 2에서 구현됨.
const IMPLEMENTED: ReadonlySet<string> = new Set(['setup', 'status', 'user', 'group', 'config', 'preset']);

const USER_USAGE = `사용법: engram-server user <list|approve|activate|suspend|reset-password> [id]
  user list                       계정 표(id·loginId·displayName·role·status)
  user approve <id>               pending 계정을 active로 승인
  user activate <id>              정지(suspended)/대기(pending) 계정을 active로 되돌림
  user suspend <id>                계정을 suspended로 전환
  user reset-password <id>        임시 비밀번호 발급(화면에 출력)
`;

const GROUP_USAGE = `사용법: engram-server group <list|create|delete|set-perms|set-channels> [args]
  group list                              그룹 표
  group create <name>                     그룹 생성
  group delete <id>                       그룹 삭제
  group set-perms <id> <perm,perm,...>    권한 설정(전체 교체, 화이트리스트 밖은 거부)
  group set-channels <id> <chId,chId,...> 채널 접근 설정(전체 교체)
`;

const CONFIG_USAGE = `사용법: engram-server config <get|set> [key] [value]
  config get [key]                 현재 설정 조회(key 생략 시 전체) — port/bind/retention/autoCompact/coding
  config set <key> <value>         설정 변경
    config set port <1-65535>
    config set bind <127.0.0.1|0.0.0.0>
    config set retention <count:N|days:N|unlimited>
    config set autoCompact <true|false>
    config set coding <auto|allowlist|off>
`;

const PRESET_USAGE = `사용법: engram-server preset export [path]
  preset export [path]             클라이언트 배포용 preset.json 내보내기(path 생략 시 configDir/preset.json)
`;

export const USAGE = `사용법: engram-server <command>

  setup                   1회용 셋업 코드 생성/표시(이미 관리자 계정이 있으면 안내만)
  status                  서버 상태(하트비트·용량·멤버/채널 수·포트 리슨 여부)
  user <...>              멤버 관리(승인·정지·비번 재설정)
  group <...>             그룹 관리(생성·삭제·권한·채널)
  config <...>            서버 설정(포트·바인드·보존정책·자동요약·코딩모드)
  preset <...>            클라이언트 배포용 preset.json 내보내기
  start                   포그라운드로 데몬 실행 — 준비 중
  service <...>           윈도우 서비스 설치/제거/제어 — 준비 중
  --help, -h              이 도움말

각 명령의 하위 사용법은 인자 없이 실행하면 안내됩니다(예: \`engram-server user\`).
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

// ── S5 Task 2: user·group·config·preset — 출력 포맷(순수) + argv 서브디스패치 ──────────────

function formatActionResult(r: ActionResult): string {
  return `${r.message}\n`;
}

export function formatUserList(items: UserListItem[]): string {
  if (items.length === 0) return '등록된 계정이 없습니다.\n';
  const rows = items.map((a) => `${a.id}\t${a.loginId}\t${a.displayName}\t${a.role}\t${a.status}`);
  return ['id\tloginId\tdisplayName\trole\tstatus', ...rows, ''].join('\n');
}

export function formatUserReset(r: UserResetResult): string {
  if (!r.ok) return `${r.message}\n`;
  return `${r.message}\n임시 비밀번호: ${r.tempPassword}\n`;
}

export function formatGroupList(groups: Group[]): string {
  if (groups.length === 0) return '등록된 그룹이 없습니다.\n';
  const rows = groups.map((g) =>
    `${g.id}\t${g.name}\t멤버 ${g.memberIds.length}명\t권한 [${g.permissions.join(', ')}]\t채널 ${g.channelIds.length}개`);
  return ['id\tname\tmembers\tpermissions\tchannels', ...rows, ''].join('\n');
}

// key 생략 시 전체 표시, 지정 시 그 한 줄만(브리프: `config get [key]`). 유효하지 않은 key는
// 호출부(handleConfig)가 CONFIG_KEYS로 미리 걸러 여기 도달하기 전에 exitCode 1로 처리한다.
function configEntries(c: ConfigView): Record<ConfigKey, string> {
  return {
    port: String(c.port),
    bind: c.bind,
    retention: c.retention.mode === 'unlimited' ? 'unlimited' : `${c.retention.mode}:${c.retention.value}`,
    autoCompact: String(c.autoCompact),
    coding: c.codingMode,
  };
}

export function formatConfigView(c: ConfigView, key?: string): string {
  const all = configEntries(c);
  if (key) return `${key}: ${all[key as ConfigKey]}\n`;
  return Object.entries(all).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n';
}

function formatConfigSetResult(r: ConfigSetResult): string {
  const note = r.ok && r.appliesAfterRestart ? ' (서버 재시작 후 적용됩니다)' : '';
  return `${r.message}${note}\n`;
}

export function formatPresetExport(r: PresetExportResult): string {
  return `preset 저장됨: ${r.path}\nname: ${r.preset.name}\nendpoint: ${r.preset.endpoint}\n`;
}

function splitCsv(s: string): string[] {
  return s.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
}

export interface DispatchResult { output: string; exitCode: number; }

export function handleUser(args: string[], paths: PathResolver): DispatchResult {
  const [sub, id] = args;
  if (sub === 'list') return { output: formatUserList(runUserList(paths)), exitCode: 0 };
  if (sub === 'approve' || sub === 'activate' || sub === 'suspend' || sub === 'reset-password') {
    if (!id) return { output: `id를 지정하세요.\n\n${USER_USAGE}`, exitCode: 1 };
    if (sub === 'reset-password') {
      const r = runUserResetPassword(paths, id);
      return { output: formatUserReset(r), exitCode: r.ok ? 0 : 1 };
    }
    const r = sub === 'approve' ? runUserApprove(paths, id)
      : sub === 'activate' ? runUserActivate(paths, id)
        : runUserSuspend(paths, id);
    return { output: formatActionResult(r), exitCode: r.ok ? 0 : 1 };
  }
  return { output: `알 수 없는 하위 명령: ${sub ?? '(없음)'}\n\n${USER_USAGE}`, exitCode: 1 };
}

export function handleGroup(args: string[], paths: PathResolver): DispatchResult {
  const [sub, ...rest] = args;
  if (sub === 'list') return { output: formatGroupList(runGroupList(paths)), exitCode: 0 };
  if (sub === 'create') {
    const name = rest.join(' ').trim();
    if (!name) return { output: `그룹 이름을 지정하세요.\n\n${GROUP_USAGE}`, exitCode: 1 };
    const r = runGroupCreate(paths, name);
    return { output: formatActionResult(r), exitCode: r.ok ? 0 : 1 };
  }
  if (sub === 'delete') {
    const [id] = rest;
    if (!id) return { output: `id를 지정하세요.\n\n${GROUP_USAGE}`, exitCode: 1 };
    const r = runGroupDelete(paths, id);
    return { output: formatActionResult(r), exitCode: r.ok ? 0 : 1 };
  }
  if (sub === 'set-perms') {
    const [id, permsCsv] = rest;
    if (!id || permsCsv === undefined) return { output: `사용법: group set-perms <id> <perm,perm,...>\n\n${GROUP_USAGE}`, exitCode: 1 };
    const r = runGroupSetPerms(paths, id, splitCsv(permsCsv));
    return { output: formatActionResult(r), exitCode: r.ok ? 0 : 1 };
  }
  if (sub === 'set-channels') {
    const [id, idsCsv] = rest;
    if (!id || idsCsv === undefined) return { output: `사용법: group set-channels <id> <chId,chId,...>\n\n${GROUP_USAGE}`, exitCode: 1 };
    const r = runGroupSetChannels(paths, id, splitCsv(idsCsv));
    return { output: formatActionResult(r), exitCode: r.ok ? 0 : 1 };
  }
  return { output: `알 수 없는 하위 명령: ${sub ?? '(없음)'}\n\n${GROUP_USAGE}`, exitCode: 1 };
}

export function handleConfig(args: string[], paths: PathResolver): DispatchResult {
  const [sub, ...rest] = args;
  if (sub === 'get') {
    const [key] = rest;
    if (key !== undefined && !(CONFIG_KEYS as readonly string[]).includes(key)) {
      return { output: `알 수 없는 키: ${key}(${CONFIG_KEYS.join('/')})\n`, exitCode: 1 };
    }
    return { output: formatConfigView(runConfigGet(paths), key), exitCode: 0 };
  }
  if (sub === 'set') {
    const [key, value] = rest;
    if (!key || value === undefined) return { output: `사용법: config set <key> <value>\n\n${CONFIG_USAGE}`, exitCode: 1 };
    const r = runConfigSet(paths, key, value);
    return { output: formatConfigSetResult(r), exitCode: r.ok ? 0 : 1 };
  }
  return { output: `알 수 없는 하위 명령: ${sub ?? '(없음)'}\n\n${CONFIG_USAGE}`, exitCode: 1 };
}

export function handlePreset(args: string[], paths: PathResolver): DispatchResult {
  const [sub, outPath] = args;
  if (sub === 'export') {
    const r = runPresetExport(paths, outPath);
    return { output: formatPresetExport(r), exitCode: 0 };
  }
  return { output: `알 수 없는 하위 명령: ${sub ?? '(없음)'}\n\n${PRESET_USAGE}`, exitCode: 1 };
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

  const argRest = process.argv.slice(3);
  let result: DispatchResult | undefined;

  if (cmd === 'status') {
    process.stdout.write(formatStatus(await runStatus(paths)));
  } else if (cmd === 'setup') {
    process.stdout.write(formatSetup(runSetup(paths)));
  } else if (cmd === 'user') {
    result = handleUser(argRest, paths);
  } else if (cmd === 'group') {
    result = handleGroup(argRest, paths);
  } else if (cmd === 'config') {
    result = handleConfig(argRest, paths);
  } else if (cmd === 'preset') {
    result = handlePreset(argRest, paths);
  }

  if (result) {
    process.stdout.write(result.output);
    process.exitCode = result.exitCode;
  }
}

// require.main 가드: 이 모듈이 import될 때(예: server-cli.spec.ts에서 classifyCommand 등 순수
// 함수만 쓰려고 import) main()이 부작용(실 데이터 디렉터리 접근·TCP 프로브·stdout 출력)을 내며
// 즉시 실행되지 않게 한다 — 직접 실행(`node dist/src/server-cli.js`)될 때만 발화.
if (require.main === module) {
  void main();
}
