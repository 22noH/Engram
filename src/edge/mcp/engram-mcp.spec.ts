import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
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
    proposals: null,
    write: null,
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

  it('tools/list: proposals 주입 → 7종(list/approve/reject_proposal 추가)', async () => {
    const proposals = {
      list: jest.fn().mockResolvedValue([]),
      approve: jest.fn().mockResolvedValue('ok'),
      reject: jest.fn().mockResolvedValue('ok'),
    };
    const s = await connectedSession(makeDeps({ proposals }));
    const defs = await s.listToolDefs();
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(
      [
        T('wiki_search'), T('wiki_read'), T('wiki_list'), T('wiki_propose'),
        T('list_proposals'), T('approve_proposal'), T('reject_proposal'),
      ].sort(),
    );
    await s.close();
  });

  it('tools/list: proposals 미주입 → 기존 4종 그대로(회귀 없음)', async () => {
    const s = await connectedSession(makeDeps({ proposals: null }));
    const defs = await s.listToolDefs();
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(
      [T('wiki_search'), T('wiki_read'), T('wiki_list'), T('wiki_propose')].sort(),
    );
    await s.close();
  });

  it('tools/list: write 주입 → wiki_write 추가(8종)', async () => {
    const proposals = {
      list: jest.fn().mockResolvedValue([]),
      approve: jest.fn().mockResolvedValue('ok'),
      reject: jest.fn().mockResolvedValue('ok'),
    };
    const write = jest.fn().mockResolvedValue('written');
    const s = await connectedSession(makeDeps({ proposals, write }));
    const defs = await s.listToolDefs();
    const names = defs.map((d) => d.name).sort();
    expect(names).toContain(T('wiki_write'));
    expect(names).toHaveLength(8);
    await s.close();
  });

  it('list_proposals: 결과 텍스트에 id/title/op/targetSlug/preview 포함', async () => {
    const proposals = {
      list: jest.fn().mockResolvedValue([
        { id: 'p1', title: 'My Title', op: 'create', targetSlug: 'my-slug', preview: 'preview text' },
      ]),
      approve: jest.fn(),
      reject: jest.fn(),
    };
    const s = await connectedSession(makeDeps({ proposals }));
    const out = await s.callTool(T('list_proposals'), {});
    expect(out).toContain('p1');
    expect(out).toContain('My Title');
    expect(out).toContain('create');
    expect(out).toContain('my-slug');
    expect(out).toContain('preview text');
    await s.close();
  });

  it('approve_proposal: 성공 시 어댑터 결과를 그대로 통과', async () => {
    const approve = jest.fn().mockResolvedValue('approved: my-slug (create)');
    const proposals = { list: jest.fn(), approve, reject: jest.fn() };
    const s = await connectedSession(makeDeps({ proposals }));
    const out = await s.callTool(T('approve_proposal'), { id: 'p1' });
    expect(approve).toHaveBeenCalledWith('p1');
    expect(out).toContain('approved: my-slug (create)');
    await s.close();
  });

  it('approve_proposal: 어댑터 throw → isError', async () => {
    const approve = jest.fn().mockRejectedValue(new Error('already pending elsewhere'));
    const proposals = { list: jest.fn(), approve, reject: jest.fn() };
    const s = await connectedSession(makeDeps({ proposals }));
    const out = await s.callTool(T('approve_proposal'), { id: 'p1' });
    expect(out.toLowerCase()).toMatch(/error/);
    expect(out).toContain('already pending elsewhere');
    await s.close();
  });

  it('reject_proposal: 성공 시 어댑터 결과를 그대로 통과, 실패 시 isError', async () => {
    const reject = jest.fn().mockResolvedValue('rejected: my-slug');
    const proposals = { list: jest.fn(), approve: jest.fn(), reject };
    const s = await connectedSession(makeDeps({ proposals }));
    const out = await s.callTool(T('reject_proposal'), { id: 'p1' });
    expect(reject).toHaveBeenCalledWith('p1');
    expect(out).toContain('rejected: my-slug');
    await s.close();
  });

  it('proposals 미주입인데 승인 도구 직접 호출 → isError(도구 자체는 tools/list에서 빠짐)', async () => {
    const s = await connectedSession(makeDeps({ proposals: null }));
    const out = await s.callTool(T('list_proposals'), {});
    expect(out.toLowerCase()).toMatch(/error|not available/i);
    await s.close();
  });

  it('wiki_write: {title, content, slug}를 deps.write에 그대로 전달', async () => {
    const write = jest.fn().mockResolvedValue('page written: my-slug');
    const s = await connectedSession(makeDeps({ write }));
    const out = await s.callTool(T('wiki_write'), { title: 'T', content: 'C', slug: 'my-slug' });
    expect(write).toHaveBeenCalledWith({ title: 'T', content: 'C', slug: 'my-slug' });
    expect(out).toContain('page written: my-slug');
    await s.close();
  });

  it('wiki_write: slug 생략 시 deps.write에 slug 없이 전달', async () => {
    const write = jest.fn().mockResolvedValue('page written');
    const s = await connectedSession(makeDeps({ write }));
    await s.callTool(T('wiki_write'), { title: 'T', content: 'C' });
    expect(write).toHaveBeenCalledWith({ title: 'T', content: 'C' });
    await s.close();
  });

  it('wiki_write: write 미주입 → isError(도구 자체는 tools/list에서 빠짐)', async () => {
    const s = await connectedSession(makeDeps({ write: null }));
    const defs = await s.listToolDefs();
    expect(defs.find((d) => d.name === T('wiki_write'))).toBeUndefined();
    const out = await s.callTool(T('wiki_write'), { title: 'T', content: 'C' });
    expect(out.toLowerCase()).toMatch(/error|not available/i);
    await s.close();
  });

  it('approve_proposal 설명에 human-gate 문구(human·explicitly) 포함', async () => {
    const proposals = { list: jest.fn(), approve: jest.fn(), reject: jest.fn() };
    const s = await connectedSession(makeDeps({ proposals }));
    const defs = await s.listToolDefs();
    for (const name of ['approve_proposal', 'reject_proposal']) {
      const def = defs.find((d) => d.name === T(name));
      expect(def?.description?.toLowerCase()).toContain('human');
      expect(def?.description?.toLowerCase()).toContain('explicitly');
    }
    await s.close();
  });

  it('wiki_write 설명에 승인 없이 직접 쓴다는 안내 포함', async () => {
    const write = jest.fn().mockResolvedValue('ok');
    const s = await connectedSession(makeDeps({ write }));
    const defs = await s.listToolDefs();
    const writeDef = defs.find((d) => d.name === T('wiki_write'));
    expect(writeDef?.description?.toLowerCase()).toMatch(/no.*approval|no human approval|without approval/);
    await s.close();
  });
});

