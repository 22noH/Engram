import * as fs from 'fs';
import { resolveResourceFile } from '../pal/resource-dir';

// 편집 가능한 에이전트 지시문을 prompts/{name}.md에서 읽는다(코드 수정·재빌드 없이 튜닝).
// 파일 없음/비어있음 → fallback(내장 기본값)으로 out-of-box 동작 보장. personas/*.md와 같은 결.
// Phase 7: 데이터 폴더(ENGRAM_DATA_DIR)/prompts에 같은 이름이 있으면 사용자 편집본 우선.
// JSON 출력 계약 등 파서와 묶인 줄은 호출부가 코드에서 덧붙인다(사용자가 못 깨게).
export function loadPrompt(name: string, fallback: string): string {
  try {
    const p = resolveResourceFile(`prompts/${name}.md`);
    const text = fs.readFileSync(p, 'utf8').trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}
