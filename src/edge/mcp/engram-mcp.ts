import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpProposalsDeps } from './mcp-proposals';
import { confirmSettingChange, confirmWikiSave, declinedText } from './mcp-elicit';
import type { McpSettingsPort } from './mcp-settings';
import type { BrowserOp, BrowserOpResult } from '../../../shared/browser-ops';
import { BROWSER_TOOL_DEFS, CHANNEL_ARG, isBrowserToolName, toBrowserOp } from '../../../shared/browser-ops';

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
  // ★근본픽스(2026-07-20): 헤드리스 코어 모드는 RagStore를 절대 열지 않으므로 search가 텍스트 폴백
  // (mcp-wiring.ts makeFileSearch)이다 — true면 wiki_search 도구 설명에 그 사실을 덧붙인다(사용자가
  // "의미검색"을 기대하고 결과 품질을 오판하지 않게). 미지정/false=기존 설명 그대로(브리지·앱 무변경).
  searchFallback?: boolean;
  // AI 웹 조작(2단계): 주입되면 browser_* 도구 7종을 노출한다. **채널 정체성이 인자로 온다** —
  // MCP 도구 자체는 "어느 채널인지"를 모르기 때문(위키 ask-user-ui-mcp 선례). 그 값은 브리지가
  // 스폰 env(ENGRAM_CHANNEL_ID)에서 읽어 `_channel` 인자로 실어 보낸다(mcp-bridge.ts).
  // 미주입/null이면 도구 자체가 안 뜬다(회귀 0).
  browser?: ((channelId: string, op: BrowserOp) => Promise<BrowserOpResult>) | null;
  // 설정 조회·변경(2026-07-25). 주입되면 engram_config_get/engram_config_set 2종을 노출한다 —
  // 앱 설정 화면이 없는 MCP 전용 사용자가 JSON을 손으로 고치지 않아도 되게. 미주입=도구 없음(회귀 0).
  settings?: McpSettingsPort | null;
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

const WIKI_SEARCH_DESCRIPTION =
  'Semantic search over the Engram wiki (team knowledge base). Returns matching pages with slug/title/snippet.';
// 텍스트 폴백일 때 덧붙는 안내(코어 모드 — 근본픽스 2026-07-20, deps.searchFallback 참조).
const WIKI_SEARCH_FALLBACK_NOTE =
  ' NOTE: the Engram app is offline, so this is currently a plain case-insensitive text match over wiki pages ' +
  '(title/slug/body), not semantic search — expect lower recall for paraphrased queries.';

// 도구 annotation(MCP 스펙) — 클라이언트가 "이 도구를 물어보지 않고 실행해도 되나"를 판단하는 유일한
// 기계적 근거다. ★안 달면 destructiveHint 기본값이 true라 모든 도구가 "파괴적일 수 있음"으로 취급된다.
// 실사고(2026-07-26): 바깥 Claude Code 자동모드에서 wiki_propose가 조용히 거부됐다 — 사람 승인 게이트를
// 거치는 제안 등록일 뿐인데 아무 신고도 안 해서 클라이언트가 최악을 가정할 수밖에 없었다.
// 거짓 신고는 하지 않는다. 실제로 파괴적인 것(wiki_write·reject_proposal·engram_config_set)은 true로 둔다.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
// 로컬에 쓰지만 지우거나 덮지 않는 것(추가·제안 등록). 로컬 전용이라 openWorld도 false.
const ADDITIVE_LOCAL = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
// 지우거나 덮어쓰는 것 — 사람 확인을 받을 값어치가 있다고 스스로 신고한다.
const DESTRUCTIVE_LOCAL = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
// 열린 페이지를 읽기만 하는 브라우저 도구(나머지는 실제로 조작한다).
const BROWSER_READ_ONLY_TOOLS = new Set(['browser_read', 'browser_console', 'browser_network', 'browser_screenshot']);

