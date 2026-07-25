import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer, McpDeps } from './engram-mcp';
import type { BrowserOp } from '../../../shared/browser-ops';
import { CHANNEL_ARG } from '../../../shared/browser-ops';

// AI 웹 조작(2단계)의 MCP 경로 — ★채널 정체성이 없으면 아무것도 하지 않는다는 계약을 못박는다.

function baseDeps(): McpDeps {
  return {
    search: async () => [],
    read: async () => null,
    list: async () => [],
    propose: async () => 'p1',
    askBrain: null,
    brainNames: () => [],
  };
}

async function connect(deps: McpDeps): Promise<Client> {
  const server = buildMcpServer(deps);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientT);
  return client;
}

function textOf(r: unknown): string {
  const c = (r as { content?: Array<{ text?: string }> }).content ?? [];
  return c.map((x) => x.text ?? '').join('');
}

describe('engram MCP — browser 도구', () => {
  it('browser 미배선이면 도구 자체가 안 뜬다(회귀 0)', async () => {
    const client = await connect(baseDeps());
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name.startsWith('browser_'))).toBe(false);
  });

  it('배선되면 7종이 뜨고, 스키마에 _channel은 노출되지 않는다(모델이 채널을 지목 못 하게)', async () => {
    const client = await connect({ ...baseDeps(), browser: async () => ({ ok: true, text: 'ok' }) });
    const { tools } = await client.listTools();
    const browserTools = tools.filter((t) => t.name.startsWith('browser_'));
    expect(browserTools).toHaveLength(7);
    for (const t of browserTools) {
      expect(JSON.stringify(t.inputSchema)).not.toContain(CHANNEL_ARG);
    }
  });

  it('★_channel이 없으면 실행하지 않고 정직하게 실패한다(추측 금지)', async () => {
    const calls: string[] = [];
    const client = await connect({
      ...baseDeps(),
      browser: async (channelId) => { calls.push(channelId); return { ok: true, text: 'done' }; },
    });
    const r = await client.callTool({ name: 'browser_click', arguments: { target: '#a' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/no channel identity/);
    expect(calls).toEqual([]); // 조작이 실제로 일어나면 안 된다
  });

  it('_channel이 있으면 그 채널로만 조작이 간다', async () => {
    const seen: Array<{ channelId: string; op: BrowserOp }> = [];
    const client = await connect({
      ...baseDeps(),
      browser: async (channelId, op) => { seen.push({ channelId, op }); return { ok: true, text: 'clicked' }; },
    });
    const r = await client.callTool({ name: 'browser_click', arguments: { target: 'text=로그인', [CHANNEL_ARG]: 'chan-A' } });
    expect(textOf(r)).toBe('clicked');
    expect(seen).toEqual([{ channelId: 'chan-A', op: { kind: 'click', target: 'text=로그인' } }]);
  });

  it('두 채널이 각자 자기 칸만 조작한다', async () => {
    const seen: string[] = [];
    const client = await connect({
      ...baseDeps(),
      browser: async (channelId) => { seen.push(channelId); return { ok: true, text: 'ok' }; },
    });
    await client.callTool({ name: 'browser_read', arguments: { [CHANNEL_ARG]: 'chan-A' } });
    await client.callTool({ name: 'browser_read', arguments: { [CHANNEL_ARG]: 'chan-B' } });
    expect(seen).toEqual(['chan-A', 'chan-B']);
  });

  it('인자가 틀리면 조작 없이 사유를 돌려준다', async () => {
    const calls: string[] = [];
    const client = await connect({
      ...baseDeps(),
      browser: async (c) => { calls.push(c); return { ok: true, text: 'ok' }; },
    });
    const r = await client.callTool({ name: 'browser_navigate', arguments: { [CHANNEL_ARG]: 'c1' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/url\(string\) required/);
    expect(calls).toEqual([]);
  });

  it('실행 실패(ok:false)는 isError로 전달된다', async () => {
    const client = await connect({ ...baseDeps(), browser: async () => ({ ok: false, text: 'blocked: password field' }) });
    const r = await client.callTool({ name: 'browser_type', arguments: { target: '#p', text: 'x', [CHANNEL_ARG]: 'c1' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/password field/);
  });
});
