import { mergeBrainProfile } from './brains-file';

// Ollama 도우미: Phase 8a부터 자체 하네스(openai-api provider)로 직접 붙는다 — claude CLI 불필요.
// (이전: claude-cli 껍데기 + env 교체 — Phase 8a에서 폐기. 기존 사용자 프로필은 건드리지 않음.)

const OLLAMA_URL = 'http://localhost:11434';

export async function detectOllama(
  fetchFn: typeof fetch = fetch,
  baseUrl: string = OLLAMA_URL,
): Promise<{ running: boolean; models: string[] }> {
  try {
    const res = await fetchFn(`${baseUrl}/api/tags`);
    if (!res.ok) return { running: false, models: [] };
    const json = (await res.json()) as { models?: { name: string }[] };
    return { running: true, models: (json.models ?? []).map((m) => m.name) };
  } catch {
    return { running: false, models: [] };
  }
}

export function addOllamaProfile(configDir: string, model: string, name: string, setDefault = false): void {
  mergeBrainProfile(configDir, name, {
    provider: 'openai-api',
    baseUrl: `${OLLAMA_URL}/v1`,
    model,
  }, setDefault);
}
