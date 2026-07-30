import * as crypto from 'crypto';
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

export interface SplitImportResult {
  /** 이번에 가져온 페이지("userId/slug.md"). */
  imported: string[];
  /** 이미 있는데 내용이 달라 **건드리지 않은** 것. 앱 쪽이 이긴다. */
  conflicts: string[];
  /** 지금은 데려오지 않은 것(막 쓰이는 중이거나 파싱이 안 되는 파일). 다음 부팅에 다시 본다. */
  skipped: string[];
  /** 복사·커밋이 실패한 것. 조용히 삼키지 않는다(다음 부팅에 재시도된다). */
  failed: string[];
  /** 스캔한 갈라진 저장소 경로들. */
  from: string[];
}

// 원장(ledger) — "이 원본 내용은 이미 처리했다"를 기억하는 파일. state/에 둔다(위키 트리 밖 —
// 거기 두면 원장 자체가 위키 페이지처럼 동기화된다). rag-index.json과 같은 자리·같은 결.
const LEDGER = 'split-import.json';

// 막 쓰인 파일은 건드리지 않는다. 컨테이너 쪽 WikiEngine은 평범한 writeFile로 쓰므로 저장 도중에
// 복사하면 잘린 바이트를 가져올 수 있고, 그 잘린 사본이 영구 사본이 된다(그다음부터는 원본과 달라
// 영원히 conflict로 분류된다). 몇 초 기다렸다 다음 부팅에 데려오는 편이 훨씬 싸다.
const SETTLE_MS = 3_000;

type Ledger = Record<string, string>;

function ledgerPath(dataDir: string): string {
  return path.join(dataDir, 'state', LEDGER);
}

function loadLedger(dataDir: string): Ledger {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(dataDir), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Ledger = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
  } catch { /* 없거나 깨짐 → 빈 원장(안전측: 다시 판단한다) */ }
  return {};
}

function saveLedger(dataDir: string, ledger: Ledger): void {
  try {
    fs.mkdirSync(path.dirname(ledgerPath(dataDir)), { recursive: true });
    fs.writeFileSync(ledgerPath(dataDir), JSON.stringify(ledger, null, 2));
  } catch { /* 원장을 못 써도 부팅은 계속된다 — 다음 부팅에 다시 판단할 뿐이다 */ }
}

export interface SplitImportOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * 가져온 페이지를 커밋한다("pages/<user>/<slug>.md" 기준 상대경로를 받는다). 이게 성공해야
   * 원장에 기록한다 — 실패하면 다음 부팅에 다시 시도한다. 미지정이면 커밋 없이 기록만 한다.
   */
  commit?: (rel: string) => Promise<void>;
  /** 파싱 검증(주입 — split-store가 page-serializer에 의존하지 않게). 던지면 그 파일은 건너뛴다. */
  validate?: (text: string) => void;
  /** 테스트용 현재 시각. */
  now?: number;
}

/**
 * 갈라진 저장소의 페이지를 내 저장소로 **가져온다**(2026-07-30).
 *
 * 왜 이걸 여기서 하나: 컨테이너 **안에서는 진짜 폴더에 쓸 방법이 없다**. %APPDATA% 아래는 전부
 * 가상화되므로 경로를 어떻게 적어도 OS가 오버레이로 보낸다 — MCP 서버가 스스로 고칠 수 있는 문제가
 * 아니다. 반면 앱은 가상화 밖에 있고, 오버레이 폴더를 **읽을 수는 있다**(findSplitStores가 이미
 * 찾아낸다). 그래서 고치는 쪽은 컨테이너 밖에 있는 앱이다: 부팅할 때 갇혀 있던 페이지를 데려온다.
 * 지금까지는 경고만 찍고 사용자가 손으로 옮기게 했다 — 실제로 11장이 몇 주 갇혀 있었다.
 *
 * 어느 쓰기가 오버레이로 가고 어느 쓰기가 통과하는지는 아직 모른다(실측: 새 페이지는 오버레이,
 * 기존 페이지 수정은 진짜 폴더로 갔다). 이 함수는 그 기전에 의존하지 않는다 — "저쪽에 있는데
 * 이쪽에 없는 것"을 데려올 뿐이라 어느 쪽이든 결과가 같다.
 *
 * ★★원장이 필요한 이유(2026-07-30 적대적 검토에서 재현된 치명 버그). 처음엔 "대상 파일이 이미
 * 있으면 가져온 것"으로 판정했다. 그런데 원본은 절대 지우지 않으므로, 사용자가 **앱에서 페이지를
 * 지우면** 다음 부팅에 대상이 없어져 그 페이지가 되살아난다 — 부팅마다, 영원히. 사용자는 막을
 * 방법이 없다(그 사본은 다른 앱의 사설 폴더에 있어 화면에서 보이지도 않는다). 충돌로 분류됐던
 * 페이지는 더 나쁘다: 지우면 **낡은 샌드박스 버전**이 되살아난다. 그래서 판정 기준을 "대상이
 * 있는가"에서 "이 원본 내용을 이미 처리했는가"로 바꿨다 — 원본 바이트의 sha256을 원장에 남긴다.
 * 삭제는 유지되고, 원본이 진짜로 새 내용으로 바뀌면(해시가 다르면) 그때만 다시 데려온다.
 *
 * 안전 규칙:
 *  - 원본은 **절대 지우지 않는다**(사용자 데이터다. 실패해도 잃는 게 없다).
 *  - 이미 있고 내용이 다르면 **덮어쓰지 않는다** — 앱이 쓴 쪽이 최신일 수 있다. 기록만 남긴다.
 *  - 막 쓰인 파일·파싱 안 되는 파일은 데려오지 않는다(잘린 사본·부팅 정지 방지).
 *  - 커밋이 성공해야 원장에 남긴다 — 실패하면 다음 부팅에 재시도된다.
 *  - never-throw: 한 장이 실패해도 나머지를 가져온다.
 */
