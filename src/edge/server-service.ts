import * as path from 'path';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { PathResolver } from '../pal/path-resolver';
import { findRepoRoot } from '../pal/repo-root';
import { createSupervisor as realCreateSupervisor } from '../pal/supervisor/supervisor.factory';
import type { ServiceSpec, ServiceStatus, SupervisorPort } from '../pal/supervisor/supervisor.port';
import { loadChatConfig as realLoadChatConfig } from './messenger/chat.config';

// S5 Task 3: 윈도우 서비스 설치/제거(supervisor.factory 재사용) + 방화벽 규칙(netsh) + 포그라운드
// start. 전부 순수 로직 + 의존성 주입(house rule) — server-cli.ts는 argv 파싱/출력 포맷만 맡는다.
// 참고(수정 안 함): supervisor.factory.ts(createSupervisor)·windows-supervisor.ts·supervisor.port.ts·
// cli.gateway.ts:148-166(데스크톱 'Engram' 서비스의 기존 service 패턴 — 이 파일은 그 서버 판).

export const SERVICE_NAME = 'EngramServer'; // 데스크톱 서비스 이름 'Engram'(cli.gateway.ts)과 구분
export const FIREWALL_RULE_NAME = SERVICE_NAME;

export const NON_WINDOWS_GUIDANCE =
  "'service' 명령은 윈도우 전용입니다 — 도커(compose)나 `engram-server start`(수동/systemd)를 사용하세요.\n";

const ADMIN_HINT = '관리자 권한이 필요할 수 있습니다 — 관리자 PowerShell에서 다시 실행하세요.';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── ServiceSpec 조립 ──────────────────────────────────────────────────────────────────────
// 데스크톱의 buildServiceSpecs(상주+watchdog 두 개)와 달리 서버 에디션은 상주 하나만 관리한다
// (watchdog은 데스크톱 자기수정 전용 — 서버 에디션 스펙 범위 밖, docs/superpowers/specs/
// 2026-07-22-server-edition-s5-design.md 참고).

export function buildServerServiceSpec(repoRoot: string, dataDir: string): ServiceSpec {
  return { name: SERVICE_NAME, scriptPath: path.join(repoRoot, 'dist', 'src', 'main.js'), dataDir };
}

// ── netsh(방화벽) ─────────────────────────────────────────────────────────────────────────
// child_process.execFile을 감싸는 러너로 주입 가능하게 한다(테스트는 fake로 호출 인자 검증·실패 모사).

export type NetshRunner = (args: string[]) => Promise<unknown>;

const execFileAsync = promisify(execFile);
export const realNetshRunner: NetshRunner = (args) => execFileAsync('netsh', args);

export interface ServiceResult {
  ok: boolean;
  message: string;
  status?: ServiceStatus; // serviceControl('status')일 때만 채워짐
}

function firewallAddArgs(port: number, ruleName: string): string[] {
  return ['advfirewall', 'firewall', 'add', 'rule', `name=${ruleName}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${port}`];
}

function firewallDeleteArgs(ruleName: string): string[] {
  return ['advfirewall', 'firewall', 'delete', 'rule', `name=${ruleName}`];
}

export async function addFirewallRule(runNetsh: NetshRunner, port: number, ruleName: string = FIREWALL_RULE_NAME): Promise<ServiceResult> {
  try {
    await runNetsh(firewallAddArgs(port, ruleName));
    return { ok: true, message: `방화벽 규칙 추가됨(${ruleName}, TCP ${port} 인바운드 허용)` };
  } catch (e) {
    return { ok: false, message: `방화벽 규칙 추가 실패: ${errMsg(e)} — ${ADMIN_HINT}` };
  }
}

// delete는 규칙이 이미 없어도 무해(브리프 명시) — netsh가 실패해도 ok:true로 흡수해 uninstall의
// 멱등성을 보장한다("관리자 아니라 실패"인지 "애초에 규칙이 없어 실패"인지는 netsh 텍스트로 신뢰성
// 있게 구분할 수 없어 — 제거 방향은 실패해도 항상 진행 취급이 더 안전한 결).
export async function removeFirewallRule(runNetsh: NetshRunner, ruleName: string = FIREWALL_RULE_NAME): Promise<ServiceResult> {
  try {
    await runNetsh(firewallDeleteArgs(ruleName));
    return { ok: true, message: `방화벽 규칙 제거됨(${ruleName})` };
  } catch {
    return { ok: true, message: `방화벽 규칙 제거 시도됨(이미 없었을 수 있음, ${ruleName})` };
  }
}

// ── install/uninstall/제어 ────────────────────────────────────────────────────────────────

