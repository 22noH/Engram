import * as fs from 'fs';
import * as path from 'path';
import { GateCommands } from '../knowledge-core/project-store';

// 게이트 명령을 프로젝트 파일에서 *결정적으로* 탐지(두뇌 추측 금지).
// 두뇌가 추정한 'node hello.js' 같은 게이트는 "로드되나"만 보고 거짓 통과한다 →
// package.json 스크립트·tsconfig를 직접 읽어 실제 검증 명령을 산출. 없으면 빈 문자열(하드 게이트 없음, 정직).
export function detectGate(targetPath: string): GateCommands {
  let test = '';
  let build = '';
  let typecheck = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(targetPath, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    // npm 기본 placeholder("Error: no test specified")는 게이트로 무의미 → 제외.
    if (scripts.test && !/no test specified/i.test(scripts.test)) test = 'npm test';
    if (scripts.build) build = 'npm run build';
    if (scripts.typecheck) typecheck = 'npm run typecheck';
  } catch {
    // package.json 없음/깨짐 → 스크립트 게이트 없음.
  }
  // typecheck 스크립트가 없어도 tsconfig가 있으면 타입체크는 가능.
  if (!typecheck && fs.existsSync(path.join(targetPath, 'tsconfig.json'))) typecheck = 'npx tsc --noEmit';
  return { test, build, typecheck };
}
