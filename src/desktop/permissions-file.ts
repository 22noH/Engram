import * as fs from 'fs';
import * as path from 'path';

export type CommandMode = 'auto' | 'allowlist' | 'off';

// permissions.json의 allow.commandMode 읽기(없거나 깨짐 → 'auto').
export function getCommandMode(configDir: string): CommandMode {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'permissions.json'), 'utf8'));
    const m = raw?.allow?.commandMode;
    return m === 'allowlist' || m === 'off' ? m : 'auto';
  } catch {
    return 'auto';
  }
}

// allow.commandMode 부분 갱신(다른 필드 보존, 골격 없으면 생성).
export function setCommandMode(configDir: string, mode: CommandMode): void {
  const file = path.join(configDir, 'permissions.json');
  let cfg: { default: string; allow: Record<string, unknown> } = { default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') cfg = raw;
  } catch {
    // 없거나 깨짐 → 골격
  }
  if (!cfg.allow || typeof cfg.allow !== 'object') cfg.allow = { tools: {}, writePaths: [], denyPaths: [] };
  cfg.allow.commandMode = mode;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}

export type McpWriteMode = 'propose' | 'write';

// permissions.json의 allow.mcpWriteMode 읽기(없거나 깨짐/미지정값 → 'propose'). §3.4.
export function getMcpWriteMode(configDir: string): McpWriteMode {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'permissions.json'), 'utf8'));
    return raw?.allow?.mcpWriteMode === 'write' ? 'write' : 'propose';
  } catch {
    return 'propose';
  }
}

// allow.mcpWriteMode 부분 갱신(다른 필드 보존, 골격 없으면 생성) — getCommandMode/setCommandMode와 동일 결.
// IPC 경계로 노출되는 원시함수 — 런타임 화이트리스트(두 값만) 필수(setPermissionList와 동일 이유).
export function setMcpWriteMode(configDir: string, mode: McpWriteMode): void {
  if (mode !== 'propose' && mode !== 'write') return;
  const file = path.join(configDir, 'permissions.json');
  let cfg: { default: string; allow: Record<string, unknown> } = { default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') cfg = raw;
  } catch {
    // 없거나 깨짐 → 골격
  }
  if (!cfg.allow || typeof cfg.allow !== 'object') cfg.allow = { tools: {}, writePaths: [], denyPaths: [] };
  cfg.allow.mcpWriteMode = mode;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}

export interface PermissionDetails { writePaths: string[]; denyPaths: string[]; commands: string[] | null }

export function getPermissionDetails(configDir: string): PermissionDetails {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'permissions.json'), 'utf8'));
    const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []);
    return {
      writePaths: strArr(raw?.allow?.writePaths),
      denyPaths: strArr(raw?.allow?.denyPaths),
      commands: Array.isArray(raw?.allow?.commands) ? raw.allow.commands.filter((s: unknown) => typeof s === 'string') : null,
    };
  } catch {
    return { writePaths: [], denyPaths: [], commands: null };
  }
}

// 목록 필드 부분 갱신. commands에만 null 허용 = 필드 삭제(내장 DEFAULT_COMMANDS 복귀).
export function setPermissionList(configDir: string, field: 'writePaths' | 'denyPaths' | 'commands', values: string[] | null): void {
  // IPC 경계로 노출되는 원시함수 — 타입은 컴파일타임뿐이라 런타임 화이트리스트 필수
  // (아니면 렌더러가 commandMode/tools/__proto__를 덮어쓸 수 있음).
  if (field !== 'writePaths' && field !== 'denyPaths' && field !== 'commands') return;
  const file = path.join(configDir, 'permissions.json');
  let cfg: { default: string; allow: Record<string, unknown> } = { default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') cfg = raw;
  } catch { /* 없거나 깨짐 → 골격 */ }
  if (!cfg.allow || typeof cfg.allow !== 'object') cfg.allow = { tools: {}, writePaths: [], denyPaths: [] };
  if (values === null) delete cfg.allow[field];
  else cfg.allow[field] = values;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}
