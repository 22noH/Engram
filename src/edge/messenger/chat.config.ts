import * as fs from 'fs';
import * as path from 'path';

// 자체 채팅 서버 설정(스펙 §3). 기본 = 가동·127.0.0.1:47800. enabled:false만 끔.
// 비밀 아님(토큰 없음) — env는 포트/바인딩 오버라이드 용도.

export interface ChatConfig {
  enabled: boolean;
  port: number;
  bind: string;
}

function validPort(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null; // NaN·0·음수·소수 → 무시(기존 env 가드 관례)
}

export function loadChatConfig(configDir: string, env: NodeJS.ProcessEnv = process.env): ChatConfig {
  let raw: Partial<ChatConfig> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, 'chat.json'), 'utf8')) as unknown;
    // JSON.parse는 'null'/'123' 같은 비객체도 유효 JSON으로 통과 — 객체만 수용(fault-tolerant).
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Partial<ChatConfig>;
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