function wikiSearchTool(fallback: boolean): Tool {
  return {
    name: 'wiki_search',
    description: WIKI_SEARCH_DESCRIPTION + (fallback ? WIKI_SEARCH_FALLBACK_NOTE : ''),
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'search query' },
        limit: { type: 'number', description: `max results, default ${DEFAULT_SEARCH_LIMIT}, capped at ${MAX_SEARCH_LIMIT}` },
      },
      required: ['query'],
    },
  };
}

const WIKI_READ_TOOL: Tool = {
  name: 'wiki_read',
  description: 'Read one published Engram wiki page by slug. Returns its title and full content.',
  annotations: READ_ONLY,
  inputSchema: {
    type: 'object',
    properties: { slug: { type: 'string', description: 'page slug' } },
    required: ['slug'],
  },
};

const WIKI_LIST_TOOL: Tool = {
  name: 'wiki_list',
  description: 'List all published Engram wiki pages (slug, title, category).',
  annotations: READ_ONLY,
  inputSchema: { type: 'object', properties: {} },
};

const WIKI_PROPOSE_TOOL: Tool = {
  name: 'wiki_propose',
  description:
    'Propose new knowledge for the Engram wiki. A human reviews and approves it in the Engram app — nothing is written directly. ' +
    'Safe to call: it only queues a proposal locally. It never edits or deletes an existing page, and publishing requires a separate human approval.',
  // 제안 큐에 한 줄 넣을 뿐 — 기존 페이지를 고치거나 지우지 않고, 게시는 사람 승인을 또 거친다.
  annotations: ADDITIVE_LOCAL,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      content: { type: 'string' },
      slug: { type: 'string', description: 'optional — slug of an existing page to append to. Prefer this over creating a near-duplicate: search first (wiki_search), and if a page already covers this topic, pass its slug so the content is appended there instead of making a new page.' },
      reason: { type: 'string', description: 'optional — why this is being proposed' },
    },
    required: ['title', 'content'],
  },
};

const LIST_PROPOSALS_TOOL: Tool = {
  name: 'list_proposals',
  description:
    'List pending Engram wiki proposals awaiting human review. Each entry has id, title, op, targetSlug, and a preview of the content.',
  annotations: READ_ONLY,
  inputSchema: { type: 'object', properties: {} },
};

const APPROVE_PROPOSAL_TOOL: Tool = {
  name: 'approve_proposal',
  description:
    'Approve a pending Engram wiki proposal and apply it to the wiki. Approval is the human gate — only call this ' +
    'when the user explicitly asks you to approve a specific proposal (by id from list_proposals).',
  // 사람이 이미 내린 결정을 집행한다. 새 페이지 생성이거나 기존 페이지 뒤에 이어붙이기라 덮어쓰지 않는다.
  annotations: ADDITIVE_LOCAL,
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
  // 제안을 버린다 = 되돌릴 수 없는 삭제. 정직하게 파괴적이라고 신고한다.
  annotations: DESTRUCTIVE_LOCAL,
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
  // 게시된 페이지를 사람 확인 없이 덮어쓴다 — 이건 진짜 파괴적이다.
  annotations: DESTRUCTIVE_LOCAL,
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

const CONFIG_GET_TOOL: Tool = {
  name: 'engram_config_get',
  description:
    "Read Engram's settings (wiki git sync, folder auto-import, current brain). Safe to call any time — this only reads.",
  annotations: READ_ONLY,
  inputSchema: {
    type: 'object',
    properties: { key: { type: 'string', description: 'optional — one setting key, e.g. import.folder. Omit for all settings.' } },
  },
};

const CONFIG_SET_TOOL: Tool = {
  name: 'engram_config_set',
  description:
    'Change one Engram setting (same settings file the Engram app writes). Use it when the user asks for things like ' +
    '"watch this folder", "sync my wiki with this repo", or "keep the original text". Sensitive settings ' +
    '(wiki git remote, publishing without human approval, very broad watch folders) require the user to confirm in a ' +
    'dialog; if this client cannot show one, the change is refused — tell the user to change it in the Engram app or ' +
    'with `engram config set` in a terminal. Call engram_config_get first if you are unsure of the key or the current value.',
  // 기존 설정값을 덮어쓴다. 위험 설정은 코드에서 별도 확인 게이트를 또 거친다(callConfigSet).
  annotations: DESTRUCTIVE_LOCAL,
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'setting key from engram_config_get, e.g. import.enabled' },
      value: { type: 'string', description: 'new value; see the "allowed" line from engram_config_get' },
    },
    required: ['key', 'value'],
  },
};

