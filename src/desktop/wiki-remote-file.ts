import * as fs from 'fs';
import * as path from 'path';

// 설정창 폼용 wiki-remote.json 읽기/쓰기. knowledge-core loadWikiRemote는 remote 없으면
// null이라 폼 초기값용으로 부적합 — raw를 직접 읽어 기본값을 채운다.
export interface WikiRemoteForm { remote: string; branch: string; syncIntervalSec: number }

export function readWikiRemoteFile(configDir: string): WikiRemoteForm {
  let raw: Partial<WikiRemoteForm> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, 'wiki-remote.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
  } catch { /* 없거나 깨짐 → 기본값 */ }
  const n = Number(raw.syncIntervalSec);
  return {
    remote: typeof raw.remote === 'string' ? raw.remote.trim() : '',
    branch: (typeof raw.branch === 'string' && raw.branch.trim()) || 'main',
    syncIntervalSec: Number.isFinite(n) && n > 0 ? n : 60,
  };
}

export function saveWikiRemote(configDir: string, cfg: WikiRemoteForm): void {
  const n = Number(cfg.syncIntervalSec);
  const out: WikiRemoteForm = {
    remote: cfg.remote.trim(),
    branch: cfg.branch.trim() || 'main',
    syncIntervalSec: Number.isFinite(n) && n > 0 ? n : 60,
  };
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'wiki-remote.json'), JSON.stringify(out, null, 2));
}
