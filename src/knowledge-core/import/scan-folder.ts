import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { ScannedFile } from './folder-importer';

// 감시 폴더 재귀 스캔 + 내용 해시. "무엇을 파일로 볼 것인가"의 판정만 순수 함수로 떼어 테스트한다.

/** 스캔 폭주 방지 — 폴더 하나에 수만 개가 있어도 여기서 멈춘다. */
export const MAX_SCAN_FILES = 2000;
/** 재귀 깊이 상한(심볼릭 링크 순환·의도치 않은 거대 트리 방어). */
export const MAX_SCAN_DEPTH = 6;

// 편집기·오피스·브라우저가 남기는 임시/잠금 파일. 이런 걸 위키로 만들면 쓰레기가 쌓인다.
const TEMP_PATTERNS = [
  /^~\$/,            // Word/Excel 잠금 파일(~$문서.docx)
  /^\./,             // 숨김·설정 파일
  /\.tmp$/i,
  /\.temp$/i,
  /\.part$/i,
  /\.crdownload$/i,
  /\.download$/i,
  /^thumbs\.db$/i,
  /^desktop\.ini$/i,
  /^\$RECYCLE/i,
];

// 들어가지 않을 디렉터리 이름(내용이 지식이 아닌 것이 확실한 곳).
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '$recycle.bin', 'system volume information']);

/** 이 이름의 파일을 건너뛸 것인가(순수 함수). */
export function isTempName(name: string): boolean {
  return TEMP_PATTERNS.some((re) => re.test(name));
}

/** 이 이름의 디렉터리에 들어갈 것인가(순수 함수). */
export function isSkippedDir(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase());
}

/**
 * 폴더를 재귀 스캔해 처리 후보 파일 목록을 만든다. never-throw — 못 읽는 하위 폴더는 건너뛴다.
 * 원본은 절대 건드리지 않는다(읽기 전용 — stat과 read뿐).
 */
export async function listFolder(folder: string): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH || out.length >= MAX_SCAN_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 권한 없음·사라짐 — 조용히 넘어간다(스캔 전체를 죽이지 않는다)
    }
    for (const e of entries) {
      if (out.length >= MAX_SCAN_FILES) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (isSkippedDir(e.name)) continue;
        await walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile()) continue; // 심링크·소켓 등은 따라가지 않는다
      if (isTempName(e.name)) continue;
      try {
        const st = await fsp.stat(abs);
        out.push({
          rel: path.relative(folder, abs).split(path.sep).join('/'),
          absPath: abs,
          name: e.name,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      } catch {
        // stat 실패(경합으로 사라짐 등) — 이 파일만 건너뛴다
      }
    }
  };
  await walk(folder, 0);
  return out;
}

/** 내용 해시(sha256 앞 16자). 스트리밍이라 큰 파일도 메모리를 안 먹는다. */
export function hashFile(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(absPath);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex').slice(0, 16)));
  });
}