export async function importSplitStorePages(
  dataDir: string,
  opts: SplitImportOptions = {},
): Promise<SplitImportResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const result: SplitImportResult = { imported: [], conflicts: [], skipped: [], failed: [], from: [] };
  const myPages = path.join(dataDir, 'wiki', 'pages');
  const stores = findSplitStores(dataDir, env);
  if (stores.length === 0) return result; // 갈라진 게 없으면 원장도 건드리지 않는다
  const ledger = loadLedger(dataDir);
  let ledgerDirty = false;

  for (const store of stores) {
    result.from.push(store.pagesDir);
    let users: string[];
    try {
      users = fs.readdirSync(store.pagesDir);
    } catch {
      continue;
    }
    for (const user of users) {
      const srcDir = path.join(store.pagesDir, user);
      let files: string[];
      try {
        files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.md'));
      } catch {
        continue; // 폴더가 아니거나 읽을 수 없음
      }
      for (const file of files) {
        const rel = `${user}/${file}`;
        const src = path.join(srcDir, file);
        const dest = path.join(myPages, user, file);
        const key = `${store.pagesDir}|${rel}`;
        try {
          // 한 번만 읽는다 — 해시를 낸 바이트와 쓰는 바이트가 같아야 한다(중간에 바뀌면 아래 재확인에서 걸린다).
          const buf = fs.readFileSync(src);
          const hash = crypto.createHash('sha256').update(buf).digest('hex');
          if (ledger[key] === hash) continue; // 이미 처리한 내용 → 삭제가 유지된다

          const before = fs.statSync(src);
          if (now - before.mtimeMs < SETTLE_MS) { result.skipped.push(rel); continue; }
          if (opts.validate) {
            try {
              opts.validate(buf.toString('utf8'));
            } catch {
              // 못 읽는 바이트를 저장소에 들이지 않는다 — 부팅 경로가 곧 이 폴더를 읽는다.
              result.skipped.push(rel);
              continue;
            }
          }

          const relFromWiki = path.join('pages', user, file);
          if (fs.existsSync(dest)) {
            if (fs.readFileSync(dest).equals(buf)) {
              // 이미 같은 내용이 있다 = 예전에 가져왔거나 앱이 같은 걸 썼다. 커밋만 보장하고 기록한다
              // (지난 부팅에 커밋이 실패했을 수 있다 — commitAll은 스테이징이 없으면 그냥 넘어간다).
              try {
                if (opts.commit) await opts.commit(relFromWiki);
                ledger[key] = hash;
                ledgerDirty = true;
              } catch {
                result.failed.push(rel);
              }
            } else {
              // 앱 쪽이 이긴다. 그래도 **기록은 남긴다** — 안 남기면 사용자가 이 페이지를 지웠을 때
              // 낡은 샌드박스 사본이 되살아난다.
              result.conflicts.push(rel);
              ledger[key] = hash;
              ledgerDirty = true;
            }
            continue;
          }

          fs.mkdirSync(path.dirname(dest), { recursive: true });
          // 임시 이름에 쓴 뒤 rename으로 원자적으로 놓는다(부분 쓰기가 저장소에 보이지 않게).
          const tmp = `${dest}.importing-${process.pid}`;
          fs.writeFileSync(tmp, buf);
          const after = fs.statSync(src);
          if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
            // 우리가 읽는 동안 원본이 바뀌었다 = 잘린 사본일 수 있다. 버리고 다음 부팅에 다시 본다.
            try { fs.unlinkSync(tmp); } catch { /* 정리 실패는 무해 */ }
            result.skipped.push(rel);
            continue;
          }
          fs.renameSync(tmp, dest);
          // 파일은 이미 제자리에 있으므로 imported로 센다. 커밋이 실패하면 failed에도 올라가고 원장에는
          // 남기지 않는다 — 다음 부팅이 "이미 같은 내용이 있다" 분기로 들어와 커밋만 다시 시도한다.
          result.imported.push(rel);
          try {
            if (opts.commit) await opts.commit(relFromWiki);
            ledger[key] = hash;
            ledgerDirty = true;
          } catch {
            result.failed.push(rel);
          }
        } catch {
          result.failed.push(rel); // 조용히 삼키지 않는다
        }
      }
    }
  }
  if (ledgerDirty) saveLedger(dataDir, ledger);
  return result;
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
    // 손으로 옮기라는 안내는 지웠다 — 앱이 부팅할 때 스스로 가져온다(importSplitStorePages).
    'The Engram desktop app imports these pages into the folder above the next time it starts.',
  ].join('\n');
}
