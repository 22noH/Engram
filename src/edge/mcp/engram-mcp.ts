import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpProposalsDeps } from './mcp-proposals';

// 주입 의존성(§3.1) — main이 실 WikiEngine/ProposalStore/BrainDelegator를 배선, 테스트는 가짜 주입.
export interface McpDeps {
  search(query: string, limit: number): Promise<Array<{ slug: string; title: string; snippet: string }>>;
  read(slug: string): Promise<{ title: string; content: string } | null>;
  list(): Promise<Array<{ slug: string; title: string; category?: string }>>;
  propose(input: { slug?: string; title: string; content: string; reason?: string }): Promise<string>;
  askBrain: ((brain: string, task: string) => Promise<string>) | null;
  brainNames(): string[];
  // §3.3 확장 — 미주입/null이면 기존 도구 4/5종 그대로(회귀 0). proposals=공용 승인 어댑터(mcp-proposals.ts)
  // 주입 시 list_proposals/approve_proposal/reject_proposal 노출. write 주입 시 wiki_write 노출(--write-mode).
  proposals?: McpProposalsDeps | null;
  write?: ((input: { slug?: string; title: string; content: string }) => Promise<string>) | null;
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

const LIST_PROPOSALS_TOOL: Tool = {
  name: 'list_proposals',
  description:
    'List pending Engram wiki proposals awaiting human review. Each entry has id, title, op, targetSlug, and a preview of the content.',
  inputSchema: { type: 'object', properties: {} },
};

const APPROVE_PROPOSAL_TOOL: Tool = {
  name: 'approve_proposal',
  description:
    'Approve a pending Engram wiki proposal and apply it to the wiki. Approval is the human gate — only call this ' +
    'when the user explicitly asks you to approve a specific proposal (by id from list_proposals).',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'proposal id, from list_proposals' } },
    required: ['id'],
  },
};

const REJECT_PROPOSAL_TOOL: Tool = {
  name: 'reject_proposal',
  description:
    'Reject (discard) a pending Engram wiki proposal. Approval/rejection is the human gate — only call this when ' +
    'the user explicitly asks you to reject a specific proposal (by id from list_proposals).',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'proposal id, from list_proposals' } },
    required: ['id'],
  },
};

