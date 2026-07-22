import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { PathResolver } from '../pal/path-resolver';
import { getCommandMode, setCommandMode, type CommandMode } from '../desktop/permissions-file';
import { buildPreset, writePresetFile, type PresetInfo } from '../desktop/preset-file';
import { AccountStore, type Account, type AccountRole, type AccountStatus } from './auth/account-store';
import { ensureSetupCode } from './auth/setup-code';
import { GroupStore, type Group } from './auth/group-store';
export type { Group } from './auth/group-store';
import { isPermission } from './auth/permissions';
import { ChatStore, type RetentionPolicy } from './messenger/chat-store';
import { loadChatConfig, saveChatBootConfig } from './messenger/chat.config';

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

// 그 host:port에 TCP 접속을 시도해 "지금 뭔가 리슨 중인가"만 확인한다(누가·무엇인지는 판별하지
// 않음 — 로컬 CLI에서 흔한 관용, admin-http 헬스체크와 동일 결). 짧은 타임아웃으로 접속 거부/무응답을
// 빠르게 false로 접는다(CLI가 멈춰 보이면 안 됨). host는 실제 bind를 향한다(0.0.0.0=루프백 포함).
function probeListening(port: number, host = '127.0.0.1', timeoutMs = 300): Promise<boolean> {
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
    socket.connect(port, host);
  });
}

