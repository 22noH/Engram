import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpProposalsDeps } from './mcp-proposals';
import { confirmSettingChange, confirmWikiSave, declinedText } from './mcp-elicit';
import type { McpSettingsPort } from './mcp-settings';
import { normalizeCategoryPath } from '../../../shared/category-path';
import { stalePluginNotice } from './plugin-version';
import type { BrowserOp, BrowserOpResult } from '../../../shared/browser-ops';
import { BROWSER_TOOL_DEFS, CHANNEL_ARG, isBrowserToolName, toBrowserOp } from '../../../shared/browser-ops';

// 주입 의존성(§3.1) — main이 실 WikiEngine/ProposalStore/BrainDelegator를 배선, 테스트는 가짜 주입.
export interface McpDeps {
  search(query: string, limit: number): Promise<Array<{ slug: string; title: string; snippet: string }>>;
  read(slug: string): Promise<{ title: string; content: string } | null>;
  list(): Promise<Array<{ slug: string; title: string; category?: string }>>;
  propose(input: { slug?: string; title: string; content: string; reason?: string; category?: string }): Promise<string>;
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
  // 앱이 자기 UI로 "저장할까요?"를 묻는 경로(2026-07-26). 앱이 떠 있을 때만 주입된다(self.adapter).
  // MCP elicitation을 못 쓰는 두 경로 — 앱 두뇌(헤드리스 claude가 6ms에 cancel)와 stateless /mcp —
  // 가 이걸로 묻는다. 'unavailable'(창 없음·타임아웃)이면 기존대로 승인함 폴백.
  confirmSave?: ((req: { title: string; targetSlug?: string; category?: string; body: string }) => Promise<'save' | 'cancel' | 'unavailable'>) | null;
  // 양면 게시(2026-08-01): 외부 모델 클라이언트 경유 저장은 어느 화면을 보고 있는지 모른다 —
  // 앱 카드도 "동시에" 띄우되 기다리지 않는다(비차단). 카드의 답은 대기 중인 제안을 직접
  // 승인/거부한다(먼저 답한 쪽이 이기고, 진 쪽의 결정은 제안이 이미 소진돼 무해하게 무시된다).
  offerSave?: ((req: { proposalId: string; title: string; targetSlug?: string; category?: string; body: string }) => void) | null;
  // 호출자 이름(CALLER_HEADER에서 — stateless HTTP에선 getClientVersion이 비므로 이게 권위).
  // 미지정이면 접속 이름으로 폴백한다(stdio·테스트 같은 stateful 경로는 그걸로 충분).
  caller?: string | null;
  // 페이지를 다른 폴더로 옮긴다(2026-07-27). 분류는 위키 내용에서 나오는 것이라, 이미 쌓인 페이지도
  // 두뇌가 읽고 정리할 수 있어야 한다 — 그 통로가 지금까지 MCP에도 ws에도 없었다.
  recategorize?: ((slug: string, category: string) => Promise<string>) | null;
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
// 브리지가 "사람에게 물어 승인받았다"고 알릴 때 쓰는 상류 접속 이름. 이 이름으로 오면 다시 묻지
// 않는다 — 브리지 선택창과 앱 저장 카드가 겹쳐 두 번 묻는 것을 막는 유일한 신호.
// ponytail: 로컬 프로세스는 이 이름을 사칭할 수 있다. 다만 /mcp는 루프백 전용이고, 사칭할 수 있는
// 프로세스는 approve_proposal을 직접 부르면 그만이라 새로 열리는 문이 없다. 진짜 격리가 필요해지면
// 그때 토큰 교환으로 바꾼다.
export const BRIDGE_APPROVED_CLIENT = 'engram-bridge-approved';
// 브리지의 평상시 접속 이름(승인 없이 패스스루). 이 이름이 보이면 반대편에 **외부** 모델 클라이언트가
// 있다 — 모델의 질문 UI가 항상 있으므로 앱 카드보다 그쪽이 사용자가 보고 있는 화면이다(2026-08-01 실측:
// Claude에서 저장했는데 질문이 Engram 앱에 떠 45초를 태우고 사라졌다).
export const BRIDGE_CLIENT = 'engram-bridge';
// 앱 내부(두뇌 하네스)가 스폰한 브리지의 접속 이름 — 이 사용자는 앱을 보고 있으므로 앱 카드가 맞다.
// BRIDGE_CLIENT와 이름을 가르는 이유: 앱은 env를 못 보고 접속 이름만 본다(브리지가 env로 판별해 싣는다).
export const BRIDGE_APP_CLIENT = 'engram-bridge-app';
// ★호출자 신호는 HTTP 헤더로도 나른다(2026-08-01 실측 45.0초): 앱 /mcp는 stateless라 요청마다 새
// server — initialize를 본 인스턴스와 tools/call 인스턴스가 달라 getClientVersion()이 tools/call
// 시점에 비어 있다. 접속 이름 기반 판별(BRIDGE_*)은 그 경로에서 전부 죽은 코드였다(승인 이름은
// 브리지의 approve_proposal 폴백이 가려줬을 뿐). 요청과 함께 도착하는 유일한 자리인 헤더에 싣는다.
export const CALLER_HEADER = 'x-engram-caller';

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
    'Save knowledge to the Engram wiki, asking the user first. It shows them a dialog with the title, the target page and a preview; ' +
    'accepting publishes it right then. Only when no dialog can be shown is it left queued for approve_proposal. ' +
    'It never edits or deletes an existing page — a new page is created, or the text is appended to the page you name.',
  // 비파괴로 보는 근거: 기존 페이지를 고치거나 지우지 않는다(새 페이지 생성 또는 지정한 페이지에 덧붙이기).
  // ⚠️"게시는 사람 승인을 또 거친다"고 적혀 있던 주석은 삭제했다 — 승인창에서 저장을 누르면 그 자리에서
  // 게시되는 것이 확정 시나리오다(2026-07-30). 위 설명문과 정반대라 읽는 사람을 속였다.
  annotations: ADDITIVE_LOCAL,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      content: { type: 'string' },
      slug: { type: 'string', description: 'optional — slug of an existing page to append to. Prefer this over creating a near-duplicate: search first (wiki_search), and if a page already covers this topic, pass its slug so the content is appended there instead of making a new page.' },
      category: { type: 'string', description: 'optional but strongly preferred — the folder this page belongs in. There is no fixed list of folders: they come from what the wiki already holds, so call wiki_list first, reuse a folder that fits, and only name a new one when the page is genuinely about something the wiki has no folder for. Keep it a broad subject, not a narrow slice. Up to 3 levels with "/". Omitting it leaves the page unsorted.' },
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

const WIKI_RECATEGORIZE_TOOL: Tool = {
  name: 'wiki_recategorize',
  description:
    'Move a wiki page into a different folder. Folders are not a fixed list — they come from what the wiki ' +
    'actually holds, so call wiki_list first to see the folders in use and reuse one when it fits. ' +
    'Only the folder changes: the title and the body are untouched.',
  // 분류(메타데이터)만 바꾼다 — 본문은 손대지 않으므로 잃는 게 없다.
  annotations: ADDITIVE_LOCAL,
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'page slug, from wiki_list' },
      category: { type: 'string', description: 'folder path, e.g. a broad topic. Up to 3 levels with "/".' },
    },
    required: ['slug', 'category'],
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