describe('prompts (슬래시 명령 노출)', () => {
  async function rawClient(deps: McpDeps): Promise<Client> {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(deps).connect(serverT);
    const c = new Client({ name: 'test', version: '1.0.0' });
    await c.connect(clientT);
    return c;
  }

  it('proposals 미주입 → wiki-search·wiki-save만(승인 계열 제외)', async () => {
    const c = await rawClient(makeDeps());
    const { prompts } = await c.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['wiki-save', 'wiki-search']);
    await c.close();
  });

  it('proposals 주입 → 4종(proposals·approve 포함), approve는 id 필수 인자', async () => {
    const c = await rawClient(makeDeps({ proposals: { list: jest.fn(), approve: jest.fn(), reject: jest.fn() } }));
    const { prompts } = await c.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['approve', 'proposals', 'wiki-save', 'wiki-search']);
    const approve = prompts.find((p) => p.name === 'approve');
    expect(approve?.arguments?.[0]).toMatchObject({ name: 'id', required: true });
    await c.close();
  });

  it('getPrompt: 인자가 지시문에 치환되고 해당 도구 이름을 언급한다', async () => {
    const c = await rawClient(makeDeps());
    const r = await c.getPrompt({ name: 'wiki-search', arguments: { query: 'deploy-steps' } });
    const text = (r.messages[0].content as { text: string }).text;
    expect(text).toContain('deploy-steps');
    expect(text).toContain('wiki_search');
    await c.close();
  });

  it('getPrompt: 없는 이름 → 에러', async () => {
    const c = await rawClient(makeDeps());
    await expect(c.getPrompt({ name: 'nope', arguments: {} })).rejects.toThrow();
    await c.close();
  });
});
