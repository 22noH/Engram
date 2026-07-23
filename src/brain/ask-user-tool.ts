import { AskUserPayload, validateAskUserPayload } from '../agent-layer/ask-user-block';
import { WebToolDef } from './web-tools';

// 자체 하네스(anthropic-api·openai-api) 전용 ask_user 도구(Task 4, 지휘자 ask_brain 관례를 그대로 따른다).
// 범용 펜스텍스트 경로(Task 3, ask-user-block.ts)와 나란히 존재 — 도구 호출을 지원하는 모델은
// 이 도구를, 텍스트만 내는 CLI 하네스·비도구 로컬 LLM은 그쪽(```ask_user 펜스 블록)을 쓴다.
// 검증은 ask-user-block.ts가 export하는 validateAskUserPayload 하나로 공유(단일 소스 — 중복 구현 금지).
export function askUserDef(): WebToolDef {
  return {
    name: 'ask_user',
    description:
      'Ask the user a structured question and pause — the UI renders it as a clickable question card. ' +
      'Use only when you genuinely need the user to decide between options before you can continue; ' +
      'the answer arrives as the user\'s next message, not as this tool\'s result.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              q: { type: 'string', description: 'The question text' },
              header: { type: 'string', description: 'Optional short title for the card' },
              multiSelect: { type: 'boolean', description: 'Allow picking more than one option' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'The choice label' },
                    desc: { type: 'string', description: 'Optional one-line detail' },
                    recommended: { type: 'boolean', description: 'Mark as the recommended choice (at most one per question)' },
                  },
                  required: ['label'],
                },
              },
            },
            required: ['q', 'options'],
          },
        },
      },
      required: ['questions'],
    },
  };
}

// ask_user 실행 — never-throw(§3.1 도구 규율). 미주입(하네스가 배선 안 함) → 안내, 검증 실패 → 사유,
// 성공 → 게시 완료 + 이번 턴 마무리 지시(모델이 답을 기다리며 장황한 텍스트를 더 내지 않도록).
export async function runAskUser(input: unknown, askUser?: (q: AskUserPayload) => Promise<void>): Promise<string> {
  if (!askUser) return 'ask_user error: 이 하네스에선 ask_user를 쓸 수 없다';
  const payload = validateAskUserPayload(input);
  if (!payload) {
    return 'ask_user error: 유효하지 않은 질문 형식(questions 1~4개·각 q 필수, options 2~4개·각 label 필수)';
  }
  try {
    await askUser(payload);
  } catch (e) {
    return `ask_user error: ${String(e)}`;
  }
  return '질문 카드를 게시했다. 사용자의 답은 다음 사용자 메시지로 도착한다. 이번 턴은 간결히 마무리하라.';
}
