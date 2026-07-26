import * as fs from 'fs';
import * as path from 'path';

// 위키 저장 방식 설정(2026-07-26). wiki-remote.json(깃 동기화)과 도메인이 달라 파일을 나눈다 —
// saveWikiRemote는 모르는 필드를 떨구므로 거기 얹으면 조용히 사라진다.
//
//  ask    = wiki_propose가 선택창으로 사용자에게 묻는다(기본).
//  direct = 묻지 않고 바로 저장한다. 사람 확인 없이 위키가 바뀌므로 켤 때 확인을 받는다
//           (settings-registry에서 risk: 'danger'로 분류).
export type WikiSaveMode = 'ask' | 'direct';

const FILE = 'wiki-save.json';

export function loadWikiSaveMode(configDir: string): WikiSaveMode {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, FILE), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const mode = (parsed as { mode?: unknown }).mode;
      if (mode === 'direct') return 'direct';
    }
  } catch { /* 없거나 깨짐 → 기본값(묻기) */ }
  return 'ask'; // 읽기 실패는 항상 안전한 쪽으로
}

export function saveWikiSaveMode(configDir: string, mode: WikiSaveMode): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, FILE), JSON.stringify({ mode }, null, 2));
}
