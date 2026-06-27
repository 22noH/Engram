import * as fs from 'fs';
import * as path from 'path';

// 빌드 레이아웃(src/ vs dist/src/)과 무관하게 Engram 레포 루트를 찾는다.
// 시작 디렉터리에서 위로 올라가며 package.json을 가진 첫 디렉터리를 반환.
// __dirname 깊이에 의존하던 방식(빌드 시 dist/를 가리켜 자기수정 백스톱이 무력화됨)을 대체한다.
export function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // 파일시스템 루트 도달
    dir = parent;
  }
  return path.resolve(startDir); // 못 찾으면 시작 디렉터리(보수적)
}
