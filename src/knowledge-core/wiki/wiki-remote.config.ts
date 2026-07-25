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

// ── 폼/설정 편집용(원격 미설정이어도 기본값을 채운 값을 돌려준다) ──────────────────────────
// loadWikiRemote는 remote가 없으면 null이라 "현재 설정 보기/고치기"에는 부적합하다.
// 원래 src/desktop/wiki-remote-file.ts에 있던 로직 — 앱 설정창·MCP 도구·터미널 명령이 **같은
// 함수**로 같은 파일을 읽고 쓰게 하려고 여기(헤드리스에서도 import 가능한 곳)로 옮겼다.
// desktop/wiki-remote-file.ts는 이제 이 두 함수를 재수출만 한다(로직 복사 0).
export interface WikiRemoteForm { remote: string; branch: string; syncIntervalSec: number }

export function readWikiRemoteForm(configDir: string): WikiRemoteForm {
  let raw: Partial<WikiRemoteForm> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, 'wiki-remote.json'), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Partial<WikiRemoteForm>;
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
