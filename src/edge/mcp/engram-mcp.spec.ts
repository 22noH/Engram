import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpSession, MCP_TOOL_PREFIX } from '../../brain/mcp-client';
import { McpDeps, buildMcpServer } from './engram-mcp';

const T = (bare: string) => `${MCP_TOOL_PREFIX}test__${bare}`;

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

async function connectedSession(deps: McpDeps): Promise<McpSession> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(deps).connect(serverT);
  const s = McpSession.createForTest('test', clientT);
  await s.connect();
  return s;
}

describe('buildMcpServer', () => {
  it('tools/list: askBrain 미주입 → 4종(ask_brain 제외)', async () => {
    const s = await connectedSession(makeDeps({ askBrain: null }));
    const defs = await s.listToolDefs();
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(
      [T('wiki_search'), T('wiki_read'), T('wiki_list'), T('wiki_propose')].sort(),
    );
    await s.close();
  });

  it('tools/list: askBrain 주입 → 5종(ask_brain 포함, 설명에 등록 이름 포함)', async () => {
    const deps = makeDeps({
      askBrain: jest.fn().mockResolvedValue('done'),
      brainNames: jest.fn().mockReturnValue(['claude', 'ollama']),
    });
    const s = await connectedSession(deps);
    const defs = await s.listToolDefs();
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(
      [T('wiki_search'), T('wiki_read'), T('wiki_list'), T('wiki_propose'), T('ask_brain')].sort(),
    );
    const askBrainDef = defs.find((d) => d.name === T('ask_brain'));
    expect(askBrainDef?.description).toContain('claude');
    expect(askBrainDef?.description).toContain('ollama');
    await s.close();
  });

  it('wiki_search: 기본 limit 5로 deps.search 호출·결과에 slug/title/snippet', async () => {
    const search = jest.fn().mockResolvedValue([{ slug: 's1', title: 'Title 1', snippet: 'snip 1' }]);
    const s = await connectedSession(makeDeps({ search }));
    const out = await s.callTool(T('wiki_search'), { query: 'x' });
    expect(search).toHaveBeenCalledWith('x', 5);
    expect(out).toContain('s1');
    expect(out).toContain('Title 1');
    expect(out).toContain('snip 1');
    await s.close();
  });

  it('wiki_search: limit 50 → 20으로 클램프', async () => {
    const search = jest.fn().mockResolvedValue([]);
    const s = await connectedSession(makeDeps({ search }));
    await s.callTool(T('wiki_search'), { query: 'x', limit: 50 });
    expect(search).toHaveBeenCalledWith('x', 20);
    await s.close();
  });

  it('wiki_search: 결과 없음 → 에러 아닌 안내 텍스트', async () => {
    const s = await connectedSession(makeDeps({ search: jest.fn().mockResolvedValue([]) }));
    const out = await s.callTool(T('wiki_search'), { query: 'nope' });
    expect(out).not.toMatch(/^mcp error|^tool error/);
    expect(out.toLowerCase()).toContain('no results');
    await s.close();
  });

  it('wiki_read: 존재 slug → title+content', async () => {
    const read = jest.fn().mockResolvedValue({ title: 'My Page', content: 'body text' });
    const s = await connectedSession(makeDeps({ read }));
    const out = await s.callTool(T('wiki_read'), { slug: 'my-page' });
    expect(read).toHaveBeenCalledWith('my-page');
    expect(out).toContain('My Page');
    expect(out).toContain('body text');
    await s.close();
  });

  it('wiki_read: null 반환 slug → isError("not found" 포함)', async () => {
    const s = await connectedSession(makeDeps({ read: jest.fn().mockResolvedValue(null) }));
    const out = await s.callTool(T('wiki_read'), { slug: 'missing' });
    expect(out.toLowerCase()).toContain('not found');
    await s.close();
  });

  it('wiki_list: slug/title(/category) 목록 텍스트', async () => {
    const list = jest.fn().mockResolvedValue([
      { slug: 'a', title: 'A', category: 'cat1' },
      { slug: 'b', title: 'B' },
    ]);
    const s = await connectedSession(makeDeps({ list }));
    const out = await s.callTool(T('wiki_list'), {});
    expect(out).toContain('a');
    expect(out).toContain('A');
    expect(out).toContain('cat1');
    expect(out).toContain('b');
    expect(out).toContain('B');
    await s.close();
  });

  it('wiki_propose: 입력을 deps.propose에 정확 전달·응답에 id와 review 문구', async () => {
    const propose = jest.fn().mockResolvedValue('proposal-42');
    const s = await connectedSession(makeDeps({ propose }));
    const out = await s.callTool(T('wiki_propose'), { title: 'T', content: 'C', reason: 'R' });
    expect(propose).toHaveBeenCalledWith({ title: 'T', content: 'C', reason: 'R' });
    expect(out).toContain('proposal-42');
    expect(out.toLowerCase()).toContain('review');
    expect(out.toLowerCase()).toContain('engram');
    await s.close();
  });

  it('ask_brain: 등록 이름 → deps.askBrain 결과 텍스트', async () => {
    const askBrain = jest.fn().mockResolvedValue('the answer');
    const s = await connectedSession(
      makeDeps({ askBrain, brainNames: jest.fn().mockReturnValue(['claude']) }),
    );
    const out = await s.callTool(T('ask_brain'), { brain: 'claude', task: 'do it' });
    expect(askBrain).toHaveBeenCalledWith('claude', 'do it');
    expect(out).toContain('the answer');
    await s.close();
  });

  it('ask_brain: 미등록 이름 → isError(등록 목록 포함)', async () => {
    const askBrain = jest.fn().mockResolvedValue('unused');
    const s = await connectedSession(
      makeDeps({ askBrain, brainNames: jest.fn().mockReturnValue(['claude', 'ollama']) }),
    );
    const out = await s.callTool(T('ask_brain'), { brain: 'nope', task: 'x' });
    expect(askBrain).not.toHaveBeenCalled();
    expect(out).toContain('claude');
    expect(out).toContain('ollama');
    await s.close();
  });

  it('ask_brain: deps.askBrain null인데 도구 자체가 tools/list에서 빠짐(호출 시도 불가)', async () => {
    const s = await connectedSession(makeDeps({ askBrain: null }));
    const defs = await s.listToolDefs();
    expect(defs.find((d) => d.name === T('ask_brain'))).toBeUndefined();
    await s.close();
  });

  it('출력 상한: deps.read가 60k content → 50k로 절단+표식', async () => {
    const huge = 'x'.repeat(60_000);
    const s = await connectedSession(
      makeDeps({ read: jest.fn().mockResolvedValue({ title: 'Huge', content: huge }) }),
    );
    const out = await s.callTool(T('wiki_read'), { slug: 'huge' });
    expect(out.length).toBeLessThan(51_000);
    expect(out).toMatch(/truncated|잘림|…/);
    await s.close();
  });

  it('deps가 throw → isError 텍스트(never-throw)', async () => {
    const s = await connectedSession(
      makeDeps({ search: jest.fn().mockRejectedValue(new Error('boom')) }),
    );
    const out = await s.callTool(T('wiki_search'), { query: 'x' });
    expect(out.toLowerCase()).toMatch(/error/);
    expect(out).toContain('boom');
    await s.close();
  });
});
