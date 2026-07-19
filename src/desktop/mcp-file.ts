import * as fs from 'fs';
import * as path from 'path';
import { isValidMcpName } from '../brain/mcp-config';
import type { ClaudeMcpEntry } from '../brain/claude-mcp-import';

export interface McpServer {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  source?: 'claude';
}

// mcp.json 읽기(fault-tolerant, 없거나 깨짐 → 기본 골격 {mcpServers:{}}).
function readMcpConfig(configDir: string): { mcpServers?: Record<string, unknown> } & Record<string, unknown> {
  const file = path.join(configDir, 'mcp.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch {
    // 없거나 깨짐 → 기본 골격
  }
  return { mcpServers: {} };
}

// MCP 서버 목록 (설정창 UI용). name·command 또는 url(command 없는 http형)·args(있으면)·
// source(클로드 미러 항목이면 'claude') 반환.
export function listMcpServersFile(configDir: string): McpServer[] {
  const cfg = readMcpConfig(configDir);
  const servers = cfg.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];

  const result: McpServer[] = [];
  for (const name of Object.keys(servers)) {
    if (!Object.prototype.hasOwnProperty.call(servers, name)) continue;
    const s = (servers as Record<string, Record<string, unknown>>)[name];
    if (!s || typeof s !== 'object') continue;
    const command = typeof s.command === 'string' ? s.command.trim() : '';
    const url = typeof s.url === 'string' ? s.url.trim() : '';
    if (!command && !url) continue; // 둘 다 없으면 표시할 게 없음 — 스킵

    const server: McpServer = { name };
    if (command) {
      server.command = command;
      const args = Array.isArray(s.args) ? (s.args as unknown[]).filter((a): a is string => typeof a === 'string') : [];
      if (args.length > 0) server.args = args; // 빈 args는 키 자체 생략(Claude Code 포맷 관례)
    } else {
      server.url = url;
    }
    if (s.source === 'claude') server.source = 'claude';
    result.push(server);
  }
  return result;
}

// MCP 서버 추가. 규칙: 이름 검증(isValidMcpName)·충돌 검사(hasOwnProperty)·command 공백 거부 → false·무변경.
// argsLine 공백분리: trim() → split(/\s+/) → 결과 empty면 배열 []로, JSON에서 args 키 생략.
export function addMcpServer(configDir: string, name: string, command: string, argsLine: string): boolean {
  // 이름 검증
  if (!isValidMcpName(name)) return false;

  // 명령 검증(공백 제거)
  const trimmedCmd = typeof command === 'string' ? command.trim() : '';
  if (!trimmedCmd) return false;

  // 파일 읽기(fault-tolerant)
  const cfg = readMcpConfig(configDir);
  let servers = cfg.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    servers = {};
    Object.defineProperty(cfg, 'mcpServers', { value: servers, enumerable: true, writable: true, configurable: true });
  }

  // 충돌 검사(hasOwnProperty 필수 — 'in' 금지)
  if (Object.prototype.hasOwnProperty.call(servers, name)) return false;

  // argsLine 파싱
  const args = argsLine.trim() ? argsLine.trim().split(/\s+/) : [];

  // 서버 객체 생성
  const server: Record<string, unknown> = { command: trimmedCmd };
  if (args.length > 0) {
    server.args = args;
  }

  // own property로 대입(__proto__ 같은 이름도 보호)
  Object.defineProperty(servers, name, { value: server, enumerable: true, writable: true, configurable: true });

  // 파일 저장(다른 최상위 필드 보존)
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'mcp.json'), JSON.stringify(cfg, null, 2));
  return true;
}

// 클로드 MCP 미러 병합(스펙 §3.2). mcp.json을 source='claude' 항목의 소유자로 삼는다:
// ①기존 source==='claude' 항목 전부 제거 ②entries를 source:'claude'로 재삽입(stdio는
// {command,args,env,source}·http는 {url,source}) ③이름이 수동 항목(source 없음)과 겹치면
// 스킵+console.warn(수동 승리) ④그 외 top-level 키·수동 항목 보존. 쓰기 실패=warn(throw 금지).
// 변경 추적: 기존 claude 항목 삭제 또는 신규 항목 삽입 시만 저장(무변경 시 쓰기 생략).
export function mirrorClaudeMcp(configDir: string, entries: ClaudeMcpEntry[]): void {
  const cfg = readMcpConfig(configDir);
  let servers = cfg.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    servers = {};
    Object.defineProperty(cfg, 'mcpServers', { value: servers, enumerable: true, writable: true, configurable: true });
  }

  let changed = false;

  // ① source==='claude'인 기존 항목 전부 제거(다음 동기화에서 새로 채움)
  for (const name of Object.keys(servers)) {
    if (!Object.prototype.hasOwnProperty.call(servers, name)) continue;
    const s = (servers as Record<string, Record<string, unknown>>)[name];
    if (s && typeof s === 'object' && !Array.isArray(s) && s.source === 'claude') {
      delete (servers as Record<string, unknown>)[name];
      changed = true;
    }
  }

  // ② entries를 source:'claude'로 삽입 — 이름이 (남은=수동) 항목과 겹치면 스킵+warn
  for (const entry of entries) {
    if (!isValidMcpName(entry.name)) continue;
    if (Object.prototype.hasOwnProperty.call(servers, entry.name)) {
      console.warn(`[mcp-file] 클로드 MCP 미러 스킵: '${entry.name}' 이름이 수동 등록 항목과 충돌`);
      continue;
    }

    const command = typeof entry.command === 'string' ? entry.command.trim() : '';
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!command && !url) continue; // 방어적 재검증(호출자가 이미 걸렀을 것)

    const server: Record<string, unknown> = command
      ? { command, args: entry.args ?? [], env: entry.env ?? {}, source: 'claude' }
      : { url, source: 'claude' };

    // own property로 대입(__proto__ 같은 이름도 보호)
    Object.defineProperty(servers, entry.name, { value: server, enumerable: true, writable: true, configurable: true });
    changed = true;
  }

  // ③ 변경이 있었으면 저장(다른 top-level 키·수동 항목 보존) — 쓰기 실패는 throw 금지, warn만
  if (changed) {
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'mcp.json'), JSON.stringify(cfg, null, 2));
    } catch (e) {
      console.warn(`[mcp-file] mcp.json 저장 실패: ${String(e)}`);
    }
  }
}

// MCP 서버 제거(멱등, 없으면 no-op, 다른 필드 보존).
export function removeMcpServer(configDir: string, name: string): void {
  const file = path.join(configDir, 'mcp.json');
  let cfg: { mcpServers?: Record<string, unknown> } & Record<string, unknown>;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }

  if (!cfg || typeof cfg !== 'object') return;
  const servers = cfg.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return;

  // hasOwnProperty로 검사(없으면 no-op)
  if (!Object.prototype.hasOwnProperty.call(servers, name)) return;

  delete (servers as Record<string, unknown>)[name];
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}
