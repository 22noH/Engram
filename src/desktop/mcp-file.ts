import * as fs from 'fs';
import * as path from 'path';
import { isValidMcpName } from '../brain/mcp-config';

export interface McpServer {
  name: string;
  command: string;
  args?: string[];
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

// MCP 서버 목록 (설정창 UI용). name·command·args(있으면) 반환.
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
    if (!command) continue;
    const server: McpServer = { name, command };
    if (Array.isArray(s.args) && s.args.length > 0) {
      server.args = (s.args as unknown[]).filter((a): a is string => typeof a === 'string');
      if (server.args.length > 0) {
        result.push(server);
        continue;
      }
    }
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
