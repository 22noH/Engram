import * as fs from 'fs';
import * as path from 'path';

// 메인체 챗수정 설정(T5참고). 기본값 = 가동(127.0.0.1:47800). enabled:false만
// 비여 것(파일없음)은 env 포트/바인드 우선, 다듯토.

export interface ChatConfig {
  enabled: boolean;
  port: number;
  bind: string;
}

function validPort(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null; // NaN,0,음수 무시(기존 env 값 고려)
}

export function loadChatConfig(configDir: string, env: NodeJS.ProcessEnv = process.env): ChatConfig {
  let raw: Partial<ChatConfig> = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(configDir, 'chat.json'), 'utf8')) as Partial<ChatConfig>;
  } catch {
    raw = {};
  }
  const port = (env.ENGRAM_CHAT_PORT ? validPort(env.ENGRAM_CHAT_PORT) : null)
    ?? validPort(raw.port)
    ?? 47800;
  const bind = (typeof env.ENGRAM_CHAT_BIND === 'string' && env.ENGRAM_CHAT_BIND)
    || (typeof raw.bind === 'string' && raw.bind)
    || '127.0.0.1';
  return { enabled: raw.enabled !== false, port, bind };
}