// admin-http.ts:956 getStatus와 동일 계산(heartbeat 파일·dirSize·historyBytes·counts) + 리슨 여부.
// uptimeSec은 넣지 않는다 — CLI는 매번 새 프로세스라 process.uptime()이 무의미(브리프 지시).
// 대신 lastHeartbeatMs(상주 프로세스가 60초마다 갱신하는 파일)로 "최근에 살아있었나"를 본다.
export async function runStatus(paths: PathResolver): Promise<ServerStatus> {
  const accounts = new AccountStore(paths.getStateDir());
  const chatCfg = loadChatConfig(paths.getConfigDir());
  // ★readOnly: true(리뷰 지적) — 이 CLI는 실행 중 서버와 데이터 폴더를 공유하므로, ChatStore 생성자의 잔여
  // .cleared 정리가 서버의 /clear 되돌리기 백업을 지우면 안 된다. status는 읽기 전용이어야 한다.
  const chat = new ChatStore(path.join(paths.getStateDir(), 'chat'), chatCfg.retention, { readOnly: true });

  let lastHeartbeatMs: number | null = null;
  try {
    const raw = fs.readFileSync(paths.getHeartbeatPath(), 'utf8').trim();
    const n = Number(raw);
    if (Number.isFinite(n)) lastHeartbeatMs = n;
  } catch { /* 파일 없음(상주 미가동/최초 부팅 전) — null 유지 */ }

  const knowledgeBytes = dirSizeBytes(paths.getWikiDir()) + dirSizeBytes(paths.getRagDir());
  // 리슨 프로브는 실제 bind를 향한다(리뷰 지적: 127.0.0.1 하드코딩은 특정 IP 바인드 시 오탐).
  // 0.0.0.0(전 인터페이스)은 루프백도 포함하므로 127.0.0.1로 접속(가장 확실). 그 외는 설정된 bind로.
  const probeHost = (!chatCfg.bind || chatCfg.bind === '0.0.0.0') ? '127.0.0.1' : chatCfg.bind;
  const listening = await probeListening(chatCfg.port, probeHost);

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

// ── S5 Task 2: user·group·config·preset(웹 콘솔 admin-http.ts와 동일 스토어/검증 로직 재사용) ──
// 아래 함수는 전부 순수(스토어를 데이터 디렉터리에서 직접 구성, process.exit·console 없음) —
// server-cli.ts가 argv 파싱과 사람이 읽는 출력/종료코드를 맡는다(house rule).

// user approve/suspend·group create/delete/set-perms/set-channels가 공유하는 결과 셰이프.
// ok=false면 message가 사람이 읽을 이유(없는 id·잘못된 권한 등) — CLI는 이걸로 exitCode를 정한다.
export interface ActionResult {
  ok: boolean;
  message: string;
}

// ── user ──────────────────────────────────────────────────────────────────────────────────

export interface UserListItem {
  id: string;
  loginId: string;
  displayName: string;
  role: AccountRole;
  status: AccountStatus;
}

function toListItem(a: Account): UserListItem {
  return { id: a.id, loginId: a.loginId, displayName: a.displayName, role: a.role, status: a.status };
}

export function runUserList(paths: PathResolver): UserListItem[] {
  return new AccountStore(paths.getStateDir()).list().map(toListItem);
}

// pending만 승인 대상(브리프 명시) — active/suspended에 approve를 걸면 조용히 덮어쓰는 대신
// 상태를 그대로 알려준다(사용자가 실수로 이미 활성인 계정을 다시 승인하려는 걸 표면화).
export function runUserApprove(paths: PathResolver, id: string): ActionResult {
  const accounts = new AccountStore(paths.getStateDir());
  const a = accounts.get(id);
  if (!a) return { ok: false, message: `계정을 찾을 수 없습니다: ${id}` };
  if (a.status !== 'pending') return { ok: false, message: `승인 대상이 아닙니다(현재 상태: ${a.status}) — pending 계정만 승인할 수 있습니다.` };
  accounts.setStatus(id, 'active');
  return { ok: true, message: `승인됨: ${a.loginId}(${a.displayName})` };
}

export function runUserSuspend(paths: PathResolver, id: string): ActionResult {
  const accounts = new AccountStore(paths.getStateDir());
  const a = accounts.get(id);
  if (!a) return { ok: false, message: `계정을 찾을 수 없습니다: ${id}` };
  accounts.setStatus(id, 'suspended');
  return { ok: true, message: `정지됨: ${a.loginId}(${a.displayName})` };
}

// admin-http.ts:81 generateTempPassword와 동일(복제 — CLI가 admin-http.ts 전체를 의존하기엔
// 무거워 dirSizeBytes와 같은 결로 이 작은 계약만 재현). base64url(7바이트)=10자 고정폭.
function generateTempPassword(): string {
  return randomBytes(7).toString('base64url');
}

export interface UserResetResult extends ActionResult {
  tempPassword?: string; // ok=true일 때만 존재 — CLI는 이 값을 화면에 그대로 찍어 owner에게 전달한다.
}

export function runUserResetPassword(paths: PathResolver, id: string): UserResetResult {
  const accounts = new AccountStore(paths.getStateDir());
  const a = accounts.get(id);
  if (!a) return { ok: false, message: `계정을 찾을 수 없습니다: ${id}` };
  const tempPassword = generateTempPassword();
  accounts.setPassword(id, tempPassword);
  return { ok: true, message: `임시 비밀번호가 발급되었습니다: ${a.loginId}(${a.displayName})`, tempPassword };
}

// ── group ─────────────────────────────────────────────────────────────────────────────────

export function runGroupList(paths: PathResolver): Group[] {
  return new GroupStore(paths.getStateDir()).list();
}

export interface GroupCreateResult extends ActionResult {
  group?: Group;
}

export function runGroupCreate(paths: PathResolver, name: string): GroupCreateResult {
  const groups = new GroupStore(paths.getStateDir());
  try {
    const g = groups.create(name);
    return { ok: true, message: `그룹 생성됨: ${g.name}(${g.id})`, group: g };
  } catch (e) {
    // GroupStore.create는 빈 이름·예약어를 throw(house rule) — CLI 계약은 throw 없는 결과 객체라 여기서 흡수.
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export function runGroupDelete(paths: PathResolver, id: string): ActionResult {
  const groups = new GroupStore(paths.getStateDir());
  const g = groups.get(id);
  if (!g) return { ok: false, message: `그룹을 찾을 수 없습니다: ${id}` };
  groups.remove(id);
  return { ok: true, message: `그룹 삭제됨: ${g.name}` };
}

// 잘못된 권한이 하나라도 섞이면 전부 거부(부분 적용 없음 — 브리프: "잘못된 perm은 거부").
// GroupStore.setPermissions 자체는 sanitizePermissions로 조용히 걸러내지만(house rule 방어적
// 소독), CLI는 그보다 엄격해야 한다 — 오타를 조용히 무시하면 사용자가 권한이 실제로 걸렸다고
// 착각할 수 있어 명시적 에러로 표면화한다.
export function runGroupSetPerms(paths: PathResolver, id: string, perms: string[]): ActionResult {
  const groups = new GroupStore(paths.getStateDir());
  const g = groups.get(id);
  if (!g) return { ok: false, message: `그룹을 찾을 수 없습니다: ${id}` };
  const invalid = perms.filter((p) => !isPermission(p));
  if (invalid.length > 0) {
    return { ok: false, message: `알 수 없는 권한: ${invalid.join(', ')}(허용: wiki.approve, channels.manage, wiki.unpublish, wiki.edit, wiki.delete)` };
  }
  groups.setPermissions(id, perms);
  return { ok: true, message: `권한 설정됨: ${perms.length > 0 ? perms.join(', ') : '(없음)'}` };
}

export function runGroupSetChannels(paths: PathResolver, id: string, channelIds: string[]): ActionResult {
  const groups = new GroupStore(paths.getStateDir());
  const g = groups.get(id);
  if (!g) return { ok: false, message: `그룹을 찾을 수 없습니다: ${id}` };
  groups.setChannels(id, channelIds);
  return { ok: true, message: `채널 설정됨: ${channelIds.length}개` };
}

// ── config ────────────────────────────────────────────────────────────────────────────────

export interface ConfigView {
  port: number;
  bind: string;
  retention: RetentionPolicy;
  autoCompact: boolean;
  codingMode: CommandMode;
}

// admin-http.ts:797,800 getServerSettings와 동일한 기본값 결(retention 미저장=unlimited,
// autoCompact 미저장=true) — 콘솔에서 보는 값과 CLI에서 보는 값이 어긋나지 않게 한다.
export function runConfigGet(paths: PathResolver): ConfigView {
  const configDir = paths.getConfigDir();
  const chatCfg = loadChatConfig(configDir);
  return {
    port: chatCfg.port,
    bind: chatCfg.bind,
    retention: chatCfg.retention ?? { mode: 'unlimited' },
    autoCompact: chatCfg.autoCompact ?? true,
    codingMode: getCommandMode(configDir),
  };
}

// "count:1000" / "days:90" / "unlimited" 파싱(브리프 명시 문법). admin-http.ts:855-873
// saveServerSettings의 retention 검증과 동일 규칙(count=양의 정수·days=양수)을 문자열 파싱에 적용.
function parseRetentionArg(value: string): RetentionPolicy | null {
  if (value === 'unlimited') return { mode: 'unlimited' };
  const m = /^(count|days):(.+)$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[2]);
  if (m[1] === 'count') {
    return Number.isInteger(n) && n > 0 ? { mode: 'count', value: n } : null;
  }
  return Number.isFinite(n) && n > 0 ? { mode: 'days', value: n } : null;
}

function describeRetention(r: RetentionPolicy): string {
  if (r.mode === 'unlimited') return 'unlimited';
  return `${r.mode}:${r.value}`;
}

export const CONFIG_KEYS = ['port', 'bind', 'retention', 'autoCompact', 'coding'] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export interface ConfigSetResult extends ActionResult {
  // 데몬은 부팅 시 이 값들을 chat.json/permissions.json에서 한 번만 읽으므로(server-admin은
  // 별도 프로세스라 실행 중인 서버의 메모리를 직접 건드릴 수 없다), port/bind/retention/
  // autoCompact는 전부 재시작 후 적용된다. coding(permissions.json의 commandMode)만 예외 —
  // 코딩 게이트는 명령 실행 시점마다 파일을 새로 읽어(getCommandMode 호출부 참고) 즉시 반영된다.
  appliesAfterRestart: boolean;
}

// admin-http.ts:820-893 saveServerSettings의 키별 검증(port 1~65535 정수·bind 화이트리스트
// 127.0.0.1/0.0.0.0·retention count/days 양수/unlimited·autoCompact boolean·codingMode
// auto/allowlist/off)을 CLI 문자열 입력에 그대로 적용 — 로직 중복 없이 규칙만 재현한다.
export function runConfigSet(paths: PathResolver, key: string, value: string): ConfigSetResult {
  const configDir = paths.getConfigDir();
  switch (key as ConfigKey) {
    case 'port': {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) {
        return { ok: false, message: `잘못된 포트: ${value}(1~65535 사이 정수)`, appliesAfterRestart: false };
      }
      saveChatBootConfig(configDir, { port: n });
      return { ok: true, message: `포트 저장됨: ${n}`, appliesAfterRestart: true };
    }
    case 'bind': {
      if (value !== '127.0.0.1' && value !== '0.0.0.0') {
        return { ok: false, message: `잘못된 bind: ${value}(127.0.0.1 또는 0.0.0.0만 허용)`, appliesAfterRestart: false };
      }
      saveChatBootConfig(configDir, { bind: value });
      return { ok: true, message: `bind 저장됨: ${value}`, appliesAfterRestart: true };
    }
    case 'retention': {
      const parsed = parseRetentionArg(value);
      if (!parsed) {
        return { ok: false, message: `잘못된 retention: ${value}(예: count:1000 / days:90 / unlimited)`, appliesAfterRestart: false };
      }
      saveChatBootConfig(configDir, { retention: parsed });
      return { ok: true, message: `보존 정책 저장됨: ${describeRetention(parsed)}`, appliesAfterRestart: true };
    }
    case 'autoCompact': {
      if (value !== 'true' && value !== 'false') {
        return { ok: false, message: `잘못된 값: ${value}(true 또는 false)`, appliesAfterRestart: false };
      }
      saveChatBootConfig(configDir, { autoCompact: value === 'true' });
      return { ok: true, message: `자동 요약(autoCompact) 저장됨: ${value}`, appliesAfterRestart: true };
    }
    case 'coding': {
      if (value !== 'auto' && value !== 'allowlist' && value !== 'off') {
        return { ok: false, message: `잘못된 값: ${value}(auto/allowlist/off)`, appliesAfterRestart: false };
      }
      setCommandMode(configDir, value);
      return { ok: true, message: `코딩 모드 저장됨: ${value}`, appliesAfterRestart: false };
    }
    default:
      return { ok: false, message: `알 수 없는 키: ${key}(port/bind/retention/autoCompact/coding)`, appliesAfterRestart: false };
  }
}

// ── preset ────────────────────────────────────────────────────────────────────────────────

export interface PresetExportResult {
  ok: boolean;
  message: string;
  path: string;
  preset: PresetInfo;
}

// buildPreset+writePresetFile(desktop/preset-file.ts) 재사용 — admin-http.ts:927-932 getPreset과
// 동일 계산(hostHint 없음: CLI는 요청 Host 헤더가 없어 bind=0.0.0.0이면 플레이스홀더로 남는다).
// outPath가 주어지면 그 경로에 직접 쓰고(사용자가 지정한 배포 위치), 아니면 configDir/preset.json
// (writePresetFile 기본 계약 — desktop/main.ts 부팅 시 자동 인식되는 그 파일).
export function runPresetExport(paths: PathResolver, outPath?: string): PresetExportResult {
  const configDir = paths.getConfigDir();
  const chatCfg = loadChatConfig(configDir);
  const preset = buildPreset(configDir, { bind: chatCfg.bind, port: chatCfg.port });
  let targetFile: string;
  if (outPath) {
    targetFile = path.resolve(outPath);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, JSON.stringify(preset, null, 2));
  } else {
    targetFile = path.join(configDir, 'preset.json');
    writePresetFile(configDir, preset);
  }
  return { ok: true, message: `preset.json 저장됨: ${targetFile}`, path: targetFile, preset };
}