async function callConfigGet(deps: McpDeps, args: Record<string, unknown>): Promise<CallToolResult> {
  if (!deps.settings) return fail('engram_config_get is not available (no settings adapter configured)');
  const key = typeof args.key === 'string' ? args.key.trim() : '';
  if (!key) return ok(deps.settings.view());
  const one = deps.settings.viewOne(key);
  return one ? ok(one) : fail(`unknown setting "${key}"\n\n${deps.settings.view()}`);
}

// 위험 설정을 승인 없이 바꾸지 못하게 하는 문구 — 사람이 실제로 갈 수 있는 두 경로를 함께 준다.
function settingRefusedText(key: string, to: string, reason: string): string {
  return [
    `refused: "${key}" is a sensitive setting — ${reason}.`,
    'Changing it requires a confirmation dialog, and this MCP client cannot show one.',
    `Ask the user to change it in the Engram app's settings screen, or to run in a terminal:  engram config set ${key} ${to || 'none'}`,
  ].join(' ');
}

async function callConfigSet(server: Server, deps: McpDeps, args: Record<string, unknown>): Promise<CallToolResult> {
  if (!deps.settings) return fail('engram_config_set is not available (no settings adapter configured)');
  const key = typeof args.key === 'string' ? args.key : '';
  const value = typeof args.value === 'string' ? args.value : '';
  const plan = deps.settings.plan(key, value);
  if (!plan.ok) return fail(plan.error);
  if (plan.unchanged) return ok(`unchanged — ${plan.key} is already set to that value`);
  if (plan.risk === 'danger') {
    // ★폴백으로 그냥 허용하지 않는다(위키 저장 경로와 정반대) — 물어볼 수 없으면 거부한다.
    const confirm = await confirmSettingChange(server, { key: plan.key, from: plan.from, to: plan.to, reason: plan.reason });
    if (confirm === 'decline') return ok(`cancelled: the user declined to change ${plan.key} — nothing was changed.`);
    if (confirm === 'unavailable') return fail(settingRefusedText(plan.key, plan.to, plan.reason));
  }
  return ok(`updated ${deps.settings.apply(plan)}`);
}

