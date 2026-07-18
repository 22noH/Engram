import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, CallToolResult, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEFAULT_CHAT_PORT } from './edge/messenger/chat.config';
import { ENGRAM_MCP_INSTRUCTIONS } from './edge/mcp/engram-mcp';

// 독립 stdio↔HTTP 브리지 엔트리(설계 §3.3). 구형(stdio 전용) MCP 클라이언트가 상주의
// /mcp(HTTP, Task 1·2)에 접속할 수 있게 해준다: `node dist/src/mcp-bridge.js [--port N]`.
//
// 연결 전략(둘 중 단순한 쪽 채택): 요청마다 새 SDK Client를 만들어 연결→호출→닫기
// (lazy per-request). 캐시+재연결 로직이 없어 가장 단순하고(ponytail), 상주가 재시작돼도
// 다음 요청이 새로 연결하므로 자동 복구된다 — 캐시 유지가 주는 이득(연결 재사용 비용 절감)보다
// stdio 브리지의 저빈도 호출 특성상 단순함·상주 재시작 내성이 더 값지다.

const UPSTREAM_TIMEOUT_MS = 60_000;

async function withUpstream<T>(url: string, fn: (client: Client) => Promise<T>, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<T> {
  const client = new Client({ name: 'engram-bridge', version: '1.0.0' });
  // ★8b-2 교훈: 언핸들드 'error'는 호스트 크래시 — 구독 필수(mcp-client.ts와 동일 패턴).
  client.onerror = (e) => console.error('[mcp-bridge] client error:', e);
  const transport = new StreamableHTTPClientTransport(new URL(url));
  transport.onerror = (e) => console.error('[mcp-bridge] transport error:', e);
  // ★8a 교훈(스톨 클래스): 거부(ECONNREFUSED)는 즉시 실패하지만 '멈춘' 상주는 영원히 대기
  // — connect+호출 전 구간에 타임아웃(초과 시 catch에서 close로 정리).
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport);
        return fn(client);
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`upstream timeout (${timeoutMs}ms)`)), timeoutMs); }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    try {
      await client.close();
    } catch {
      /* 종료 실패 무해 — 이번 요청은 이미 끝났음 */
    }
  }
}

// 엔트리에서 분리한 순수 조립부(브리프 §요건) — stdio 서버를 만들고 ListTools/CallTool
// 핸들러가 그때그때 상주 /mcp에 연결해 그대로 패스스루. never-throw: 실패해도 stdio 프로토콜은
// 죽지 않는다(CallTool→isError 텍스트, ListTools→빈 목록+stderr 로그, 절대 stdout 아님).
export function makeBridgeServer(url: string): Server {
  // 브리지는 도구만 패스스루라 상주의 instructions가 전달되지 않는다 — 같은 안내문을 직접 싣는다.
  const server = new Server(
    { name: 'engram-bridge', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: ENGRAM_MCP_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
    try {
      return await withUpstream(url, (client) => client.listTools());
    } catch (e) {
      console.error('[mcp-bridge] listTools failed:', e instanceof Error ? e.message : String(e));
      return { tools: [] };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    try {
      return (await withUpstream(url, (client) =>
        client.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} }),
      )) as CallToolResult;
    } catch (e) {
      return {
        content: [{ type: 'text', text: `bridge error: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
  });

  return server;
}

function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= 65535;
}

export function parseBridgeArgs(argv: string[], env: NodeJS.ProcessEnv): { url: string } {
  const idx = argv.indexOf('--port');
  const argPort = idx !== -1 ? Number(argv[idx + 1]) : NaN;
  const envPort = env.ENGRAM_PORT !== undefined ? Number(env.ENGRAM_PORT) : NaN;
  const port = isValidPort(argPort) ? argPort : isValidPort(envPort) ? envPort : DEFAULT_CHAT_PORT;
  return { url: `http://127.0.0.1:${port}/mcp` };
}

// 엔트리(직접 실행될 때만) — require.main===module로 테스트 임포트 시 자동실행 방지.
if (require.main === module) {
  const { url } = parseBridgeArgs(process.argv, process.env);
  const server = makeBridgeServer(url);
  const transport = new StdioServerTransport();
  server.connect(transport).catch((e) => {
    console.error('[mcp-bridge] fatal: failed to start stdio transport:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
