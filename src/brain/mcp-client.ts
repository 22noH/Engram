import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { WebToolDef } from './web-tools';
import { McpServerConfig } from './mcp-config';

export const MCP_TOOL_PREFIX = 'mcp__';
const MAX_OUTPUT = 50_000; // 웹도구와 동일 상한(web-tools.ts FETCH_CHAR_LIMIT)
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

interface ToolContentPart { type?: string; text?: string }

// 공식 SDK Client의 never-throw 래퍼(스펙 §3.2). 실패는 전부 에러 텍스트/false/[]로 되먹인다.
// 설치본(v1.29.0) 확인 결과 브리프 가정과 대체로 일치 — 상세 편차는 task-2-report.md 참고.
export class McpSession {
  private client: Client | null = null;
  private closed = false;

  private constructor(
    private readonly name: string,
    private readonly makeTransport: () => Transport,
  ) {}

  static create(name: string, cfg: McpServerConfig): McpSession {
    return new McpSession(
      name,
      () =>
        new StdioClientTransport({
          command: cfg.command,
          args: cfg.args,
          env: { ...getDefaultEnvironment(), ...cfg.env }, // 기본 안전 env(PATH 등) + 사용자 env
        }),
    );
  }

  static createForTest(name: string, transport: Transport): McpSession {
    return new McpSession(name, () => transport);
  }

  async connect(): Promise<boolean> {
    try {
      const c = new Client({ name: 'engram', version: '1.0.0' });
      // ★8b-2 교훈: 언핸들드 'error' 이벤트=호스트 크래시. v1.29.0의 Client/Transport는
      // EventEmitter가 아니라 onerror 콜백 프로퍼티 노출 → 반드시 구독.
      c.onerror = (e) => console.error(`[mcp:${this.name}] client error:`, e);
      const transport = this.makeTransport();
      transport.onerror = (e) => console.error(`[mcp:${this.name}] transport error:`, e);
      await c.connect(transport);
      this.client = c;
      return true;
    } catch (e) {
      console.error(`[mcp:${this.name}] connect failed:`, e);
      return false;
    }
  }

  async listToolDefs(): Promise<WebToolDef[]> {
    if (!this.client) return [];
    try {
      const { tools } = await this.client.listTools();
      return tools.map((t) => ({
        name: `${MCP_TOOL_PREFIX}${this.name}__${t.name}`,
        description: t.description ?? '',
        parameters: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
      }));
    } catch (e) {
      console.error(`[mcp:${this.name}] listTools failed:`, e);
      return [];
    }
  }

  owns(toolName: string): boolean {
    return toolName.startsWith(`${MCP_TOOL_PREFIX}${this.name}__`);
  }

  async callTool(toolName: string, input: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<string> {
    if (!this.client) return `mcp error: ${this.name} not connected`;
    const prefix = `${MCP_TOOL_PREFIX}${this.name}__`;
    const bare = toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
    try {
      const res = await this.client.callTool(
        { name: bare, arguments: (input ?? {}) as Record<string, unknown> },
        undefined,
        { timeout: timeoutMs },
      );
      const parts = Array.isArray(res.content) ? (res.content as ToolContentPart[]) : [];
      let text = parts
        .map((p) => (p.type === 'text' && typeof p.text === 'string' ? p.text : `[${p.type ?? 'unknown'}]`))
        .join('\n');
      if (res.isError) text = `tool error: ${text}`;
      if (text.length > MAX_OUTPUT) text = text.slice(0, MAX_OUTPUT) + '\n…(truncated)';
      return text;
    } catch (e) {
      return `mcp error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client?.close();
    } catch {
      /* 종료 실패 무해 */
    }
    this.client = null;
  }
}
