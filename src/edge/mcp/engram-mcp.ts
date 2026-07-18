import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema, CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

// 주입 의존성(§3.1) — main이 실 WikiEngine/ProposalStore/BrainDelegator를 배선, 테스트는 가짜 주입.
export interface McpDeps {
  search(query: string, limit: number): Promise<Array<{ slug: string; title: string; snippet: string }>>;
  read(slug: string): Promise<{ title: string; content: string } | null>;
  list(): Promise<Array<{ slug: string; title: string; category?: string }>>;
  propose(input: { slug?: string; title: string; content: string; reason?: string }): Promise<string>;
  askBrain: ((brain: string, task: string) => Promise<string>) | null;
  brainNames(): string[];
}

const MAX_OUTPUT = 50_000; // src/brain/mcp-client.ts MAX_OUTPUT과 동일 상한(§3.1)
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;

function cap(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…(truncated)` : text;
}

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text: cap(text) }] };
}

function fail(text: string): CallToolResult {
  return { content: [{ type: 'text', text: cap(text) }], isError: true };
}

const WIKI_SEARCH_TOOL: Tool = {
  name: 'wiki_search',
  description:
    'Semantic search over the Engram wiki (team knowledge base). Returns matching pages with slug/title/snippet.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'search query' },
      limit: { type: 'number', description: `max results, default ${DEFAULT_SEARCH_LIMIT}, capped at ${MAX_SEARCH_LIMIT}` },
    },
    required: ['query'],
  },
};

const WIKI_READ_TOOL: Tool = {
  name: 'wiki_read',
  description: 'Read one published Engram wiki page by slug. Returns its title and full content.',
  inputSchema: {
    type: 'object',
    properties: { slug: { type: 'string', description: 'page slug' } },
    required: ['slug'],
  },
};

const WIKI_LIST_TOOL: Tool = {
  name: 'wiki_list',
  description: 'List all published Engram wiki pages (slug, title, category).',
  inputSchema: { type: 'object', properties: {} },
};

const WIKI_PROPOSE_TOOL: Tool = {
  name: 'wiki_propose',
  description:
    'Propose new knowledge for the Engram wiki. A human reviews and approves it in the Engram app — nothing is written directly.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      content: { type: 'string' },
      slug: { type: 'string', description: 'optional — target an existing page' },
      reason: { type: 'string', description: 'optional — why this is being proposed' },
    },
    required: ['title', 'content'],
  },
};

function askBrainTool(names: string[]): Tool {
  return {
    name: 'ask_brain',
    description: `Delegate a subtask to one of the registered Engram brains: ${names.join(', ')}`,
    inputSchema: {
      type: 'object',
      properties: {
        brain: { type: 'string', description: 'registered brain name' },
        task: { type: 'string', description: 'the subtask to delegate' },
      },
      required: ['brain', 'task'],
    },
  };
}

async function callWikiSearch(deps: McpDeps, args: Record<string, unknown>): Promise<CallToolResult> {
  const query = typeof args.query === 'string' ? args.query : '';
  let limit = typeof args.limit === 'number' ? args.limit : DEFAULT_SEARCH_LIMIT;
  if (limit > MAX_SEARCH_LIMIT) limit = MAX_SEARCH_LIMIT;
  const hits = await deps.search(query, limit);
  if (hits.length === 0) return ok('no results');
  return ok(hits.map((h) => `${h.slug} — ${h.title}\n${h.snippet}`).join('\n\n'));
}

async function callWikiRead(deps: McpDeps, args: Record<string, unknown>): Promise<CallToolResult> {
  const slug = typeof args.slug === 'string' ? args.slug : '';
  const page = await deps.read(slug);
  if (!page) return fail(`not found: no published page with slug "${slug}"`);
  return ok(`${page.title}\n\n${page.content}`);
}

async function callWikiList(deps: McpDeps): Promise<CallToolResult> {
  const pages = await deps.list();
  if (pages.length === 0) return ok('no pages');
  return ok(pages.map((p) => `${p.slug} — ${p.title}${p.category ? ` [${p.category}]` : ''}`).join('\n'));
}

async function callWikiPropose(deps: McpDeps, args: Record<string, unknown>): Promise<CallToolResult> {
  const title = typeof args.title === 'string' ? args.title : '';
  const content = typeof args.content === 'string' ? args.content : '';
  const input: { slug?: string; title: string; content: string; reason?: string } = { title, content };
  if (typeof args.slug === 'string') input.slug = args.slug;
  if (typeof args.reason === 'string') input.reason = args.reason;
  const id = await deps.propose(input);
  return ok(`proposal ${id} created — a human will review it in the Engram app`);
}

async function callAskBrain(deps: McpDeps, args: Record<string, unknown>): Promise<CallToolResult> {
  if (!deps.askBrain) return fail('ask_brain is not available (no delegate configured)');
  const brain = typeof args.brain === 'string' ? args.brain : '';
  const task = typeof args.task === 'string' ? args.task : '';
  const names = deps.brainNames();
  if (!names.includes(brain)) {
    return fail(`unknown brain "${brain}" — registered brains: ${names.join(', ')}`);
  }
  const result = await deps.askBrain(brain, task);
  return ok(result);
}

export function buildMcpServer(deps: McpDeps): Server {
  const server = new Server({ name: 'engram', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [WIKI_SEARCH_TOOL, WIKI_READ_TOOL, WIKI_LIST_TOOL, WIKI_PROPOSE_TOOL];
    if (deps.askBrain) tools.push(askBrainTool(deps.brainNames()));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name } = req.params;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case 'wiki_search':
          return await callWikiSearch(deps, args);
        case 'wiki_read':
          return await callWikiRead(deps, args);
        case 'wiki_list':
          return await callWikiList(deps);
        case 'wiki_propose':
          return await callWikiPropose(deps, args);
        case 'ask_brain':
          return await callAskBrain(deps, args);
        default:
          return fail(`unknown tool: ${name}`);
      }
    } catch (e) {
      return fail(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  return server;
}
