import * as net from 'net';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpSession, MCP_TOOL_PREFIX, createMcpTransport } from './mcp-client';

interface TestBehavior { slow?: boolean; huge?: boolean; isError?: boolean; image?: boolean }

function makeTestServer(behavior: TestBehavior = {}): Server {
  const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (behavior.slow) await new Promise((r) => setTimeout(r, 500));
    if (behavior.isError) return { content: [{ type: 'text', text: 'boom' }], isError: true };
    if (behavior.image) {
      return {
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', data: '', mimeType: 'image/png' },
          { type: 'text', text: 'b' },
        ],
      };
    }
    const text = behavior.huge ? 'x'.repeat(60_000) : `echo:${(req.params.arguments as { text?: string })?.text ?? ''}`;
    return { content: [{ type: 'text', text }] };
  });
  return server;
}

async function connectedSession(behavior: TestBehavior = {}): Promise<McpSession> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await makeTestServer(behavior).connect(serverT);
  const s = McpSession.createForTest('test', clientT);
  await s.connect();
  return s;
}

describe('McpSession', () => {
  it('connect 성공 → listToolDefs가 mcp__{server}__{tool} 이름/description/parameters로 매핑', async () => {
    const s = await connectedSession();
    const defs = await s.listToolDefs();
    expect(defs).toEqual([
      {
        name: `${MCP_TOOL_PREFIX}test__echo`,
        description: 'echo back',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ]);
    await s.close();
  });

  it('callTool 성공 → content text 항목을 이어붙인 문자열', async () => {
    const s = await connectedSession();
    const out = await s.callTool(`${MCP_TOOL_PREFIX}test__echo`, { text: 'hi' });
    expect(out).toContain('echo:hi');
    await s.close();
  });

  it('비텍스트(image) content 포함 → [image] 같은 마커 삽입', async () => {
    const s = await connectedSession({ image: true });
    const out = await s.callTool(`${MCP_TOOL_PREFIX}test__echo`, {});
    expect(out).toContain('a');
    expect(out).toContain('b');
    expect(out).toMatch(/\[image\]/);
    await s.close();
  });

  it('서버 isError 응답 → 결과 텍스트에 에러 내용 포함(throw 없음)', async () => {
    const s = await connectedSession({ isError: true });
    const out = await s.callTool(`${MCP_TOOL_PREFIX}test__echo`, {});
    expect(out).toContain('boom');
    await s.close();
  });

  it('callTool 타임아웃 → 에러 텍스트 반환(throw 없음)', async () => {
    const s = await connectedSession({ slow: true });
    const out = await s.callTool(`${MCP_TOOL_PREFIX}test__echo`, {}, 50);
    expect(typeof out).toBe('string');
    expect(out.toLowerCase()).toMatch(/error|timeout/);
    await s.close();
  });

  it('출력 상한: 60k 텍스트 응답 → 50k로 절단+절단 표식', async () => {
    const s = await connectedSession({ huge: true });
    const out = await s.callTool(`${MCP_TOOL_PREFIX}test__echo`, {});
    expect(out.length).toBeLessThan(51_000);
    expect(out).toMatch(/truncated|잘림|…/);
    await s.close();
  });

  it('close 멱등(2회 무해), close 후 callTool → 에러 텍스트(throw 없음)', async () => {
    const s = await connectedSession();
    await s.close();
    await expect(s.close()).resolves.toBeUndefined();
    const out = await s.callTool(`${MCP_TOOL_PREFIX}test__echo`, {});
    expect(out).toMatch(/mcp error|not connected/); // 막연한 truthy가 아니라 에러 표식 자체를 단언
  });

  it('connect 실패(링크 안 된/닫힌 transport) → false', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await serverT.close();
    const s = McpSession.createForTest('test', clientT);
    expect(await s.connect()).toBe(false);
  });

  it('connect 무한대기(서버 무응답) → 타임아웃 false (세마포어 스톨 방지)', async () => {
    const [clientT] = InMemoryTransport.createLinkedPair(); // 서버측 미접속 = initialize 영원히 무응답
    const s = McpSession.createForTest('test', clientT);
    expect(await s.connect(150)).toBe(false);
  });

  // T3: http 전송(§3.3) — cfg.url이 있으면 Streamable HTTP, 없으면 기존 Stdio.
  describe('createMcpTransport (http 전송 seam)', () => {
    it('url 항목 → StreamableHTTPClientTransport 생성', () => {
      const t = createMcpTransport({ url: 'http://127.0.0.1:1/mcp', args: [], env: {} });
      expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
      void t.close();
    });

    it('command 항목(url 없음) → 기존대로 StdioClientTransport 생성', () => {
      const t = createMcpTransport({ command: 'node', args: ['-e', '0'], env: {} });
      expect(t).toBeInstanceOf(StdioClientTransport);
    });
  });

  describe('McpSession.create + http 전송 connect', () => {
    // 닫힌(방금 리슨 후 close한) 로컬 포트 = ECONNREFUSED 보장 — 다른 프로세스와 충돌 없이 재현 가능.
    async function closedLocalPort(): Promise<number> {
      const srv = net.createServer();
      const port = await new Promise<number>((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => resolve((srv.address() as net.AddressInfo).port));
      });
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      return port;
    }

    it('연결 거부(닫힌 포트) → connect false, throw 없음, 언핸들드 rejection 없음', async () => {
      const port = await closedLocalPort();
      const s = McpSession.create('remote', { url: `http://127.0.0.1:${port}/mcp`, args: [], env: {} });
      await expect(s.connect(2_000)).resolves.toBe(false);
      await s.close();
    }, 5_000);
  });
});
