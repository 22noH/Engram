import * as fs from 'fs';
import * as path from 'path';

// 자체 채팅 서버 설정(스펙 §3). 기본 = 가동·127.0.0.1:47800. enabled:false만 끔.
// env는 포트/바인딩 오버라이드. 인증은 계정(Phase 16a) — 공유 토큰은 폐기.

export interface ChatConfig {
  enabled: boolean;
  port: number;
  bind: string;
  language?: string; // BCP-47 코드(예 'ko'/'en'). 미설정=OS 로케일 폴백(main.ts).
  role: 'server' | 'brain'; // brain=계정·team·위키승인 미탑재, 127.0.0.1 고정(Phase 16a 스펙 §2.1).
}

function validPort(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null; // NaN·0·음수·소수·65535 초과 → 무시(기존 env 가드 관례)
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
  const role: 'server' | 'brain' = (env.ENGRAM_CHAT_ROLE === 'brain' || raw.role === 'brain') ? 'brain' : 'server';
  const bind = role === 'brain' ? '127.0.0.1' : (
    (typeof env.ENGRAM_CHAT_BIND === 'string' && env.ENGRAM_CHAT_BIND)
    || (typeof raw.bind === 'string' && raw.bind)
    || '127.0.0.1'
  );
  const language = typeof raw.language === 'string' && raw.language.trim() ? raw.language.trim() : undefined;
  return { enabled: raw.enabled !== false, port, bind, language, role };
}
