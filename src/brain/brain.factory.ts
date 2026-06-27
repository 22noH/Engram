import { BrainProvider } from './brain.port';
import { BrainProfile } from './brain.config';
import { ClaudeCliBrain } from './claude-cli.brain';

// brains.json provider → 어댑터(설계 §6). 로컬LLM은 claude-cli + env 프로필이라 별 provider 불요.
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
    default:
      throw new Error(`지원하지 않는 provider: ${profile.provider}`);
  }
}
