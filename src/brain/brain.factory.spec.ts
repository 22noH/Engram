import { createBrain } from './brain.factory';
import { ClaudeCliBrain } from './claude-cli.brain';

const base = { cli: 'x', model: '', concurrency: 1, timeoutMs: 1000, extraArgs: [], env: {} };

describe('BrainFactory', () => {
  it('claude-cli provider는 ClaudeCliBrain', () => {
    expect(createBrain({ ...base, provider: 'claude-cli' } as any)).toBeInstanceOf(ClaudeCliBrain);
  });

  it('알 수 없는 provider는 throw', () => {
    expect(() => createBrain({ ...base, provider: 'nope' } as any)).toThrow();
  });
});
