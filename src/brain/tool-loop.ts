// 미니 도구루프(스펙 §3.1) — provider 중립. 와이어 형식·history는 provider가 소유하고
// 이 모듈은 반복·토큰 집계·상한만 담당한다. Phase 8b 코딩 루프의 씨앗.
export interface ToolCall { id: string; name: string; input: unknown }
export interface TurnResult { text: string; toolCalls: ToolCall[]; inputTokens: number; outputTokens: number }
export interface LoopResult { text: string; inputTokens: number; outputTokens: number; hitLimit: boolean }

export const MAX_TOOL_ITERATIONS = 8;

// 두뇌 활동 표시(Task 1): 있으면 각 도구 실행 직전 발화(이름 + 1부터 시작하는 전체 순번 — 회전을
// 넘나들며 누적). anthropic-api·openai-api 양쪽이 이 한 곳(공유 루프)만 거쳐 onTool을 얻는다.
// never-throw 격리: UI 콜백이 던져도 도구 실행 자체(executeTool)는 계속돼야 한다(PtyManager cb 팬아웃과 동일 결).
export async function runToolLoop(
  callTurn: () => Promise<TurnResult>,
  pushToolResults: (results: Array<{ id: string; name: string; output: string }>) => void,
  executeTool: (name: string, input: unknown) => Promise<string>,
  maxIterations = MAX_TOOL_ITERATIONS,
  onTool?: (name: string, seq: number) => void,
): Promise<LoopResult> {
  let inputTokens = 0;
  let outputTokens = 0;
  let text = '';
  let seq = 0;
  for (let i = 0; i < maxIterations; i++) {
    const turn = await callTurn();
    inputTokens += turn.inputTokens;
    outputTokens += turn.outputTokens;
    if (turn.text) text = turn.text; // 최종 답 = 마지막 비어있지 않은 턴의 텍스트
    if (turn.toolCalls.length === 0) return { text, inputTokens, outputTokens, hitLimit: false };
    const results: Array<{ id: string; name: string; output: string }> = [];
    for (const c of turn.toolCalls) {
      seq++;
      if (onTool) { try { onTool(c.name, seq); } catch { /* 격리 — UI 콜백 실패가 도구 루프를 끊으면 안 됨 */ } }
      results.push({ id: c.id, name: c.name, output: await executeTool(c.name, c.input) });
    }
    pushToolResults(results);
  }
  return { text, inputTokens, outputTokens, hitLimit: true };
}
