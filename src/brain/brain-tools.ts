import { DelegateHandle } from './brain.port';

// 지휘자 도구(스펙 §2.2). web-tools와 형태를 맞춘 provider 중립 스키마 + never-throw 실행기.
// 도구 설명은 호출 시점에 조립(가용 두뇌 목록이 동적이라 상수 아님).
export function askBrainDef(brains: string[]): { name: string; description: string; parameters: Record<string, unknown> } {
  return {
    name: 'ask_brain',
    description:
      `Delegate a subtask to another registered brain and return its answer. ` +
      `Available brains: ${brains.join(', ') || '(none)'}. ` +
      `Use it when the user names a brain for part of the work, or when you are stuck and another brain could help. ` +
      `For autonomous delegation (the user did not name a brain), prefer local/free brains over paid API brains.`,
    parameters: {
      type: 'object',
      properties: {
        brain: { type: 'string', description: 'Name of a registered brain to delegate to' },
        task: { type: 'string', description: 'The subtask for that brain' },
      },
      required: ['brain', 'task'],
    },
  };
}

// ask_brain 실행 — never-throw. 인자 검증 후 delegate.run으로 라우팅.
export async function runAskBrain(input: unknown, delegate?: DelegateHandle): Promise<string> {
  if (!delegate) return 'ask_brain error: delegation not available';
  const arg = (input ?? {}) as Record<string, unknown>;
  if (typeof arg.brain !== 'string' || typeof arg.task !== 'string') {
    return 'ask_brain error: brain(string) and task(string) required';
  }
  return delegate.run(arg.brain, arg.task);
}