const WIKI_WRITE_TOOL: Tool = {
  name: 'wiki_write',
  description:
    'Write directly to the Engram wiki — creates or updates a published page immediately, with no human approval ' +
    'step (unlike wiki_propose). Only available when the server is running in write mode.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      content: { type: 'string' },
      slug: { type: 'string', description: 'optional — target an existing page' },
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
  // 0·음수·NaN도 방어 — 하류(RagStore.limit)의 미정의 의미론에 그대로 흘리지 않는다.
  const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : DEFAULT_SEARCH_LIMIT;
  const limit = Math.max(1, Math.min(Math.floor(rawLimit), MAX_SEARCH_LIMIT));
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

async function callListProposals(deps: McpDeps): Promise<CallToolResult> {
  if (!deps.proposals) return fail('list_proposals is not available (no proposals adapter configured)');
  const list = await deps.proposals.list();
  if (list.length === 0) return ok('no pending proposals');
  return ok(list.map((p) => `${p.id} — ${p.title} [${p.op} -> ${p.targetSlug}]\n${p.preview}`).join('\n\n'));
}

async function callApproveProposal(deps: McpDeps, args: Record<string, unknown>): Promise<CallToolResult> {
  if (!deps.proposals) return fail('approve_proposal is not available (no proposals adapter configured)');
  const id = typeof args.id === 'string' ? args.id : '';
  const summary = await deps.proposals.approve(id);
  return ok(summary);
}

async function callRejectProposal(deps: McpDeps, args: Record<string, unknown>): Promise<CallToolResult> {
  if (!deps.proposals) return fail('reject_proposal is not available (no proposals adapter configured)');
  const id = typeof args.id === 'string' ? args.id : '';
  const summary = await deps.proposals.reject(id);
  return ok(summary);
}

async function callWikiWrite(deps: McpDeps, args: Record<string, unknown>): Promise<CallToolResult> {
  if (!deps.write) return fail('wiki_write is not available (write mode is not enabled)');
  const title = typeof args.title === 'string' ? args.title : '';
  const content = typeof args.content === 'string' ? args.content : '';
  const input: { slug?: string; title: string; content: string } = { title, content };
  if (typeof args.slug === 'string') input.slug = args.slug;
  const result = await deps.write(input);
  return ok(result);
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

// MCP 프롬프트 — 클라이언트(Claude Code 등)의 `/` 메뉴에 슬래시 명령으로 뜬다
// (도구는 모델이 알아서 쓰는 것, 프롬프트는 사람이 `/`로 부르는 진입점 — 둘 다 노출해야 발견성이 산다).
// 내용은 "이 도구를 이렇게 써라"는 지시문(도구 정의는 위에 이미 있음). 지시문은 영어(모델 대상 관례).
interface EngramPrompt { name: string; description: string; args: Array<{ name: string; description: string; required: boolean }>; text: (a: Record<string, string>) => string }

const PROMPTS: EngramPrompt[] = [
  {
    name: 'wiki-search', description: 'Search the Engram wiki and summarize what it knows',
    args: [{ name: 'query', description: 'what to look for', required: true }],
    text: (a) => `Search the Engram wiki using the wiki_search tool with query: ${a.query ?? ''}. Read the most relevant hits with wiki_read if needed, then answer based on what the wiki actually says. If nothing relevant is found, say so.`,
  },
  {
    name: 'wiki-save', description: 'Save knowledge from this conversation to the Engram wiki (as a proposal — a human approves)',
    args: [{ name: 'topic', description: 'optional — what to save; defaults to the key insight of the conversation', required: false }],
    text: (a) => `Distill ${a.topic ? `the topic "${a.topic}"` : 'the most valuable reusable knowledge from this conversation'} into a concise wiki page (clear title, markdown body), then submit it with the wiki_propose tool. Tell the user the proposal id and that a human must approve it before it appears in the wiki.`,
  },
  {
    name: 'proposals', description: 'Show pending Engram wiki proposals awaiting human review',
    args: [],
    text: () => 'Call the list_proposals tool and present the pending Engram wiki proposals as a numbered list (id, title, what it changes). Ask the user which to approve or reject — do NOT approve or reject anything without their explicit instruction.',
  },
  {
    name: 'approve', description: 'Approve a pending Engram wiki proposal (human decision)',
    args: [{ name: 'id', description: 'proposal id (or number from /proposals)', required: true }],
    text: (a) => `The user explicitly asked to approve the Engram wiki proposal: ${a.id ?? ''}. If this is a number from a previous list_proposals call, resolve it to the full proposal id (call list_proposals again if needed). Then call approve_proposal with that id and report the result.`,
  },
];

export function buildMcpServer(deps: McpDeps): Server {
  const server = new Server({ name: 'engram', version: '1.0.0' }, { capabilities: { tools: {}, prompts: {} } });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    // 승인 계열 프롬프트는 승인 어댑터가 있을 때만(도구 노출 조건과 일치).
    const prompts = PROMPTS.filter((p) => (p.name === 'proposals' || p.name === 'approve' ? !!deps.proposals : true));
    return {
      prompts: prompts.map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.args.map((x) => ({ name: x.name, description: x.description, required: x.required })),
      })),
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const p = PROMPTS.find((x) => x.name === req.params.name);
    if (!p) throw new Error(`unknown prompt: ${req.params.name}`);
    const args = (req.params.arguments ?? {}) as Record<string, string>;
    return {
      description: p.description,
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.text(args) } }],
    };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [WIKI_SEARCH_TOOL, WIKI_READ_TOOL, WIKI_LIST_TOOL, WIKI_PROPOSE_TOOL];
    if (deps.askBrain) tools.push(askBrainTool(deps.brainNames()));
    if (deps.proposals) tools.push(LIST_PROPOSALS_TOOL, APPROVE_PROPOSAL_TOOL, REJECT_PROPOSAL_TOOL);
    if (deps.write) tools.push(WIKI_WRITE_TOOL);
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
        case 'list_proposals':
          return await callListProposals(deps);
        case 'approve_proposal':
          return await callApproveProposal(deps, args);
        case 'reject_proposal':
          return await callRejectProposal(deps, args);
        case 'wiki_write':
          return await callWikiWrite(deps, args);
        default:
          return fail(`unknown tool: ${name}`);
      }
    } catch (e) {
      return fail(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  return server;
}
