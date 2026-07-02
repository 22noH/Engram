import * as fs from 'fs';
import * as path from 'path';

// Ollama 도우미(스펙 §4): 로컬LLM은 별도 어댑터가 아니라 claude-cli 하네스의 백엔드 env 교체(Phase 3 구조).
// 따라서 프로필은 provider=claude-cli + env.ANTHROPIC_BASE_URL만 바꾼다. claude CLI는 여전히 필요.

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

// brains.json에 ollama 프로필을 병합 저장한다. 다른 프로필·설정은 보존, 깨진 파일은 기본 골격으로 재작성.
export function addOllamaProfile(configDir: string, model: string, setDefault = false): void {
  const file = path.join(configDir, 'brains.json');
  let cfg: { default: string; brains: Record<string, unknown> } = { default: 'claude', brains: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      cfg = { default: raw.default ?? 'claude', brains: raw.brains ?? {} };
    }
  } catch {
    // 없거나 깨짐 → 기본 골격
  }
  cfg.brains.ollama = {
    provider: 'claude-cli',
    cli: 'claude',
    model,
    env: { ANTHROPIC_BASE_URL: OLLAMA_URL },
  };
  if (setDefault) cfg.default = 'ollama';
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}
