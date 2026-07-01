import * as fs from 'fs';
import * as path from 'path';

// 메신저 코딩 대상 repo 설정(Phase 6b-2). runtime/config/coderepos.json.
export interface CodeReposConfig {
  aliases: Record<string, string>; // 별칭 → 절대경로
  searchRoots: string[];           // 별칭에 없으면 여기서 이름으로 검색
}

export function loadCodeRepos(configDir: string): CodeReposConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'coderepos.json'), 'utf8')) as Partial<CodeReposConfig>;
    return {
      aliases: raw.aliases && typeof raw.aliases === 'object' ? raw.aliases : {},
      searchRoots: Array.isArray(raw.searchRoots) ? raw.searchRoots.map(String) : [],
    };
  } catch {
    return { aliases: {}, searchRoots: [] };
  }
}

// repoRef → 후보 경로들(0/1/N). ① 경로형이고 디렉터리로 존재 → 그 경로 ② alias(대소문자 무시)
// ③ searchRoots 얕은(depth ≤ 2) 하위 디렉터리 이름 매칭(정확 우선, 없으면 부분 포함).
// ponytail: 얕은 글로브, 거대 트리 스캔 금지.
export function resolveRepo(repoRef: string, cfg: CodeReposConfig): string[] {
  const ref = repoRef.trim();
  if (!ref) return [];

  // ① 경로형(슬래시/역슬래시/드라이브) + 존재하는 디렉터리
  if (/[/\\]/.test(ref) || /^[a-zA-Z]:/.test(ref)) {
    try { if (fs.statSync(ref).isDirectory()) return [ref]; } catch { /* 없음 → 다음 */ }
  }

  // ② alias(대소문자 무시)
  const aliasKey = Object.keys(cfg.aliases).find((k) => k.toLowerCase() === ref.toLowerCase());
  if (aliasKey) return [cfg.aliases[aliasKey]];

  // ③ searchRoots 얕은 검색
  const lower = ref.toLowerCase();
  const exact: string[] = [];
  const partial: string[] = [];
  for (const root of cfg.searchRoots) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const name = e.name.toLowerCase();
      if (name === lower) exact.push(path.join(root, e.name));
      else if (name.includes(lower)) partial.push(path.join(root, e.name));
    }
  }
  return exact.length ? exact : partial;
}
