import { createBrain } from './brain.factory';
import { ClaudeCliBrain } from './claude-cli.brain';
import { AnthropicApiBrain } from './anthropic-api.brain';
import { OpenAiApiBrain } from './openai-api.brain';

const base = { cli: 'x', model: '', concurrency: 1, timeoutMs: 1000, extraArgs: [], env: {} };

describe('BrainFactory', () => {
  it('claude-cli provider는 ClaudeCliBrain', () => {
    expect(createBrain({ ...base, provider: 'claude-cli' } as any)).toBeInstanceOf(ClaudeCliBrain);
  });

  it('알 수 없는 provider는 throw', () => {
    expect(() => createBrain({ ...base, provider: 'nope' } as any)).toThrow();
  });
});

describe('createBrain — Phase 8a API providers', () => {
  const base = { cli: '', model: 'm', concurrency: 1, timeoutMs: 1000, extraArgs: [] };
  it('anthropic-api → AnthropicApiBrain', () => {
    expect(createBrain({ ...base, provider: 'anthropic-api', apiKey: 'k' })).toBeInstanceOf(AnthropicApiBrain);
  });
  it('openai-api → OpenAiApiBrain', () => {
    expect(createBrain({ ...base, provider: 'openai-api', baseUrl: 'http://x/v1' })).toBeInstanceOf(OpenAiApiBrain);
  });
});