// 폴더 이동. 승인창을 걸지 않는다 — 본문을 바꾸지 않는 메타데이터 정리이고, 두뇌가 위키 전체를
// 훑어 정리하는 게 목적이라 페이지마다 물으면 그 목적 자체가 성립하지 않는다(사용자 결정 2026-07-27).
async function callWikiRecategorize(deps: McpDeps, args: Record<string, unknown>): Promise<CallToolResult> {
  if (!deps.recategorize) return fail('wiki_recategorize is not available here');
  const slug = typeof args.slug === 'string' ? args.slug.trim() : '';
  if (!slug) return fail('slug is required');
  const category = normalizeCategoryPath(args.category);
  if (!category) return fail(`invalid category ${JSON.stringify(args.category)} — expected a folder name, optionally with "/" levels`);
  try {
    return ok(await deps.recategorize(slug, category));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

async function callWikiPropose(server: Server, deps: McpDeps, args: Record<string, unknown>): Promise<CallToolResult> {
  const title = typeof args.title === 'string' ? args.title : '';
  const content = typeof args.content === 'string' ? args.content : '';
  const input: { slug?: string; title: string; content: string; reason?: string; category?: string } = { title, content };
  if (typeof args.slug === 'string') input.slug = args.slug;
  if (typeof args.category === 'string') input.category = args.category;
  if (typeof args.reason === 'string') input.reason = args.reason;
  // ★저장 확정 전 사람 승인(elicitation) — 미지원·실패·타임아웃이면 unavailable로 떨어져
  // 아래 기존 경로가 그대로 돈다(mcp-elicit.ts 주석 참조).
  // 누가 묻느냐를 여기서 한 번에 정한다 — 경로가 달라도 사용자가 겪는 흐름은 같아야 한다.
  //  ① wiki.autosave=direct  → 아무도 안 묻는다(사용자가 위험 확인을 거쳐 켠 설정)
  //  ② 브리지가 이미 물어 승인받음 → 다시 묻지 않는다(중복 질문 금지). 브리지가 클라이언트 이름으로 알린다.
  //  ③ **지금 사용자가 앉아 있는 그 클라이언트에 먼저 묻는다**(MCP 선택창). Codex면 Codex, Claude
  //     Code면 Claude Code — 사용자가 보고 있는 화면에 떠야 한다. Engram이 깔려 있다고 앱으로
  //     보내면, 다른 창을 쓰고 있는 사람에게는 아무것도 안 뜬 것과 같다(2026-07-27 사용자 지적).
  //  ④ 클라이언트가 못 물을 때만(미지원·비대화형) 앱 저장 카드로 넘긴다 — 물어볼 기회를 버리지 않는다.
  const autosave = deps.settings?.read('wiki.autosave') === 'direct';
  // 호출자 판별: 헤더(deps.caller)가 권위, 없으면 접속 이름(stdio·테스트 경로) — CALLER_HEADER 주석 참조.
  const callerName = deps.caller ?? server.getClientVersion()?.name;
  const askedByBridge = callerName === BRIDGE_APPROVED_CLIENT;
  // 외부 모델 클라이언트 경유(브리지 평상시 이름) — 차단형 앱 카드는 건너뛰고, 아래에서 비차단
  // 카드(offerSave)를 모델 질문과 "동시에" 띄운다(양면 게시, 먼저 답한 쪽 승리).
  const viaExternalBridge = callerName === BRIDGE_CLIENT;
  let confirm: 'accept' | 'decline' | 'unavailable';
  if (autosave || askedByBridge) {
    confirm = 'accept';
  } else {
    const viaClient = await confirmWikiSave(server, { title, content, slug: input.slug, op: 'propose' });
    if (viaClient !== 'unavailable') {
      confirm = viaClient;
    } else if (deps.confirmSave && !viaExternalBridge) {
      // 앱 안(두뇌 하네스 등)에서 온 호출은 차단형 앱 카드가 묻는다 — 그 사용자는 앱을 보고 있다.
      // 외부 브리지 경유는 이 카드를 건너뛴다(45초 대기 + 순차 이중 질문의 원인) — 아래 양면 게시로.
      const viaApp = await deps.confirmSave({
        title,
        ...(input.slug ? { targetSlug: input.slug } : {}),
        // 카드가 "어느 폴더로 들어가는지"까지 보여줘야 승인이 의미가 있다(목업 승인 2026-07-27).
        ...(normalizeCategoryPath(input.category) ? { category: normalizeCategoryPath(input.category)! } : {}),
        body: content,
      });
      confirm = viaApp === 'save' ? 'accept' : viaApp === 'cancel' ? 'decline' : 'unavailable';
    } else {
      confirm = 'unavailable';
    }
  }
  if (confirm === 'decline') return ok(declinedText({ title, content, slug: input.slug, op: 'propose' }));
  const id = await deps.propose(input);
  // ★한 번 승인 = 저장 완료(2026-07-26 사용자 확정 시나리오). 승인창에서 '저장'을 누른 건 사람 승인
  // 그 자체다 — 그걸 받고도 승인함에 남겨두면 같은 질문을 두 번 하는 셈이 된다. 여기서 끝낸다.
  // 물어보지 못한 경우(unavailable=스킵)에만 승인함으로 간다 — 그때는 아직 아무도 승인하지 않았다.
  if (confirm === 'accept' && deps.proposals) {
    const applied = await deps.proposals.approve(id);
    return ok(`saved to the Engram wiki — ${applied}`);
  }
  // ★못 물었으면 조용히 큐에 넣고 끝내지 않는다(2026-07-29 실측).
  // elicitation은 "클라이언트야 물어봐 줘"라는 부탁이고, 안 그려주는 클라이언트에서는 서버가
  // 카드를 띄울 방법이 없다(Claude Code 비대화형 세션에서 즉답 거부를 실측). 앱이 없으면 승인함을
  // 열어볼 화면조차 없어서, 사용자 입장에서 저장은 **영영 완료되지 않는다** — 그런데도 우리는
  // "queued"만 돌려주고 끝냈다. 그래서 마지막 고리는 모델에게 넘긴다: 어느 클라이언트든 모델
  // 자신의 질문 UI는 항상 뜨므로, 여기까지 온 저장은 반드시 사람에게 한 번 닿는다.
  // 양면 게시(2026-08-01 사용자 결정): 사용자가 지금 어느 화면을 보는지 서버는 모른다 — 그래서
  // 앱 카드도 "동시에" 띄운다(비차단, 카드 답이 제안을 직접 승인/거부). 먼저 답한 쪽이 이긴다.
  let appCardShown = false;
  if (deps.offerSave && viaExternalBridge) {
    try {
      deps.offerSave({
        proposalId: id, title, body: content,
        ...(input.slug ? { targetSlug: input.slug } : {}),
        ...(normalizeCategoryPath(input.category) ? { category: normalizeCategoryPath(input.category)! } : {}),
      });
      appCardShown = true;
    } catch { /* 카드 실패는 모델 질문 경로에 영향 없음 */ }
  }
  const folder = normalizeCategoryPath(input.category) ?? 'unsorted';
  const target = input.slug ? `appended to the existing page "${input.slug}"` : 'a new page';
  return ok(
    `NOT SAVED YET — nothing is published. This client did not show the save dialog, so proposal ${id} is only queued.\n\n` +
    `Ask the user now, using this client's own question UI: save "${title}" to the Engram wiki? ` +
    `(${target}, folder "${folder}")\n` +
    `• yes → call approve_proposal with id ${id}\n` +
    `• no  → call reject_proposal with id ${id}\n` +
    (appCardShown
      ? `The Engram app is showing the same save card — answering in either place completes it. If approve_proposal ` +
        `says the proposal is missing, it was already handled there; just tell the user it is done.\n`
      : '') +
    `Do not leave it queued without asking, and do not decide on the user's behalf — they will otherwise ` +
    `believe it was saved. If they want to stop being asked, tell them about the wiki.autosave setting.`,
  );
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
    name: 'wiki-save', description: 'Save knowledge from this conversation to the Engram wiki (asks you first)',
    args: [{ name: 'topic', description: 'optional — what to save; defaults to the key insight of the conversation', required: false }],
    text: (a) => `Distill ${a.topic ? `the topic "${a.topic}"` : 'the most valuable reusable knowledge from this conversation'} into a concise wiki page (clear title, markdown body). Before submitting, search the wiki (wiki_search) for an existing page on the same topic — if one clearly covers it, pass its slug to wiki_propose so your note is appended there instead of creating a duplicate; otherwise submit without a slug to create a new page. Then report the result as wiki_propose gave it: it shows the user a dialog and, when they accept, the page is saved right then — say it is saved and stop. Only if it reports the item as queued (nobody could be asked) tell the user it is waiting for approve_proposal.`,
  },
  // 위키 정리(마이그레이션, 2026-07-27). 도구는 이미 다 있었지만 "전체를 한 번에 정리해라"는
  // 입구가 없어서 아무도 못 했다. 분류는 고정 목록이 아니라 지금 위키에 뭐가 들었느냐에서 나온다.
  {
    name: 'organize', description: 'Sort the whole Engram wiki into folders, derived from what it actually holds',
    args: [{ name: 'hint', description: 'optional — how you want it grouped (e.g. "keep it coarse")', required: false }],
    text: (a) => `Organize the Engram wiki into folders.

1. Call wiki_list to get every page and the folders currently in use.
2. Read the pages you are unsure about with wiki_read — decide by what a page is ABOUT, not by its slug.
3. Work out a small set of broad folders that covers this wiki. Do not impose a generic taxonomy: the folders must come from the material in front of you, and a folder should hold several pages. Reuse folders that already exist rather than renaming them for style. Two levels only if one is genuinely too coarse.
4. Call wiki_recategorize for each page that should move. Skip pages already in the right folder.
5. Report the resulting folders with their page counts, and name any page you were unsure about.

Do not edit page titles or bodies — only folders change.${a.hint ? `\n\nThe user asks: ${a.hint}` : ''}`,
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
  'When a conversation produces reusable knowledge (a solved problem, a decision, a how-to), call wiki_propose. Do NOT ask "save this?" in chat first — wiki_propose asks the user itself, in a dialog, and that dialog is the one and only place that question gets asked. Asking in chat as well just makes the user answer the same question twice. Before proposing, search the wiki (wiki_search) for an existing page on the same topic — if one clearly covers it, pass that page\'s slug to wiki_propose so your note is appended there instead of creating a duplicate page; otherwise omit slug to create a new page. Also pass a category. Folders are not a fixed vocabulary — they are whatever the wiki has grown, so call wiki_list to see the folders in use, put the page in the one that fits, and name a new broad folder only when nothing does. Pages saved without a category pile up unsorted. Use wiki_recategorize when a page is clearly in the wrong folder.',
  'When the user accepts that dialog the page is saved right then — wiki_propose finishes the job and tells you so. Do not call approve_proposal afterwards and do not ask the user anything else about it; one approval means saved. Only when the dialog could not be shown does wiki_propose leave the item queued, and it says so; those queued items are reviewed in chat with list_proposals and approved with approve_proposal for whichever one the user names.',
].join('\n\n');

// 낡은 플러그인 안내를 뒤에 덧붙인 안내문. 낡지 않았으면 원문 그대로(바이트 동일 — 회귀 0).
// initialize 때 한 번만 계산된다(instructions는 연결 시 1회 주입).
export function instructionsWithPluginNotice(env: NodeJS.ProcessEnv = process.env): string {
  const notice = stalePluginNotice(env);
  return notice ? `${ENGRAM_MCP_INSTRUCTIONS}\n\n${notice}` : ENGRAM_MCP_INSTRUCTIONS;
}

// extraNotice: 이 실행 환경에서만 참인 사실(예: 쓰기가 샌드박스로 리디렉션된다)을 안내문 끝에 붙인다.
// 로그가 아니라 instructions에 실어야 모델을 거쳐 사용자에게 닿는다.
export function buildMcpServer(deps: McpDeps, extraNotice?: string | null): Server {
  const base = instructionsWithPluginNotice();
  const server = new Server(
    { name: 'engram', version: '1.0.0' },
    { capabilities: { tools: {}, prompts: {} }, instructions: extraNotice ? `${base}\n\n${extraNotice}` : base },
  );

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    // 승인 계열 프롬프트는 승인 어댑터가, 설정 프롬프트는 설정 어댑터가 있을 때만(도구 노출 조건과 일치).
    const prompts = PROMPTS.filter((p) => {
      if (p.name === 'proposals' || p.name === 'approve') return !!deps.proposals;
      if (p.name === 'config' || p.name === 'config-set') return !!deps.settings;
      // 정리는 폴더를 옮길 수 있을 때만 의미가 있다(도구 노출 조건과 같은 관례).
      if (p.name === 'organize') return !!deps.recategorize;
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
    if (deps.recategorize) tools.push(WIKI_RECATEGORIZE_TOOL);
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
        case 'wiki_recategorize':
          return await callWikiRecategorize(deps, args);
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
