// Code 채널 대화(2026-07-07): 레포 읽고 대화체로 답, 코드요청이면 답 끝에 propose 마커.
// 순수 헬퍼(fs 접근 없음) — 파일 읽기는 orchestrator가 loadPrompt로 한다.

import { outputDirective } from './language';

export const CODE_CHAT_DEFAULT = [
  'You are Engram. You help the user by talking about this repo ({path}).',
  'When needed, read files (read-only) to investigate, then answer concisely.',
  'For questions, explanations, or discussion, just answer. Attach the proposal block only when asked to change or create code.',
].join('\n');

// 프롬프트 조립. instruction은 loadPrompt('code-chat', CODE_CHAT_DEFAULT) 결과.
// propose 계약(마커 형식)은 파서와 묶여 있으므로 여기서 코드가 덧붙인다(사용자가 못 깨게).
export function buildCodeChatPrompt(
  instruction: string,
  ctx: { repoPath: string; userText: string; recent?: string; taskStatus?: string },
): string {
  return [
    instruction.split('{path}').join(ctx.repoPath),
    ctx.taskStatus ? `\n# Current task status in this thread\n${ctx.taskStatus}` : '',
    ctx.recent ? `\n# Recent conversation\n${ctx.recent}` : '',
    `\n# User message\n${ctx.userText}`,
    outputDirective('interactive'),
    '\nOnly when asked to change or create code, append exactly the block below at the very end of your answer (never for questions/explanations/discussion):',
    '```engram:propose',
    '{"goal":"<one-line goal>"}',
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
