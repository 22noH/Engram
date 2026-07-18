import * as fs from 'fs';
import * as path from 'path';

// MCP 서버 설정(스펙 §3.3) — Claude Code .mcp.json과 동일 포맷(복붙 호환).
export interface McpServerConfig { command: string; args: string[]; env: Record<string, string> }

// 서버 이름은 도구 이름(mcp__{서버}__{도구})에 들어가므로 slug만 허용(프리픽스 파싱 안전, 스펙 §3.6).
// 주의: __proto__/constructor/prototype은 bracket assignment가 조용히 증발시키므로 정규식으로는 부족 — 명시적 검사 필수.
export function isValidMcpName(name: string): boolean {
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') return false;
  return /^[a-z0-9_-]+$/.test(name);
}

export function loadMcpServers(configDir: string): Record<string, McpServerConfig> {
  let raw: { mcpServers?: unknown };
  try { raw = JSON.parse(fs.readFileSync(path.join(configDir, 'mcp.json'), 'utf8')); } catch { return {}; }
  const servers = raw?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};
  const out: Record<string, McpServerConfig> = {};
  for (const name of Object.keys(servers)) {
    if (!isValidMcpName(name)) continue;
    const s = (servers as Record<string, Record<string, unknown>>)[name];
    if (!s || typeof s !== 'object') continue;
    const command = typeof s.command === 'string' ? s.command.trim() : '';
    if (!command) continue;
    const env: Record<string, string> = {};
    if (s.env && typeof s.env === 'object' && !Array.isArray(s.env)) {
      for (const [k, v] of Object.entries(s.env as Record<string, unknown>)) if (typeof v === 'string') env[k] = v;
    }
    out[name] = {
      command,
      args: Array.isArray(s.args) ? (s.args as unknown[]).filter((a): a is string => typeof a === 'string') : [],
      env,
    };
  }
  return out;
}
