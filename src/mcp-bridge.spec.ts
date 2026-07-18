import * as http from 'http';
import type { AddressInfo } from 'net';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer, McpDeps } from './edge/mcp/engram-mcp';
import { handleMcpRequest } from './edge/mcp/mcp-http';
import { McpSession, MCP_TOOL_PREFIX } from './brain/mcp-client';
import { makeBridgeServer, parseBridgeArgs } from './mcp-bridge';

const T = (bare: string) => `${MCP_TOOL_PREFIX}bridge__${bare}`;

function makeUpstreamDeps(overrides: Partial<McpDeps> = {}): McpDeps {
  return {
    search: jest.fn().mockResolvedValue([]),
    read: jest.fn().mockResolvedValue(null),
    list: jest.fn().mockResolvedValue([]),
    propose: jest.fn().mockResolvedValue('p1'),
    askBrain: null,
    brainNames: jest.fn().mockReturnValue([]),
    ...overrides,
  };
}

// 실 HTTP로 Task1 buildMcpServer를 Task2 handleMcpRequest를 통해 /mcp에 띄운다(가짜 deps).
async function startUpstream(deps: McpDeps): Promise<{ url: string; close: () => Promise<void> }> {
  const mcpServer = buildMcpServer(deps);
  const httpServer = http.createServer((req, res) => {
    void handleMcpRequest(mcpServer, req, res);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

// makeBridgeServer(url)를 InMemoryTransport로 왕복 — 8c-1의 McpSession.createForTest를 시험용 클라이언트로.
async function connectedBridgeSession(url: string): Promise<McpSession> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await makeBridgeServer(url).connect(serverT);
  const s = McpSession.createForTest('bridge', clientT);
  await s.connect();
  return s;
}

describe('parseBridgeArgs', () => {
  it('--port 인자가 최우선', () => {
    const { url } = parseBridgeArgs(['node', 'mcp-bridge.js', '--port', '9999'], { ENGRAM_PORT: '8888' });
    expect(url).toBe('http://127.0.0.1:9999/mcp');
  });

  it('--port 없으면 ENGRAM_PORT env', () => {
    const { url } = parseBridgeArgs(['node', 'mcp-bridge.js'], { ENGRAM_PORT: '8888' });
    expect(url).toBe('http://127.0.0.1:8888/mcp');
  });

  it('둘 다 없으면 chat.config 기본 포트(47800)', () => {
    const { url } = parseBridgeArgs(['node', 'mcp-bridge.js'], {});
    expect(url).toBe('http://127.0.0.1:47800/mcp');
  });

  it('--port 값이 잘못됐으면(비숫자·범위밖) env로 폴백', () => {
    const { url } = parseBridgeArgs(['node', 'mcp-bridge.js', '--port', 'xyz'], { ENGRAM_PORT: '7000' });
    expect(url).toBe('http://127.0.0.1:7000/mcp');
  });

  it('ENGRAM_PORT 값이 잘못됐으면 기본값으로 폴백', () => {
    const { url } = parseBridgeArgs(['node', 'mcp-bridge.js'], { ENGRAM_PORT: '-1' });
    expect(url).toBe('http://127.0.0.1:47800/mcp');
  });
});

describe('makeBridgeServer', () => {
  it('tools/list 패스스루 — 상주의 위키 도구가 그대로 보임', async () => {
    const upstream = await startUpstream(makeUpstreamDeps());
    try {
      const s = await connectedBridgeSession(upstream.url);
      const defs = await s.listToolDefs();
      const names = defs.map((d) => d.name).sort();
      expect(names).toEqual([T('wiki_list'), T('wiki_propose'), T('wiki_read'), T('wiki_search')].sort());
      await s.close();
    } finally {
      await upstream.close();
    }
  });

  it('wiki_search 호출 패스스루 — 상주 결과 텍스트를 그대로 반환', async () => {
    const search = jest.fn().mockResolvedValue([{ slug: 's1', title: 'Title 1', snippet: 'snip 1' }]);
    const upstream = await startUpstream(makeUpstreamDeps({ search }));
    try {
      const s = await connectedBridgeSession(upstream.url);
      const out = await s.callTool(T('wiki_search'), { query: 'x' });
      expect(search).toHaveBeenCalledWith('x', 5);
      expect(out).toContain('s1');
      expect(out).toContain('Title 1');
      expect(out).toContain('snip 1');
      await s.close();
    } finally {
      await upstream.close();
    }
  });

  it('상주 다운(닫힌 포트) — CallTool은 isError 텍스트, ListTools는 빈 목록(never-throw, 크래시 없음)', async () => {
    // 포트를 확보한 뒤 즉시 닫아 "아무도 안 듣는" 주소를 만든다.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const url = `http://127.0.0.1:${port}/mcp`;

    const s = await connectedBridgeSession(url);
    const defs = await s.listToolDefs();
    expect(defs).toEqual([]);

    const out = await s.callTool(T('wiki_search'), { query: 'x' });
    expect(out.toLowerCase()).toMatch(/error/);
    await s.close();
  });
});
