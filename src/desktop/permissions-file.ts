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
