import * as fs from 'fs';
import * as path from 'path';

// 갈라진 위키 저장소 탐지(2026-07-27 실사고).
//
// 무슨 일이 있었나: 사용자의 위키가 조용히 두 곳으로 쪼개져 있었다. 앱은 진짜 %APPDATA%\engram을
// 읽어 2개를 보여줬고, 나머지 11개는 Claude 데스크톱(MSIX 패키지) 컨테이너 안의
// %LOCALAPPDATA%\Packages\<pkg>\LocalCache\Roaming\engram 에 있었다. 앱은 그걸 영원히 못 본다.
//
// 왜 그렇게 됐나: `npx engram-wiki-mcp`는 앱이 안 떠 있으면 코어 모드로 **자기가 직접** 파일을 쓴다.
// 그 프로세스가 패키지 컨테이너 안에서 돌면 Windows가 %APPDATA% 쓰기를 컨테이너로 리디렉션한다.
// 컨테이너 안에서는 "진짜 폴더 + 컨테이너 오버레이"가 합쳐 보이므로 그 프로세스는 아무 이상도
// 느끼지 못한다 — 갈라졌다는 사실 자체가 안에서는 보이지 않는다.
//
// 그래서 여기서는 리디렉션 여부를 알아내려 하지 않는다(안에서는 알 수 없다). 대신 **두 번째
// 저장소가 존재하는지**를 본다 — 그게 사용자에게 실제로 해가 되는 사실이고, 밖/안 어디서든 보인다.
// ponytail: 윈도우 MSIX 관례 경로만 본다. 다른 샌드박스가 다른 자리에 리디렉션하면 못 잡는다 —
// 그때 그 경로를 목록에 추가한다. 지금 실제로 사람을 물린 경로가 이것 하나다.

export interface SplitStore {
  /** 그 저장소의 wiki/pages 경로. */
  pagesDir: string;
  /** 그 안에 있는 .md 개수(사용자에게 "몇 장이 안 보이는지" 알려주려고). */
  pages: number;
}

function countPages(pagesDir: string): number {
  let total = 0;
  let users: string[];
  try {
    users = fs.readdirSync(pagesDir);
  } catch {
    return 0;
  }
  for (const u of users) {
    try {
      total += fs.readdirSync(path.join(pagesDir, u)).filter((f) => f.endsWith('.md')).length;
    } catch {
      /* 하위 폴더가 아니거나 읽을 수 없으면 0으로 친다 */
    }
  }
  return total;
}

/**
 * dataDir(내가 쓰는 저장소) 말고 **다른 곳에 또 있는** 위키 저장소들. 없으면 빈 배열.
 * 윈도우가 아니거나 %LOCALAPPDATA%가 없으면 탐지하지 않는다(오탐 대신 침묵).
 */
export function findSplitStores(dataDir: string, env: NodeJS.ProcessEnv = process.env): SplitStore[] {
  const local = env.LOCALAPPDATA;
  if (!local) return [];
  const name = path.basename(dataDir); // 보통 'engram'
  const mine = path.resolve(path.join(dataDir, 'wiki', 'pages'));
  let packages: string[];
  try {
    packages = fs.readdirSync(path.join(local, 'Packages'));
  } catch {
    return []; // Packages 폴더가 없다 = 이 머신엔 해당 없음
  }
  const found: SplitStore[] = [];
  for (const pkg of packages) {
    const pagesDir = path.join(local, 'Packages', pkg, 'LocalCache', 'Roaming', name, 'wiki', 'pages');
    if (path.resolve(pagesDir) === mine) continue; // 내가 쓰는 그 폴더면 갈라진 게 아니다
    const pages = countPages(pagesDir);
    if (pages > 0) found.push({ pagesDir, pages });
  }
  return found;
}

/**
 * "내가 이 폴더에 쓰면 진짜 그 폴더에 들어가나?" — 컨테이너 안에서는 합쳐진 뷰만 보이므로
 * 나열로는 절대 알 수 없다. 실제로 한 장 써 보고, 그게 패키지 컨테이너 쪽에 나타나는지로 판정한다.
 * 관리자 권한도 UNC도 필요 없다.
 *
 * 반환: 리디렉션되는 컨테이너 경로(그 안에 표식이 나타난 곳), 아니면 null.
 * never-throw — 판정에 실패하면 null(모르면 막지 않는다, 기존 동작 유지).
 */
export function probeRedirect(dataDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const local = env.LOCALAPPDATA;
  if (!local) return null;
  const name = path.basename(dataDir);
  // 위키가 아니라 데이터 루트에 쓴다 — 위키 폴더는 git 저장소라 잡동사니를 남기면 안 된다.
  const marker = `.redirect-probe-${process.pid}`;
  const mine = path.join(dataDir, marker);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(mine, '');
  } catch {
    return null; // 쓸 수 없으면 판정 불가 — 막지 않는다
  }
  try {
    let packages: string[];
    try {
      packages = fs.readdirSync(path.join(local, 'Packages'));
    } catch {
      return null;
    }
    for (const pkg of packages) {
      const container = path.join(local, 'Packages', pkg, 'LocalCache', 'Roaming', name);
      if (path.resolve(container) === path.resolve(dataDir)) continue; // 내가 곧 그 폴더면 리디렉션이 아니다
      try {
        if (fs.existsSync(path.join(container, marker))) return container;
      } catch {
        /* 접근 불가한 패키지는 건너뛴다 */
      }
    }
    return null;
  } finally {
    try { fs.unlinkSync(mine); } catch { /* 표식 정리 실패는 무해 */ }
  }
}

/** 사람이 읽는 경고문. 갈라진 게 없으면 null(부를 자리에서 조건문을 또 쓰지 않게). */
export function splitStoreWarning(dataDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const found = findSplitStores(dataDir, env);
  if (found.length === 0) return null;
  const lines = found.map((s) => `  ${s.pagesDir} (${s.pages} pages)`);
  return [
    'WARNING: your Engram wiki is split across more than one folder.',
    `This process writes to: ${path.join(dataDir, 'wiki', 'pages')}`,
    'But wiki pages also exist here, where the Engram app cannot see them:',
    ...lines,
    'This happens when the MCP server runs inside a sandboxed app (e.g. a packaged desktop client)',
    'while the Engram app is not running: Windows redirects its writes into that app\'s private store.',
    'Copy those pages into the folder above to merge them.',
  ].join('\n');
}
