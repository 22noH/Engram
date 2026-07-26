import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpSession, MCP_TOOL_PREFIX } from '../../brain/mcp-client';
import { McpDeps, buildMcpServer, ENGRAM_MCP_INSTRUCTIONS } from './engram-mcp';
import {
  disableElicitation,
  APP_CHANNEL_ENV,
  APP_RESIDENT_ENV,
  ELICIT_HUMAN_MIN_MS_ENV,
  ELICIT_OFF_ENV,
  ELICIT_TIMEOUT_ENV,
} from './mcp-elicit';

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
  it('initialize: instructions로 선제 저장 제안 안내를 클라이언트에 전달', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(makeDeps()).connect(serverT);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientT);
    expect(client.getInstructions()).toBe(ENGRAM_MCP_INSTRUCTIONS);
    expect(ENGRAM_MCP_INSTRUCTIONS).toContain('wiki_propose');
    await client.close();
  });

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

  it('tools/list: searchFallback 미지정 → wiki_search 설명은 기본 문구 그대로(브리지·앱 무변경)', async () => {
    const s = await connectedSession(makeDeps());
    const defs = await s.listToolDefs();
    const wikiSearchDef = defs.find((d) => d.name === T('wiki_search'));
    expect(wikiSearchDef?.description).toContain('Semantic search');
    expect(wikiSearchDef?.description).not.toContain('offline');
    await s.close();
  });

  it('tools/list: searchFallback:true → wiki_search 설명에 오프라인 텍스트폴백 안내 추가(근본픽스 2026-07-20)', async () => {
    const s = await connectedSession(makeDeps({ searchFallback: true }));
    const defs = await s.listToolDefs();
    const wikiSearchDef = defs.find((d) => d.name === T('wiki_search'));
    expect(wikiSearchDef?.description).toContain('Semantic search'); // 기본 설명은 유지(덧붙임이지 교체가 아님)
    expect(wikiSearchDef?.description).toContain('offline');
    expect(wikiSearchDef?.description?.toLowerCase()).toContain('text match');
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

  it('wiki_propose: 입력을 deps.propose에 정확 전달·응답에 id와 승인 대기 문구', async () => {
    const propose = jest.fn().mockResolvedValue('proposal-42');
    const s = await connectedSession(makeDeps({ propose }));
    const out = await s.callTool(T('wiki_propose'), { title: 'T', content: 'C', reason: 'R' });
    expect(propose).toHaveBeenCalledWith({ title: 'T', content: 'C', reason: 'R' });
    expect(out).toContain('proposal-42');
    // 물어보지 못한 경로 = 아직 승인 전. 모델이 "저장됐다"로 오인하지 않게 대기 상태를 명시한다.
    expect(out.toLowerCase()).toContain('queued');
    expect(out.toLowerCase()).toContain('approve');
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

  // 실사고(2026-07-26): annotations를 하나도 안 달아 자동모드 클라이언트가 wiki_propose를 조용히 거부했다.
  // MCP 스펙상 destructiveHint 기본값이 true라, 신고하지 않으면 전부 "파괴적일 수 있음"이 된다.
  // 이 테스트는 두 방향을 다 고정한다 — 안전한 도구가 신고를 빠뜨리는 것도, 위험한 도구가 안전하다고
  // 거짓 신고하는 것도 회귀로 잡는다.
  it('tools/list: 모든 도구가 annotations를 신고하고, 파괴 여부를 정직하게 표시한다', async () => {
    const proposals = {
      list: jest.fn().mockResolvedValue([]),
      approve: jest.fn().mockResolvedValue('ok'),
      reject: jest.fn().mockResolvedValue('ok'),
    };
    // McpSession.listToolDefs는 API 브레인용 형태로 변환하며 annotations를 떨군다 — 원본 클라이언트로 본다.
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(makeDeps({ proposals, write: jest.fn().mockResolvedValue('written') })).connect(serverT);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientT);
    const defs = (await client.listTools()).tools;
    const by = (n: string) => defs.find((d) => d.name === n);

    // 신고 누락이 없어야 한다(누락 = destructiveHint 기본 true = 자동모드에서 막힘).
    for (const d of defs) expect(d.annotations).toBeDefined();

    // 읽기 전용
    for (const n of ['wiki_search', 'wiki_read', 'wiki_list', 'list_proposals']) {
      expect(by(n)?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    // 로컬에 쓰지만 지우거나 덮지 않음 — 자동모드가 통과시켜야 하는 쪽
    for (const n of ['wiki_propose', 'approve_proposal']) {
      expect(by(n)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    }
    // 실제로 지우거나 덮는 것 — 안전하다고 주장하지 않는다
    for (const n of ['reject_proposal', 'wiki_write']) {
      expect(by(n)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    await client.close();
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

// MCP elicitation 승인 게이트(2026-07-25) — wiki_propose/wiki_write는 저장 확정 전에 클라이언트에
// 사용자 확인 대화상자를 요청한다. 미지원 클라이언트에선 기존 동작 그대로(회귀 0).
describe('elicitation 승인 게이트', () => {
  type ElicitHandler = (params: Record<string, unknown>) => unknown;

  // ★테스트 위생: 이 스위트를 엔그램 앱이 띄운 셸에서 돌리면 앱 표식이 이미 env에 있어 결과가
  // 뒤집힌다(외부 클라이언트 경로 테스트가 전부 폴백으로 샌다) — 매 테스트마다 지우고 되돌린다.
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

  // elicitation을 선언하고 요청을 handler로 처리하는 가짜 클라이언트.
  async function elicitingClient(deps: McpDeps, handler: ElicitHandler): Promise<Client> {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(deps).connect(serverT);
    const c = new Client({ name: 'elicit-test', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    c.setRequestHandler(ElicitRequestSchema, async (req) => handler(req.params as Record<string, unknown>) as never);
    await c.connect(clientT);
    return c;
  }

  async function callText(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
    const r = (await c.callTool({ name, arguments: args })) as { content: Array<{ text?: string }> };
    return r.content.map((x) => x.text ?? '').join('\n');
  }

  const accept: ElicitHandler = () => ({ action: 'accept', content: { decision: 'save' } });

  it('미지원 클라이언트(elicitation 미선언) → 물어보지 않고 기존 동작 그대로(회귀 0)', async () => {
    const propose = jest.fn().mockResolvedValue('proposal-42');
    const s = await connectedSession(makeDeps({ propose }));
    const out = await s.callTool(T('wiki_propose'), { title: 'T', content: 'C' });
    expect(propose).toHaveBeenCalledWith({ title: 'T', content: 'C' });
    expect(out).toBe('proposal proposal-42 created — queued, a human still has to approve it');
    await s.close();
  });

  it('지원 클라이언트 + 승인 → 그때 비로소 deps.propose 호출', async () => {
    const propose = jest.fn().mockResolvedValue('p-ok');
    const c = await elicitingClient(makeDeps({ propose }), accept);
    const out = await callText(c, 'wiki_propose', { title: 'T', content: 'C' });
    expect(propose).toHaveBeenCalledWith({ title: 'T', content: 'C' });
    expect(out).toContain('p-ok');
    await c.close();
  });

  // ★한 번 승인 = 저장 완료(2026-07-26 사용자 확정 시나리오). 승인창에서 '저장'을 누른 것이 곧 사람
  // 승인이다 — 그러고도 승인함에 남겨 또 묻게 만들면 같은 질문을 두 번 하는 것이다.
  it('승인창에서 저장 → 그 자리에서 게시까지 끝난다(승인함에 남기지 않는다)', async () => {
    const proposals = {
      list: jest.fn().mockResolvedValue([]),
      approve: jest.fn().mockResolvedValue('approved proposal p-1: slug (create)'),
      reject: jest.fn().mockResolvedValue('ok'),
    };
    const propose = jest.fn().mockResolvedValue('p-1');
    const c = await elicitingClient(makeDeps({ propose, proposals }), accept);
    const out = await callText(c, 'wiki_propose', { title: 'T', content: 'C' });
    expect(proposals.approve).toHaveBeenCalledWith('p-1');
    expect(out).toContain('saved to the Engram wiki');
    await c.close();
  });

  // wiki.autosave=direct — 사용자가 위험 확인을 거쳐 켠 설정이면 선택창 자체를 띄우지 않는다.
  it('wiki.autosave=direct → 묻지 않고 바로 저장한다', async () => {
    const asked: unknown[] = [];
    const proposals = {
      list: jest.fn().mockResolvedValue([]),
      approve: jest.fn().mockResolvedValue('approved proposal p-3: slug (create)'),
      reject: jest.fn().mockResolvedValue('ok'),
    };
    const propose = jest.fn().mockResolvedValue('p-3');
    const settings = {
      view: () => '', viewOne: () => null, apply: () => '',
      plan: () => ({ ok: false as const, error: 'not used' }),
      read: (k: string) => (k === 'wiki.autosave' ? 'direct' : ''),
    };
    const deps = makeDeps({ propose, proposals, settings: settings as never });
    const c = await elicitingClient(deps, (p) => { asked.push(p); return accept(p); });
    const out = await callText(c, 'wiki_propose', { title: 'T', content: 'C' });
    expect(asked).toEqual([]); // 선택창을 아예 띄우지 않았다
    expect(proposals.approve).toHaveBeenCalledWith('p-3');
    expect(out).toContain('saved to the Engram wiki');
    await c.close();
  });

  // 기본값(미설정)에서는 반드시 묻는다 — 자동 저장은 명시적으로 켠 경우에만.
  it('wiki.autosave 미설정 → 선택창을 띄운다(기본은 묻기)', async () => {
    const asked: unknown[] = [];
    const settings = {
      view: () => '', viewOne: () => null, apply: () => '',
      plan: () => ({ ok: false as const, error: 'not used' }),
      read: () => '',
    };
    const deps = makeDeps({ propose: jest.fn().mockResolvedValue('p-4'), settings: settings as never });
    const c = await elicitingClient(deps, (p) => { asked.push(p); return accept(p); });
    await callText(c, 'wiki_propose', { title: 'T', content: 'C' });
    expect(asked).toHaveLength(1);
    await c.close();
  });

  // 반대편: 물어보지 못했으면(스킵) 아직 아무도 승인하지 않았으므로 승인함에 남는다.
  it('물어보지 못한 경우(미지원) → 자동 승인하지 않고 승인함에 남는다', async () => {
    const proposals = {
      list: jest.fn().mockResolvedValue([]),
      approve: jest.fn().mockResolvedValue('should not happen'),
      reject: jest.fn().mockResolvedValue('ok'),
    };
    const propose = jest.fn().mockResolvedValue('p-2');
    const s = await connectedSession(makeDeps({ propose, proposals })); // elicitation 미선언 클라이언트
    const out = await s.callTool(T('wiki_propose'), { title: 'T', content: 'C' });
    expect(proposals.approve).not.toHaveBeenCalled();
    expect(out).toContain('queued');
    await s.close();
  });

  it('요청 내용에 제목·대상 슬러그·내용 앞부분·저장/취소 선택지', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const c = await elicitingClient(makeDeps(), (p) => {
      seen.push(p);
      return { action: 'accept', content: { decision: 'save' } };
    });
    await callText(c, 'wiki_propose', { title: 'Deploy Steps', content: 'the body text', slug: 'ops' });
    const msg = String(seen[0].message);
    expect(msg).toContain('Deploy Steps');
    expect(msg).toContain('ops');
    expect(msg).toContain('the body text');
    const schema = seen[0].requestedSchema as { properties: { decision: { enum: string[] } } };
    expect(schema.properties.decision.enum).toEqual(['save', 'cancel']);
    await c.close();
  });

  // 사람이 실제로 누른 거부는 그대로 존중한다. 문턱 0 = 소요시간 판별을 꺼서 "사람이 답했다"로 본다
  // (목 클라이언트는 0ms에 답하므로 문턱을 끄지 않으면 아래 자동응답 케이스와 구분되지 않는다).
  it('사용자 거부 → 제안 자체를 만들지 않고 명확한 결과 텍스트', async () => {
    const propose = jest.fn().mockResolvedValue('never');
    process.env[ELICIT_HUMAN_MIN_MS_ENV] = '0';
    try {
      const c = await elicitingClient(makeDeps({ propose }), () => ({ action: 'decline' }));
      const out = await callText(c, 'wiki_propose', { title: 'T', content: 'C' });
      expect(propose).not.toHaveBeenCalled();
      expect(out.toLowerCase()).toContain('declined');
      expect(out).toContain('T');
      await c.close();
    } finally {
      delete process.env[ELICIT_HUMAN_MIN_MS_ENV];
    }
  });

  // ★2026-07-26 실사고: 바깥 Claude Code(자동모드)는 사람에게 못 물을 때 cancel이 아니라 decline으로
  // 답한다 — 승인창은 뜬 적도 없는데 3회 연속 "the user declined"로 저장이 막혔다. 사람이 누를 수
  // 없는 속도의 decline은 거부 의사가 아니라 "물어볼 사람이 없었다"로 읽고 제안 큐로 폴백한다.
  it('사람이 누를 수 없는 속도의 decline → 거부가 아니라 제안 큐로 폴백', async () => {
    const propose = jest.fn().mockResolvedValue('p-fallback-decline');
    const c = await elicitingClient(makeDeps({ propose }), () => ({ action: 'decline' }));
    const out = await callText(c, 'wiki_propose', { title: 'T', content: 'C' });
    expect(propose).toHaveBeenCalledWith({ title: 'T', content: 'C' });
    expect(out).toContain('p-fallback-decline');
    await c.close();
  });

  // ★2026-07-25 실사고: 사람 없는 클라이언트(헤드리스 claude -p)가 elicitation을 선언해놓고
  // 즉시 {action:'cancel'}로 답한다 — 명시적 선택이 아니므로 거부로 읽지 않고 기존 경로로 폴백한다.
  it('명시 선택 없이 닫힘(action:cancel) → 거부가 아니라 기존 경로(제안 큐)로 폴백', async () => {
    const propose = jest.fn().mockResolvedValue('p-fallback-cancel');
    const c = await elicitingClient(makeDeps({ propose }), () => ({ action: 'cancel' }));
    const out = await callText(c, 'wiki_propose', { title: 'T', content: 'C' });
    expect(propose).toHaveBeenCalledWith({ title: 'T', content: 'C' });
    expect(out).toContain('p-fallback-cancel');
    await c.close();
  });

  it('명시 선택 없이 닫힘 + wiki_write(즉시 게시) → 게시하지 않는다(애매함은 안전 쪽)', async () => {
    const write = jest.fn();
    const c = await elicitingClient(makeDeps({ write }), () => ({ action: 'cancel' }));
    const out = await callText(c, 'wiki_write', { title: 'T', content: 'C' });
    expect(write).not.toHaveBeenCalled();
    expect(out.toLowerCase()).toContain('declined');
    await c.close();
  });

  // ★회귀 수정의 핵심 경로: 앱의 두뇌가 부른 호출(=상주 프로세스 트리)엔 묻지 않고 제안을 만든다.
  it('앱 내부 호출(ENGRAM_RESIDENT) → 묻지 않고 제안 생성(앱 승인함이 승인 주체)', async () => {
    process.env[APP_RESIDENT_ENV] = '1';
    try {
      const asked: unknown[] = [];
      const propose = jest.fn().mockResolvedValue('p-app');
      const c = await elicitingClient(makeDeps({ propose }), (p) => {
        asked.push(p);
        return { action: 'cancel' };
      });
      const out = await callText(c, 'wiki_propose', { title: 'T', content: 'C' });
      expect(asked).toHaveLength(0);
      expect(propose).toHaveBeenCalledWith({ title: 'T', content: 'C' });
      expect(out).toContain('p-app');
      await c.close();
    } finally {
      delete process.env[APP_RESIDENT_ENV];
    }
  });

  it('응답 지연(타임아웃) → 멈추지 않고 기존 경로로 폴백해 제안 생성', async () => {
    const prev = process.env[ELICIT_TIMEOUT_ENV];
    process.env[ELICIT_TIMEOUT_ENV] = '30';
    try {
      const propose = jest.fn().mockResolvedValue('p-fallback');
      const c = await elicitingClient(
        makeDeps({ propose }),
        () => new Promise((r) => setTimeout(() => r({ action: 'accept', content: { decision: 'save' } }), 300)),
      );
      const out = await callText(c, 'wiki_propose', { title: 'T', content: 'C' });
      expect(propose).toHaveBeenCalled();
      expect(out).toContain('p-fallback');
      await c.close();
    } finally {
      if (prev === undefined) delete process.env[ELICIT_TIMEOUT_ENV];
      else process.env[ELICIT_TIMEOUT_ENV] = prev;
    }
  });

  it('클라이언트가 elicitation 요청에서 에러 → 폴백(기존 경로)', async () => {
    const propose = jest.fn().mockResolvedValue('p-err');
    const c = await elicitingClient(makeDeps({ propose }), () => {
      throw new Error('no ui');
    });
    const out = await callText(c, 'wiki_propose', { title: 'T', content: 'C' });
    expect(propose).toHaveBeenCalled();
    expect(out).toContain('p-err');
    await c.close();
  });

  it('wiki_write도 같은 게이트 — 거부 시 쓰지 않음, 승인 시 씀', async () => {
    const write = jest.fn().mockResolvedValue('page written');
    const declined = await elicitingClient(makeDeps({ write }), () => ({ action: 'decline' }));
    const out = await callText(declined, 'wiki_write', { title: 'T', content: 'C' });
    expect(write).not.toHaveBeenCalled();
    expect(out.toLowerCase()).toContain('declined');
    await declined.close();

    const okc = await elicitingClient(makeDeps({ write }), accept);
    expect(await callText(okc, 'wiki_write', { title: 'T', content: 'C' })).toContain('page written');
    expect(write).toHaveBeenCalledWith({ title: 'T', content: 'C' });
    await okc.close();
  });

  it('approve_proposal/reject_proposal은 이미 사람 승인 게이트 — 중복으로 묻지 않는다', async () => {
    const calls: unknown[] = [];
    const proposals = {
      list: jest.fn().mockResolvedValue([]),
      approve: jest.fn().mockResolvedValue('approved'),
      reject: jest.fn().mockResolvedValue('rejected'),
    };
    const c = await elicitingClient(makeDeps({ proposals }), (p) => {
      calls.push(p);
      return { action: 'accept', content: { decision: 'save' } };
    });
    expect(await callText(c, 'approve_proposal', { id: 'p1' })).toContain('approved');
    expect(await callText(c, 'reject_proposal', { id: 'p1' })).toContain('rejected');
    expect(calls).toHaveLength(0);
    await c.close();
  });

  it('읽기 도구(wiki_search/read/list)는 묻지 않는다', async () => {
    const calls: unknown[] = [];
    const c = await elicitingClient(makeDeps(), (p) => {
      calls.push(p);
      return { action: 'accept' };
    });
    await callText(c, 'wiki_search', { query: 'x' });
    await callText(c, 'wiki_list', {});
    expect(calls).toHaveLength(0);
    await c.close();
  });

  it(`${ELICIT_OFF_ENV}=1(사람 없는 자동 실행) → 묻지 않고 기존 경로`, async () => {
    process.env[ELICIT_OFF_ENV] = '1';
    try {
      const calls: unknown[] = [];
      const propose = jest.fn().mockResolvedValue('p-auto');
      const c = await elicitingClient(makeDeps({ propose }), (p) => {
        calls.push(p);
        return { action: 'accept' };
      });
      const out = await callText(c, 'wiki_propose', { title: 'T', content: 'C' });
      expect(calls).toHaveLength(0);
      expect(out).toContain('p-auto');
      await c.close();
    } finally {
      delete process.env[ELICIT_OFF_ENV];
    }
  });

  it('stateless HTTP 서버(disableElicitation) → 묻지 않고 기존 경로(무한대기 회피)', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const propose = jest.fn().mockResolvedValue('p-http');
    const server = buildMcpServer(makeDeps({ propose }));
    disableElicitation(server);
    await server.connect(serverT);
    const calls: unknown[] = [];
    const c = new Client({ name: 'elicit-test', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    c.setRequestHandler(ElicitRequestSchema, async (req) => {
      calls.push(req.params);
      return { action: 'accept' } as never;
    });
    await c.connect(clientT);
    const out = await callText(c, 'wiki_propose', { title: 'T', content: 'C' });
    expect(calls).toHaveLength(0);
    expect(out).toContain('p-http');
    await c.close();
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
