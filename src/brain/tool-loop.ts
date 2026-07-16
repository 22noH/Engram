// 미니 도구루프(스펙 §3.1) — provider 중립. 와이어 형식·history는 provider가 소유하고
// 이 모듈은 반복·토큰 집계·상한만 담당한다. Phase 8b 코딩 루프의 씨앗.
export interface ToolCall { id: string; name: string; input: unknown }
export interface TurnResult { text: string; toolCalls: ToolCall[]; inputTokens: number; outputTokens: number }
export interface LoopResult { text: string; inputTokens: number; outputTokens: number; hitLimit: boolean }

export const MAX_TOOL_ITERATIONS = 8;

export async function runToolLoop(
  callTurn: () => Promise<TurnResult>,
  pushToolResults: (results: Array<{ id: string; name: string; output: string }>) => void,
  executeTool: (name: string, input: unknown) => Promise<string>,
  maxIterations = MAX_TOOL_ITERATIONS,
): Promise<LoopResult> {
  let inputTokens = 0;
  let outputTokens = 0;
  let text = '';
  for (let i = 0; i < maxIterations; i++) {
    const turn = await callTurn();
    inputTokens += turn.inputTokens;
    outputTokens += turn.outputTokens;
    if (turn.text) text = turn.text; // 최종 답 = 마지막 비어있지 않은 턴의 텍스트
    if (turn.toolCalls.length === 0) return { text, inputTokens, outputTokens, hitLimit: false };
    const results: Array<{ id: string; name: string; output: string }> = [];
    for (const c of turn.toolCalls) {
      results.push({ id: c.id, name: c.name, output: await executeTool(c.name, c.input) });
    }
    pushToolResults(results);
  }
  return { text, inputTokens, outputTokens, hitLimit: true };
}
