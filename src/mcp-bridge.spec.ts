import * as http from 'http';
import type { AddressInfo } from 'net';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer, McpDeps } from './edge/mcp/engram-mcp';
import { handleMcpRequest } from './edge/mcp/mcp-http';
import { McpSession, MCP_TOOL_PREFIX } from './brain/mcp-client';
import { makeBridgeServer, parseBridgeArgs, withChannelIdentity } from './mcp-bridge';
import { APP_CHANNEL_ENV, APP_RESIDENT_ENV, ELICIT_HUMAN_MIN_MS_ENV } from './edge/mcp/mcp-elicit';
import { CHANNEL_ARG } from '../shared/browser-ops';

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

// ★브리지 elicitation(2026-07-25): 상주 /mcp는 stateless HTTP라 서버→클라이언트 요청을 실을 수
// 없다(mcp-http.ts에서 disableElicitation) — 그래서 승인 대화상자는 stdio를 쥔 브리지가 직접 띄운다.
describe('makeBridgeServer — elicitation 승인 게이트', () => {
  type ElicitHandler = (params: Record<string, unknown>) => unknown;

  // 테스트 위생(engram-mcp.spec.ts와 동일 근거): 앱이 띄운 셸에서 돌려도 결과가 뒤집히지 않게.
  const APP_ENVS = [APP_RESIDENT_ENV, APP_CHANNEL_ENV];
  let savedAppEnv: Array<string | undefined> = [];
  beforeEach(() => {
    savedAppEnv = APP_ENVS.map((k) => process.env[k]);
    APP_ENVS.forEach((k) => delete process.env[k]);
  });
  afterEach(() => {
    APP_ENVS.forEach((k, i) => {
      const v = savedAppEnv[i];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  });

  async function elicitingBridgeClient(url: string, handler: ElicitHandler): Promise<Client> {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await makeBridgeServer(url).connect(serverT);
    const c = new Client({ name: 'elicit-test', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    c.setRequestHandler(ElicitRequestSchema, async (req) => handler(req.params as Record<string, unknown>) as never);
    await c.connect(clientT);
    return c;
  }

  async function callText(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
    const r = (await c.callTool({ name, arguments: args })) as { content: Array<{ text?: string }> };
    return r.content.map((x) => x.text ?? '').join('\n');
  }

  it('승인 → 상류로 그대로 전달(대화상자는 브리지에서 1회만)', async () => {
    const propose = jest.fn().mockResolvedValue('p-bridge');
    const upstream = await startUpstream(makeUpstreamDeps({ propose }));
    try {
      const seen: Array<Record<string, unknown>> = [];
      const c = await elicitingBridgeClient(upstream.url, (p) => {
        seen.push(p);
        return { action: 'accept', content: { decision: 'save' } };
      });
      const out = await callText(c, 'wiki_propose', { title: 'Deploy Steps', content: 'body', slug: 'ops' });
      expect(seen).toHaveLength(1); // 상류에서 중복으로 묻지 않는다
      expect(String(seen[0].message)).toContain('Deploy Steps');
      expect(propose).toHaveBeenCalledWith({ title: 'Deploy Steps', content: 'body', slug: 'ops' });
      expect(out).toContain('p-bridge');
      await c.close();
    } finally {
      await upstream.close();
    }
  });

  // 사람이 실제로 누른 거부만 존중한다. 목 클라이언트는 0ms에 답하므로 문턱을 꺼서(0) "사람이
  // 답했다"로 만든다 — 끄지 않으면 아래 자동응답 폴백 케이스와 구분되지 않는다.
  it('사람이 답한 거부 → 상류를 아예 호출하지 않고 명확한 결과 텍스트', async () => {
    const propose = jest.fn().mockResolvedValue('never');
    const upstream = await startUpstream(makeUpstreamDeps({ propose }));
    process.env[ELICIT_HUMAN_MIN_MS_ENV] = '0';
    try {
      const c = await elicitingBridgeClient(upstream.url, () => ({ action: 'decline' }));
      const out = await callText(c, 'wiki_propose', { title: 'T', content: 'C' });
      expect(propose).not.toHaveBeenCalled();
      expect(out.toLowerCase()).toContain('declined');
      await c.close();
    } finally {
      delete process.env[ELICIT_HUMAN_MIN_MS_ENV];
      await upstream.close();
    }
  });

  // ★2026-07-26 실사고(브리지 경로도 동일): 사람에게 못 묻는 클라이언트가 cancel이 아니라 decline으로
  // 답하면 저장이 통째로 막혔다. 사람이 누를 수 없는 속도의 decline은 제안 큐로 폴백한다.
  it('사람이 누를 수 없는 속도의 decline → 폴백해서 상류에 제안이 만들어진다', async () => {
    const propose = jest.fn().mockResolvedValue('p-bridge-fallback');
    const upstream = await startUpstream(makeUpstreamDeps({ propose }));
    try {
      const c = await elicitingBridgeClient(upstream.url, () => ({ action: 'decline' }));
      const out = await callText(c, 'wiki_propose', { title: 'T', content: 'C' });
      expect(propose).toHaveBeenCalledWith({ title: 'T', content: 'C' });
      expect(out).toContain('p-bridge-fallback');
      await c.close();
    } finally {
      await upstream.close();
    }
  });

  it('미지원 클라이언트 → 기존 패스스루 그대로(회귀 0)', async () => {
    const propose = jest.fn().mockResolvedValue('p-plain');
    const upstream = await startUpstream(makeUpstreamDeps({ propose }));
    try {
      const s = await connectedBridgeSession(upstream.url);
      const out = await s.callTool(T('wiki_propose'), { title: 'T', content: 'C' });
      expect(propose).toHaveBeenCalledWith({ title: 'T', content: 'C' });
      expect(out).toBe('proposal p-plain created — a human will review it in the Engram app');
      await s.close();
    } finally {
      await upstream.close();
    }
  });

  it('읽기 도구는 묻지 않는다', async () => {
    const upstream = await startUpstream(makeUpstreamDeps());
    try {
      const seen: unknown[] = [];
      const c = await elicitingBridgeClient(upstream.url, (p) => {
        seen.push(p);
        return { action: 'accept' };
      });
      await callText(c, 'wiki_search', { query: 'x' });
      expect(seen).toHaveLength(0);
      await c.close();
    } finally {
      await upstream.close();
    }
  });

  // ★회귀 수정(2026-07-25) — 이 브리지가 바로 앱의 두뇌가 지나는 길이다: 상주 → claude -p →
  // (env 상속) → 이 stdio 브리지. 헤드리스 claude는 elicitation을 선언하고도 사람이 없어 즉시
  // cancel로 답한다(실측) — 그때 앱의 저장이 통째로 막혔던 사고. 앱 표식이 있으면 묻지 않는다.
  it('앱 내부 호출(ENGRAM_RESIDENT) → 대화상자 없이 상류로 그대로 전달', async () => {
    process.env[APP_RESIDENT_ENV] = '1';
    const upstream = await startUpstream(makeUpstreamDeps({ propose: jest.fn().mockResolvedValue('p-app') }));
    try {
      const seen: unknown[] = [];
      const c = await elicitingBridgeClient(upstream.url, (p) => {
        seen.push(p);
        return { action: 'cancel' };
      });
      const out = await callText(c, 'wiki_propose', { title: 'T', content: 'C' });
      expect(seen).toHaveLength(0);
      expect(out).toContain('p-app');
      await c.close();
    } finally {
      delete process.env[APP_RESIDENT_ENV];
      await upstream.close();
    }
  });

  it('외부 헤드리스 클라이언트(사람 없음 → cancel) → 거부가 아니라 상류 제안 큐로 폴백', async () => {
    const propose = jest.fn().mockResolvedValue('p-fallback');
    const upstream = await startUpstream(makeUpstreamDeps({ propose }));
    try {
      const c = await elicitingBridgeClient(upstream.url, () => ({ action: 'cancel' }));
      const out = await callText(c, 'wiki_propose', { title: 'T', content: 'C' });
      expect(propose).toHaveBeenCalledWith({ title: 'T', content: 'C' });
      expect(out).toContain('p-fallback');
      await c.close();
    } finally {
      await upstream.close();
    }
  });
});

// ★AI 웹 조작(2단계) — 채널 정체성 바인딩. 이 브리지가 유일한 통로다(파일 상단 주석 참조).
describe('withChannelIdentity — 스폰 env의 채널 id를 browser_* 인자에 실어준다', () => {
  it('browser 도구 + env 있음 → _channel이 붙는다', () => {
    const out = withChannelIdentity('browser_click', { target: '#a' }, { ENGRAM_CHANNEL_ID: 'chan-42' });
    expect(out).toEqual({ target: '#a', [CHANNEL_ARG]: 'chan-42' });
  });

  it('env 없음 → 붙이지 않는다(상류가 정직하게 실패한다 — 추측 금지)', () => {
    const args = { target: '#a' };
    expect(withChannelIdentity('browser_click', args, {})).toEqual({ target: '#a' });
    expect(withChannelIdentity('browser_click', args, { ENGRAM_CHANNEL_ID: '   ' })).toEqual({ target: '#a' });
  });

  it('모델이 보낸 _channel은 신뢰하지 않고 env 값으로 덮어쓴다(남의 화면 조작 차단)', () => {
    const out = withChannelIdentity('browser_click', { target: '#a', [CHANNEL_ARG]: 'victim' }, { ENGRAM_CHANNEL_ID: 'mine' });
    expect(out[CHANNEL_ARG]).toBe('mine');
  });

  it('browser가 아닌 도구는 인자를 손대지 않는다(같은 객체 그대로 — 회귀 0)', () => {
    const args = { query: 'x' };
    expect(withChannelIdentity('wiki_search', args, { ENGRAM_CHANNEL_ID: 'chan-42' })).toBe(args);
  });
});
