import { BrainProvider } from './brain.port';
import { BrainProfile } from './brain.config';
import { ClaudeCliBrain } from './claude-cli.brain';

// brains.json provider → 어댑터(설계 §6). Phase 8a: anthropic-api/openai-api = 자체 하네스(CLI 불필요).
export function createBrain(profile: BrainProfile): BrainProvider {
  switch (profile.provider) {
    case 'claude-cli':
      return new ClaudeCliBrain(profile);
    case 'gemini-cli': {
      const { GeminiBrain } = require('./gemini.brain');
      return new GeminiBrain(profile);
    }
    case 'codex-cli': {
      const { CodexBrain } = require('./codex.brain');
      return new CodexBrain(profile);
    }
    case 'anthropic-api': {
      const { AnthropicApiBrain } = require('./anthropic-api.brain');
      return new AnthropicApiBrain(profile);
    }
    case 'openai-api': {
      const { OpenAiApiBrain } = require('./openai-api.brain');
      return new OpenAiApiBrain(profile);
    }
    default:
      throw new Error(`지원하지 않는 provider: ${profile.provider}`);
  }
}
