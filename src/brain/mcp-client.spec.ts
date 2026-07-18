import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpSession, MCP_TOOL_PREFIX } from './mcp-client';

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
});
