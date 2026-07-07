// Code 채널 대화(2026-07-07): 레포 읽고 대화체로 답, 코드요청이면 답 끝에 propose 마커.
// 순수 헬퍼(fs 접근 없음) — 파일 읽기는 orchestrator가 loadPrompt로 한다.

export const CODE_CHAT_DEFAULT = [
  '너는 Engram이다. 이 레포({path})에 대해 사용자와 대화하며 돕는다.',
  '필요하면 파일을 읽어(읽기 전용) 조사한 뒤 사용자 언어로 간결히 답하라.',
  '질문·설명·논의엔 그냥 답만 한다. 코드를 고치거나 새로 만들라는 요청일 때만 제안 블록을 붙인다.',
].join('\n');

// 프롬프트 조립. instruction은 loadPrompt('code-chat', CODE_CHAT_DEFAULT) 결과.
// propose 계약(마커 형식)은 파서와 묶여 있으므로 여기서 코드가 덧붙인다(사용자가 못 깨게).
export function buildCodeChatPrompt(
  instruction: string,
  ctx: { repoPath: string; userText: string; recent?: string; taskStatus?: string },
): string {
  return [
    instruction.split('{path}').join(ctx.repoPath),
    ctx.taskStatus ? `\n# 지금 이 스레드의 작업 상태\n${ctx.taskStatus}` : '',
    ctx.recent ? `\n# 최근 대화\n${ctx.recent}` : '',
    `\n# 사용자 메시지\n${ctx.userText}`,
    '\n코드를 고치거나 새로 만들라는 요청일 때에만, 답변 맨 끝에 아래 블록을 정확히 덧붙여라(질문·설명·논의엔 절대 금지):',
    '```engram:propose',
    '{"goal":"<한 줄 목표>"}',
    '```',
  ].filter(Boolean).join('\n');
}

// 두뇌 답에서 propose 마커를 떼어내고 goal을 뽑는다. 마커 없거나 깨지면 답만 반환.
// 마커는 계약상 "답변 맨 끝"에만 온다(buildCodeChatPrompt) → 끝($)에 앵커한다.
// 그래야 답변 중간에 인용된 마커(예: 이 기능 자체를 설명할 때)를 신호로 오인하지 않는다.
export function extractPropose(text: string): { reply: string; goal?: string } {
  const m = text.match(/```engram:propose\s*([\s\S]*?)```\s*$/);
  if (!m) return { reply: text.trim() };
  const reply = text.replace(m[0], '').trim();
  try {
    const o = JSON.parse(m[1].trim()) as { goal?: unknown };
    const goal = typeof o.goal === 'string' && o.goal.trim() ? o.goal.trim() : undefined;
    return { reply, goal };
  } catch {
    return { reply }; // 마커 깨졌으면 제안 없이 답만
  }
}
