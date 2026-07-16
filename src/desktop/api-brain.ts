import { mergeBrainProfile } from './brains-file';

// 설정창(스펙 §5): Anthropic API 키 저장 → anthropic-api 프로필 생성/갱신(반영은 상주 재시작).
export function saveAnthropicApiKey(configDir: string, apiKey: string, setDefault = false): void {
  mergeBrainProfile(configDir, 'anthropic', {
    provider: 'anthropic-api',
    model: 'claude-opus-4-8',
    apiKey,
  }, setDefault);
}
