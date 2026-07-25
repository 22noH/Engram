import type { BrowserOp, BrowserOpResult } from '../../shared/browser-ops';
import { BROWSER_TOOL_DEFS as SHARED_DEFS, isBrowserToolName, toBrowserOp } from '../../shared/browser-ops';
import type { WebToolDef } from './web-tools';

// AI 웹 조작 도구(2단계) — 하네스 쪽 배선. 도구 이름·설명·인자 검증의 **정의 자체는**
// shared/browser-ops.ts 한 곳에 있다(MCP 경로 engram-mcp.ts와 문구가 갈라지지 않게).
// 여기는 그 정의를 하네스 타입(WebToolDef)으로 실어주고 실행을 붙이는 얇은 층이다.
//
// 실제 조작은 렌더러의 <webview>가 한다(BrowserBus 왕복). 모든 실패는 throw가 아니라 에러
// 텍스트다(§3.1 도구 규율) — 두뇌가 그걸 읽고 다음 수를 정한다.

export const BROWSER_TOOL_DEFS: WebToolDef[] = SHARED_DEFS;

export { toBrowserOp };

/** 도구 실행 단일 진입점. exec 미주입(하네스가 배선 안 함) → 안내. never-throw. */
export async function executeBrowserTool(
  name: string,
  input: unknown,
  exec?: (op: BrowserOp) => Promise<BrowserOpResult>,
): Promise<string> {
  if (!isBrowserToolName(name)) return `tool error: unknown tool ${name}`;
  if (!exec) return 'browser error: web control is not wired for this turn';
  const op = toBrowserOp(name, input);
  if (typeof op === 'string') return op;
  try {
    const r = await exec(op);
    return r.text;
  } catch (e) {
    return `browser error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
