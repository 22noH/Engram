import * as fs from 'fs';
import * as path from 'path';

// 위키 git 원격 설정(Phase 15b). remote 미설정 = 동기화 안 함(로컬 전용).
// 자격증명은 담지 않는다 — git 표준 인증(SSH/토큰)에 위임.
export interface WikiRemoteConfig {
  remote: string;
  branch: string;
  syncIntervalSec: number;
}

export function loadWikiRemote(configDir: string, env: NodeJS.ProcessEnv = process.env): WikiRemoteConfig | null {
  let raw: Partial<WikiRemoteConfig> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, 'wiki-remote.json'), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Partial<WikiRemoteConfig>;
  } catch {
    raw = {};
  }
  const remote = (typeof env.ENGRAM_WIKI_REMOTE === 'string' && env.ENGRAM_WIKI_REMOTE.trim())
    || (typeof raw.remote === 'string' && raw.remote.trim())
    || '';
  if (!remote) return null; // 미설정 → 동기화 비활성
  const branch = (typeof raw.branch === 'string' && raw.branch.trim()) || 'main';
  const n = Number(raw.syncIntervalSec);
  const syncIntervalSec = Number.isFinite(n) && n > 0 ? n : 60;
  return { remote, branch, syncIntervalSec };
}
