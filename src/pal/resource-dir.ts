import * as fs from 'fs';
import * as path from 'path';
import { findRepoRoot } from './repo-root';

// 번들 리소스(prompts/·personas/)의 사용자 편집 오버라이드(스펙 §3).
// 데이터 폴더(ENGRAM_DATA_DIR)에 같은 이름이 있으면 그것을, 없으면 앱/레포 루트의 번들본을 쓴다.
// 설치형 앱에서 findRepoRoot는 앱 패키지 루트(package.json 위치)를 가리키므로 번들본이 폴백이 된다.

// 파일 단위 오버라이드(프롬프트 하나만 고쳐도 나머지는 번들본 유지).
export function resolveResourceFile(relPath: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.ENGRAM_DATA_DIR) {
    const p = path.join(env.ENGRAM_DATA_DIR, relPath);
    if (fs.existsSync(p)) return p;
  }
  return path.join(findRepoRoot(__dirname), relPath);
}

// 폴더 통째 오버라이드(personas는 레지스트리가 디렉토리 전체를 스캔하므로 폴더 단위).
export function resolveResourceDir(name: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.ENGRAM_DATA_DIR) {
    const p = path.join(env.ENGRAM_DATA_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(findRepoRoot(__dirname), name);
}