export interface ServiceDeps {
  platform: NodeJS.Platform;
  paths: PathResolver;
  repoRoot: string;
  createSupervisor: (platform: NodeJS.Platform, spec: ServiceSpec) => SupervisorPort;
  runNetsh: NetshRunner;
  loadChatConfig: (configDir: string) => { port: number };
}

// 프로덕션 배선(server-cli.ts가 호출) — 실 supervisor·실 netsh·실 chat.config. 테스트는 이걸
// 쓰지 않고 ServiceDeps를 직접 구성해 fake를 주입한다.
export function buildServiceDeps(paths: PathResolver): ServiceDeps {
  return {
    platform: process.platform,
    paths,
    repoRoot: findRepoRoot(__dirname),
    createSupervisor: realCreateSupervisor,
    runNetsh: realNetshRunner,
    loadChatConfig: realLoadChatConfig,
  };
}

function spec(deps: ServiceDeps): ServiceSpec {
  return buildServerServiceSpec(deps.repoRoot, deps.paths.getDataDir());
}

export async function installService(deps: ServiceDeps): Promise<ServiceResult> {
  if (deps.platform !== 'win32') return { ok: false, message: NON_WINDOWS_GUIDANCE };
  const supervisor = deps.createSupervisor(deps.platform, spec(deps));
  try {
    await supervisor.install();
  } catch (e) {
    return { ok: false, message: `서비스 설치 실패: ${errMsg(e)} — ${ADMIN_HINT}` };
  }
  const port = deps.loadChatConfig(deps.paths.getConfigDir()).port;
  const fw = await addFirewallRule(deps.runNetsh, port);
  return { ok: true, message: `서비스(${SERVICE_NAME}) 설치 완료. ${fw.message}` };
}

export async function uninstallService(deps: ServiceDeps): Promise<ServiceResult> {
  if (deps.platform !== 'win32') return { ok: false, message: NON_WINDOWS_GUIDANCE };
  const supervisor = deps.createSupervisor(deps.platform, spec(deps));
  try {
    await supervisor.uninstall();
  } catch (e) {
    return { ok: false, message: `서비스 제거 실패: ${errMsg(e)} — ${ADMIN_HINT}` };
  }
  const fw = await removeFirewallRule(deps.runNetsh);
  return { ok: true, message: `서비스(${SERVICE_NAME}) 제거 완료. ${fw.message}` };
}

const VERB_LABEL: Record<'start' | 'stop', string> = { start: '시작됨', stop: '중지됨' };

export async function serviceControl(verb: 'start' | 'stop' | 'status', deps: ServiceDeps): Promise<ServiceResult> {
  if (deps.platform !== 'win32') return { ok: false, message: NON_WINDOWS_GUIDANCE };
  const supervisor = deps.createSupervisor(deps.platform, spec(deps));
  try {
    if (verb === 'status') {
      const status = await supervisor.status();
      return { ok: true, message: `${SERVICE_NAME} 상태: ${status}`, status };
    }
    await supervisor[verb]();
    return { ok: true, message: `${SERVICE_NAME} ${VERB_LABEL[verb]}` };
  } catch (e) {
    return { ok: false, message: `${SERVICE_NAME} ${verb} 실패: ${errMsg(e)}` };
  }
}

// ── start(포그라운드) ─────────────────────────────────────────────────────────────────────
// main.ts는 require.main 가드 없이 require 시점에 곧바로 bootstrap()을 발화한다 — 그래서 같은
// 프로세스에서 import하는 대신 별도 자식 프로세스로 spawn한다(사고 방지: 같은 프로세스에서 두 번
// 뜨는 일이 없고, 종료코드도 그대로 전파돼 도커 CMD·systemd ExecStart로 그대로 쓸 수 있다).

export type SpawnFn = (execPath: string, args: string[], options: { stdio: 'inherit'; env: NodeJS.ProcessEnv }) => ChildProcess;

export interface ForegroundDeps {
  paths: PathResolver;
  repoRoot: string;
  spawnFn: SpawnFn;
  env: NodeJS.ProcessEnv;
}

export function buildForegroundDeps(paths: PathResolver): ForegroundDeps {
  return { paths, repoRoot: findRepoRoot(__dirname), spawnFn: spawn as unknown as SpawnFn, env: process.env };
}

export function runForeground(deps: ForegroundDeps): Promise<number> {
  const mainScript = path.join(deps.repoRoot, 'dist', 'src', 'main.js');
  return new Promise((resolve) => {
    const child = deps.spawnFn(process.execPath, [mainScript], {
      stdio: 'inherit',
      env: { ...deps.env, ENGRAM_DATA_DIR: deps.paths.getDataDir() },
    });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', () => resolve(1)); // spawn 자체 실패(예: node 실행 파일 없음) — 크래시 대신 실패 종료코드
  });
}
