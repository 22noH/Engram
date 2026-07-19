import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isValidMcpName } from './mcp-config';

export interface ClaudeMcpEntry {
  name: string; // slug 검증 통과한 서버명
  command?: string;
  args?: string[];
  env?: Record<string, string>; // stdio형
  url?: string; // http형({type:'http'|'sse', url})
  pluginName?: string; // 플러그인 유래면 플러그인명(디렉터리명)
}

/**
 * Claude의 user 스코프 및 플러그인 MCP 서버 판독.
 * - 소스 ①: <home>/.claude.json의 mcpServers (stdio: {command,args?,env?} 또는 http: {type:'http'|'sse', url})
 * - 소스 ②: <home>/.claude/plugins/installed_plugins.json의 각 플러그인 .mcp.json ({서버명: {command,args?}|{type,url}})
 * 규칙:
 *   - 이름 isValidMcpName 실패·command와 url 둘 다 없음 = 스킵
 *   - 먼저 등록된 이름이 승리 (user 스코프 최우선)
 *   - 플러그인: 알파벳순
 *   - env는 문자열 값만
 *   - command/url은 trim 후 빈 값=스킵
 *   - 파일 없음/깨진 JSON=[]
 */
export function readClaudeMcpServers(home?: string): ClaudeMcpEntry[] {
  const homeDir = home ?? os.homedir();
  const seen = new Set<string>(); // 먼저 등록된 이름 방어(user 승리)
  const entries: ClaudeMcpEntry[] = [];

  // 소스 ①: <home>/.claude.json
  const userMcpServers = readUserMcpServers(homeDir);
  for (const entry of userMcpServers) {
    if (!isValidMcpName(entry.name)) continue;
    if (!entry.command && !entry.url) continue;
    if (!seen.has(entry.name)) {
      entries.push(entry);
      seen.add(entry.name);
    }
  }

  // 소스 ②: <home>/.claude/plugins/installed_plugins.json의 플러그인들
  const pluginMcpServers = readPluginMcpServers(homeDir);
  for (const entry of pluginMcpServers) {
    if (!isValidMcpName(entry.name)) continue;
    if (!entry.command && !entry.url) continue;
    if (!seen.has(entry.name)) {
      entries.push(entry);
      seen.add(entry.name);
    }
  }

  return entries;
}

/** <home>/.claude.json의 mcpServers 파싱 */
function readUserMcpServers(homeDir: string): ClaudeMcpEntry[] {
  const result: ClaudeMcpEntry[] = [];
  const claudeJsonPath = path.join(homeDir, '.claude.json');

  try {
    const raw = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    const servers = raw?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return result;

    for (const name of Object.keys(servers)) {
      if (!Object.prototype.hasOwnProperty.call(servers, name)) continue;
      const entry = parseServerEntry(name, servers[name]);
      if (entry) result.push(entry);
    }
  } catch {
    // 파일 없음/깨진 JSON = 빈 결과, 예외 없음
  }

  return result;
}

/** <home>/.claude/plugins/installed_plugins.json의 플러그인들 파싱 */
function readPluginMcpServers(homeDir: string): ClaudeMcpEntry[] {
  const result: ClaudeMcpEntry[] = [];
  const pluginsJsonPath = path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json');

  let plugins: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(pluginsJsonPath, 'utf8'));
    if (raw?.version === 2 && raw?.plugins && typeof raw.plugins === 'object' && !Array.isArray(raw.plugins)) {
      plugins = raw.plugins;
    } else {
      return result;
    }
  } catch {
    // 파일 없음/깨진 JSON = 빈 결과
    return result;
  }

  // 플러그인명 = registry 키의 @ 앞부분
  // 알파벳순으로 처리
  const pluginKeys = Object.keys(plugins).sort();

  for (const registryKey of pluginKeys) {
    if (!Object.prototype.hasOwnProperty.call(plugins, registryKey)) continue;
    const pluginName = registryKey.split('@')[0];
    const pluginData = plugins[registryKey];

    // 플러그인 배열의 첫 원소만 사용
    if (!Array.isArray(pluginData) || pluginData.length === 0) continue;
    const pluginEntry = pluginData[0];
    if (!pluginEntry || typeof pluginEntry !== 'object') continue;

    const installPath = (pluginEntry as Record<string, unknown>).installPath;
    if (typeof installPath !== 'string' || !installPath.trim()) continue;

    // <installPath>/.mcp.json 읽기
    const mcpJsonPath = path.join(installPath, '.mcp.json');
    let mcpData: Record<string, unknown> = {};

    try {
      mcpData = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
    } catch {
      // 파일 없음/깨진 JSON = skip this plugin
      continue;
    }

    // .mcp.json의 wrapped 형태 처리: { "mcpServers": {...} } 또는 bare: { "server": {...} }
    let mcpServers: Record<string, unknown> = {};
    if (mcpData.mcpServers && typeof mcpData.mcpServers === 'object' && !Array.isArray(mcpData.mcpServers)) {
      mcpServers = mcpData.mcpServers as Record<string, unknown>;
    } else {
      mcpServers = mcpData;
    }

    // 각 서버명 파싱
    for (const serverName of Object.keys(mcpServers)) {
      if (!Object.prototype.hasOwnProperty.call(mcpServers, serverName)) continue;
      const entry = parseServerEntry(serverName, mcpServers[serverName]);
      if (entry) {
        entry.pluginName = pluginName;
        result.push(entry);
      }
    }
  }

  return result;
}

/** 서버명과 설정 객체를 ClaudeMcpEntry로 파싱 (없으면 null) */
function parseServerEntry(name: string, config: unknown): ClaudeMcpEntry | null {
  if (!config || typeof config !== 'object') return null;

  const cfg = config as Record<string, unknown>;

  // stdio 형: {command, args?, env?}
  if (typeof cfg.command === 'string') {
    const command = cfg.command.trim();
    if (!command) return null; // 빈 command 스킵

    const entry: ClaudeMcpEntry = { name, command };

    // args 파싱
    if (Array.isArray(cfg.args)) {
      entry.args = (cfg.args as unknown[]).filter((a): a is string => typeof a === 'string');
    }

    // env 파싱 (문자열 값만)
    if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(cfg.env as Record<string, unknown>)) {
        if (typeof v === 'string') env[k] = v;
      }
      if (Object.keys(env).length > 0) entry.env = env;
    }

    return entry;
  }

  // http/sse 형: {type:'http'|'sse', url}
  if (typeof cfg.url === 'string') {
    const url = cfg.url.trim();
    if (!url) return null; // 빈 url 스킵
    return { name, url };
  }

  return null;
}
