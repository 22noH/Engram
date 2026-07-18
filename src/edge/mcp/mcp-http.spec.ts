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

  it('연속 POST(initialize→tools/list)가 같은 server 인스턴스 재사용으로 정상 처리됨', async () => {
    const mcpServer = buildMcpServer(makeDeps());
    const httpServer = http.createServer((req, res) => {
      void handleMcpRequest(mcpServer, req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    try {
      const client = new Client({ name: 'test-client-2', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
      await client.connect(transport);
      const first = await client.listTools();
      const second = await client.listTools();
      expect(first.tools.length).toBe(second.tools.length);
      await client.close();
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
