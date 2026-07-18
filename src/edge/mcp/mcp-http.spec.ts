import * as http from 'http';
import type { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { isLoopback, handleMcpRequest } from './mcp-http';
import { buildMcpServer, McpDeps } from './engram-mcp';

describe('isLoopback', () => {
  it('127.0.0.1/::1/::ffff:127.0.0.1 → true', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
  });
  it('원격 주소/undefined → false', () => {
    expect(isLoopback('192.168.0.5')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});

function makeDeps(overrides: Partial<McpDeps> = {}): McpDeps {
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

describe('handleMcpRequest', () => {
  it('실 HTTP 왕복: initialize + tools/list', async () => {
    const mcpServer = buildMcpServer(makeDeps());
    const httpServer = http.createServer((req, res) => {
      void handleMcpRequest(mcpServer, req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    try {
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['wiki_list', 'wiki_propose', 'wiki_read', 'wiki_search']);
      await client.close();
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('GET/DELETE → 405(stateless — SDK 권장 패턴, server 재사용을 위해 SSE 미허용)', async () => {
    const mcpServer = buildMcpServer(makeDeps());
    const httpServer = http.createServer((req, res) => {
      void handleMcpRequest(mcpServer, req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    try {
      const getRes = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'GET', headers: { accept: 'text/event-stream' } });
      expect(getRes.status).toBe(405);
      const delRes = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'DELETE' });
      expect(delRes.status).toBe(405);
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('동시 POST 2건(한쪽 200ms 지연) — 요청별 server 생성으로 둘 다 성공(경합 회귀)', async () => {
    // server를 요청 간 공유하면 SDK Protocol.connect()가 "Already connected"를 던져 두 번째가
    // 500이 된다 — 요청별 buildMcpServer(self.adapter와 동일 사용법)로 경합이 없음을 고정.
    const deps = makeDeps({
      search: jest.fn().mockImplementation(async (query: string) => {
        if (query === 'slow') {
          await new Promise((r) => setTimeout(r, 200));
          return [{ slug: 'slow', title: 'Slow', snippet: 's' }];
        }
        return [{ slug: 'fast', title: 'Fast', snippet: 'f' }];
      }),
    });
    const httpServer = http.createServer((req, res) => {
      void handleMcpRequest(buildMcpServer(deps), req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    try {
      const url = `http://127.0.0.1:${port}/mcp`;
      const a = new Client({ name: 'client-a', version: '1.0.0' });
      await a.connect(new StreamableHTTPClientTransport(new URL(url)));
      const b = new Client({ name: 'client-b', version: '1.0.0' });
      await b.connect(new StreamableHTTPClientTransport(new URL(url)));
      // a의 slow 호출이 서버를 점유하는 동안 b의 fast 호출이 겹치게 발사.
      const [ra, rb] = await Promise.all([
        a.callTool({ name: 'wiki_search', arguments: { query: 'slow' } }),
        (async () => {
          await new Promise((r) => setTimeout(r, 50)); // slow가 확실히 in-flight인 시점
          return b.callTool({ name: 'wiki_search', arguments: { query: 'fast' } });
        })(),
      ]);
      expect(ra.isError).toBeFalsy();
      expect(rb.isError).toBeFalsy();
      expect(JSON.stringify(ra.content)).toContain('slow');
      expect(JSON.stringify(rb.content)).toContain('fast');
      await a.close();
      await b.close();
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('never-throw: server.connect가 던져도 응답은 500으로 흡수(상주 불사)', async () => {
    const brokenServer = { connect: async () => { throw new Error('boom'); } } as unknown as Server;
    const httpServer = http.createServer((req, res) => {
      void handleMcpRequest(brokenServer, req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
      });
      expect(res.status).toBe(500);
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