function askBrainTool(names: string[]): Tool {
  return {
    name: 'ask_brain',
    description: `Delegate a subtask to one of the registered Engram brains: ${names.join(', ')}`,
    // 다른 모델에 위임한다 = 그쪽이 무슨 도구를 쓸지 우리가 보장할 수 없다. 안전하다고 신고하지 않는다.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
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

async function callWikiPropose(server: Server, deps: McpDeps, args: Record<string, unknown>): Promise<CallToolResult> {
  const title = typeof args.title === 'string' ? args.title : '';
  const content = typeof args.content === 'string' ? args.content : '';
  const input: { slug?: string; title: string; content: string; reason?: string } = { title, content };
  if (typeof args.slug === 'string') input.slug = args.slug;
  if (typeof args.reason === 'string') input.reason = args.reason;
  // ★저장 확정 전 사람 승인(elicitation) — 미지원·실패·타임아웃이면 unavailable로 떨어져
  // 아래 기존 경로가 그대로 돈다(mcp-elicit.ts 주석 참조).
  const confirm = await confirmWikiSave(server, { title, content, slug: input.slug, op: 'propose' });
  if (confirm === 'decline') return ok(declinedText({ title, content, slug: input.slug, op: 'propose' }));
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

async function callWikiWrite(server: Server, deps: McpDeps, args: Record<string, unknown>): Promise<CallToolResult> {
  if (!deps.write) return fail('wiki_write is not available (write mode is not enabled)');
  const title = typeof args.title === 'string' ? args.title : '';
  const content = typeof args.content === 'string' ? args.content : '';
  const input: { slug?: string; title: string; content: string } = { title, content };
  if (typeof args.slug === 'string') input.slug = args.slug;
  // 즉시 게시 경로 — 승인 게이트가 더 절실하다(제안 대기열조차 없다).
  const confirm = await confirmWikiSave(server, { title, content, slug: input.slug, op: 'write' });
  if (confirm === 'decline') return ok(declinedText({ title, content, slug: input.slug, op: 'write' }));
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

// AI 웹 조작(2단계) — MCP 경로. ★핵심: 채널 정체성이 없으면 **아무것도 하지 않는다**.
// MCP 도구는 자기가 어느 대화에서 불렸는지 모르므로(위키 ask-user-ui-mcp 선례), 브리지가 스폰
// env에서 읽어 넣어준 _channel만 신뢰한다. 없으면 "마지막 채널" 같은 추측을 하지 않고 정직하게 실패한다
// — 채널 두 개를 동시에 쓰는 순간 조용히 남의 화면을 조작하게 되기 때문.
const NO_CHANNEL_HINT =
  'browser error: this tool call has no channel identity, so Engram cannot tell which screen to drive. ' +
  'This happens when the MCP bridge was not spawned by an Engram turn — ask the user in the Engram app instead.';

async function callBrowserTool(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  if (!deps.browser) return fail('browser tools are not available (the Engram app is not running)');
  const channelId = typeof args[CHANNEL_ARG] === 'string' ? (args[CHANNEL_ARG] as string).trim() : '';
  if (!channelId) return fail(NO_CHANNEL_HINT);
  const op = toBrowserOp(name, args);
  if (typeof op === 'string') return fail(op);
  const r = await deps.browser(channelId, op);
  return r.ok ? ok(r.text) : fail(r.text);
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
    text: (a) => `Distill ${a.topic ? `the topic "${a.topic}"` : 'the most valuable reusable knowledge from this conversation'} into a concise wiki page (clear title, markdown body). Before submitting, search the wiki (wiki_search) for an existing page on the same topic — if one clearly covers it, pass its slug to wiki_propose so your note is appended there instead of creating a duplicate; otherwise submit without a slug to create a new page. Then tell the user the proposal id and that a human must approve it before it appears in the wiki.`,
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
  {
    name: 'config', description: "Show Engram's current settings (wiki sync, folder auto-import)",
    args: [{ name: 'key', description: 'optional — one setting key to look at', required: false }],
    text: (a) => `Call the engram_config_get tool${a.key ? ` with key "${a.key}"` : ''} and show the user their current Engram settings in a readable list. Explain what each one does in one short line. Do not change anything — if the user wants a change, use engram_config_set with the exact key and value they asked for.`,
  },
  {
    name: 'config-set', description: 'Change one Engram setting (sensitive ones ask the user to confirm)',
    args: [{ name: 'change', description: 'what to change, e.g. "watch C:\\Inbox" or "import.publish direct"', required: true }],
    text: (a) => `The user wants to change an Engram setting: ${a.change ?? ''}. Call engram_config_get first to see the exact key names, allowed values and current value, then call engram_config_set once with the single key and value that matches the request. Never guess a key. If the tool refuses because the setting is sensitive, relay its message — do not try to work around it by editing config files.`,
  },
];

// MCP initialize 결과의 instructions — 연결한 클라이언트의 시스템 프롬프트에 주입되는 사용 안내
// (context7·supabase 등과 같은 관례). 설치만 하면 "먼저 저장 제안→채팅 동의=승인" 흐름이 기본이 된다.
export const ENGRAM_MCP_INSTRUCTIONS = [
  "Engram is the user's personal knowledge wiki. When a question may be covered by it, search first (wiki_search, then wiki_read) and answer from what the wiki actually says.",
  'When a conversation produces reusable knowledge (a solved problem, a decision, a how-to), call wiki_propose. Do NOT ask "save this?" in chat first — wiki_propose asks the user itself, in a dialog, and that dialog is the one and only place that question gets asked. Asking in chat as well just makes the user answer the same question twice. Before proposing, search the wiki (wiki_search) for an existing page on the same topic — if one clearly covers it, pass that page\'s slug to wiki_propose so your note is appended there instead of creating a duplicate page; otherwise omit slug to create a new page.',
  'If the dialog cannot be shown (the client has no one to ask), wiki_propose still queues the proposal — nothing is published. Reviewing and approving what is queued happens in chat: use list_proposals to show the user what is pending, and call approve_proposal only for an item the user tells you to approve, in that message. Never approve a proposal you just created unless the user says so — creating and approving in one breath means nobody approved it.',
].join('\n\n');

export function buildMcpServer(deps: McpDeps): Server {
  const server = new Server(
    { name: 'engram', version: '1.0.0' },
    { capabilities: { tools: {}, prompts: {} }, instructions: ENGRAM_MCP_INSTRUCTIONS },
  );

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    // 승인 계열 프롬프트는 승인 어댑터가, 설정 프롬프트는 설정 어댑터가 있을 때만(도구 노출 조건과 일치).
    const prompts = PROMPTS.filter((p) => {
      if (p.name === 'proposals' || p.name === 'approve') return !!deps.proposals;
      if (p.name === 'config' || p.name === 'config-set') return !!deps.settings;
      return true;
    });
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
    const tools: Tool[] = [wikiSearchTool(!!deps.searchFallback), WIKI_READ_TOOL, WIKI_LIST_TOOL, WIKI_PROPOSE_TOOL];
    if (deps.askBrain) tools.push(askBrainTool(deps.brainNames()));
    if (deps.proposals) tools.push(LIST_PROPOSALS_TOOL, APPROVE_PROPOSAL_TOOL, REJECT_PROPOSAL_TOOL);
    if (deps.write) tools.push(WIKI_WRITE_TOOL);
    if (deps.settings) tools.push(CONFIG_GET_TOOL, CONFIG_SET_TOOL);
    // AI 웹 조작: 앱이 배선했을 때만. inputSchema는 shared 정의 그대로(_channel은 스키마에 없다).
    if (deps.browser) {
      for (const d of BROWSER_TOOL_DEFS) {
        tools.push({
          name: d.name,
          description: d.description,
          // 브라우저 도구는 전부 openWorld(살아 있는 웹). 페이지를 읽기만 하는 것과 실제로 조작하는 것을
          // 구분해 신고한다 — 조작 쪽은 안전하다고 주장하지 않는다(destructiveHint 기본 true 유지).
          annotations: BROWSER_READ_ONLY_TOOLS.has(d.name)
            ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
            : { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
          inputSchema: d.parameters as Tool['inputSchema'],
        });
      }
    }
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
          return await callWikiPropose(server, deps, args);
        case 'ask_brain':
          return await callAskBrain(deps, args);
        case 'list_proposals':
          return await callListProposals(deps);
        case 'approve_proposal':
          return await callApproveProposal(deps, args);
        case 'reject_proposal':
          return await callRejectProposal(deps, args);
        case 'wiki_write':
          return await callWikiWrite(server, deps, args);
        case 'engram_config_get':
          return await callConfigGet(deps, args);
        case 'engram_config_set':
          return await callConfigSet(server, deps, args);
        default:
          if (isBrowserToolName(name)) return await callBrowserTool(deps, name, args);
          return fail(`unknown tool: ${name}`);
      }
    } catch (e) {
      return fail(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  return server;
}
