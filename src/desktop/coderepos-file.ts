import * as fs from 'fs';
import * as path from 'path';
import { loadCodeRepos, CodeReposConfig } from '../agent-layer/coderepos';

// coderepos.json 쓰기(설정창 전용). 읽기는 agent-layer loadCodeRepos 재사용(fault-tolerant).
function save(configDir: string, cfg: CodeReposConfig): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'coderepos.json'), JSON.stringify(cfg, null, 2));
}

export function setAlias(configDir: string, alias: string, targetPath: string): boolean {
  const a = alias.trim();
  const p = targetPath.trim();
  // '__proto__'는 대입이 조용히 증발(상속 접근자)하고 loadCodeRepos도 못 읽음 — 거짓 성공 대신 거부.
  if (!a || !p || a === '__proto__') return false;
  const cfg = loadCodeRepos(configDir);
  cfg.aliases[a] = p;
  save(configDir, cfg);
  return true;
}

export function removeAlias(configDir: string, alias: string): void {
  const cfg = loadCodeRepos(configDir);
  if (!Object.prototype.hasOwnProperty.call(cfg.aliases, alias)) return;
  delete cfg.aliases[alias];
  save(configDir, cfg);
}

export function setSearchRoots(configDir: string, roots: string[]): void {
  const cfg = loadCodeRepos(configDir);
  cfg.searchRoots = roots.map((r) => r.trim()).filter(Boolean);
  save(configDir, cfg);
}
