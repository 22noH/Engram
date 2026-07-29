import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, CallToolResult, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEFAULT_CHAT_PORT } from './edge/messenger/chat.config';
import { instructionsWithPluginNotice, BRIDGE_APPROVED_CLIENT } from './edge/mcp/engram-mcp';
import { confirmWikiSave, declinedText, WikiSaveRequest } from './edge/mcp/mcp-elicit';
import { loadWikiSaveMode } from './knowledge-core/wiki/wiki-save.config';
import { CHANNEL_ARG, isBrowserToolName } from '../shared/browser-ops';

// 독립 stdio↔HTTP 브리지 엔트리(설계 §3.3). 구형(stdio 전용) MCP 클라이언트가 상주의
// /mcp(HTTP, Task 1·2)에 접속할 수 있게 해준다: `node dist/src/mcp-bridge.js [--port N]`.
//
// 연결 전략(둘 중 단순한 쪽 채택): 요청마다 새 SDK Client를 만들어 연결→호출→닫기
// (lazy per-request). 캐시+재연결 로직이 없어 가장 단순하고(ponytail), 상주가 재시작돼도
// 다음 요청이 새로 연결하므로 자동 복구된다 — 캐시 유지가 주는 이득(연결 재사용 비용 절감)보다
// stdio 브리지의 저빈도 호출 특성상 단순함·상주 재시작 내성이 더 값지다.

const UPSTREAM_TIMEOUT_MS = 60_000;

async function withUpstream<T>(
  url: string,
  fn: (client: Client) => Promise<T>,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
  // 사람이 이 브리지의 선택창에서 저장을 눌렀을 때만 승인 이름으로 붙는다 — 상류는 이 이름을 보고
  // 앱 저장 카드를 띄우지 않고(중복 질문 금지) 그 자리에서 게시까지 끝낸다.
  clientName = 'engram-bridge',
): Promise<T> {
  const client = new Client({ name: clientName, version: '1.0.0' });
  // ★8b-2 교훈: 언핸들드 'error'는 호스트 크래시 — 구독 필수(mcp-client.ts와 동일 패턴).
  client.onerror = (e) => console.error('[mcp-bridge] client error:', e);
  const transport = new StreamableHTTPClientTransport(new URL(url));
  transport.onerror = (e) => console.error('[mcp-bridge] transport error:', e);
  // ★8a 교훈(스톨 클래스): 거부(ECONNREFUSED)는 즉시 실패하지만 '멈춘' 상주는 영원히 대기
  // — connect+호출 전 구간에 타임아웃(초과 시 catch에서 close로 정리).
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport);
        return fn(client);
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`upstream timeout (${timeoutMs}ms)`)), timeoutMs); }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    try {
      await client.close();
    } catch {
      /* 종료 실패 무해 — 이번 요청은 이미 끝났음 */
    }
  }
}

// ★AI 웹 조작(2단계)의 채널 정체성 바인딩 — 이 파일이 그 유일한 통로다.
//
// 문제: MCP 도구는 "어느 대화에서 불렸는지"를 모른다(위키 ask-user-ui-mcp 선례 — 그래서 ask_user의
// MCP안이 폐기됐다). 브라우저 조작은 다단계라 펜스 텍스트로 우회할 수도 없다.
// 해결: 엔그램의 CLI 하네스는 턴마다 `claude -p`를 새로 스폰하고, claude는 그 env를 그대로 물려준
// stdio MCP 서버(=이 브리지)를 띄운다. 실측 확인(2026-07-25): 부모가 ENGRAM_CHANNEL_ID를 걸면
// MCP 서버 자식이 그 값을 그대로 본다. 그래서 이 프로세스의 env가 곧 "이 턴의 채널"이다.
//
// 절대 하지 않는 것: env가 없을 때 "마지막에 활성화된 채널" 같은 추측. 채널 두 개를 동시에 쓰면
// 조용히 남의 화면을 조작하게 된다 — 정체성이 없으면 상류가 정직하게 실패한다(engram-mcp.ts).
export function withChannelIdentity(
  name: string,
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  if (!isBrowserToolName(name)) return args;
  const channelId = (env.ENGRAM_CHANNEL_ID ?? '').trim();
  if (!channelId) return args;
  // 모델이 보낸 _channel은 신뢰하지 않는다(스키마에도 없다) — env 값으로 덮어쓴다.
  return { ...args, [CHANNEL_ARG]: channelId };
}

// 저장(=사람 승인이 필요한) 도구인지 판정. 그 외 도구는 그대로 패스스루.
function wikiSaveRequest(name: string, args: Record<string, unknown>): WikiSaveRequest | null {
  if (name !== 'wiki_propose' && name !== 'wiki_write') return null;
  const slug = typeof args.slug === 'string' ? args.slug : undefined;
  return {
    title: typeof args.title === 'string' ? args.title : '',
    content: typeof args.content === 'string' ? args.content : '',
    ...(slug ? { slug } : {}),
    op: name === 'wiki_write' ? 'write' : 'propose',
  };
}

// 엔트리에서 분리한 순수 조립부(브리프 §요건) — stdio 서버를 만들고 ListTools/CallTool
// 핸들러가 그때그때 상주 /mcp에 연결해 그대로 패스스루. never-throw: 실패해도 stdio 프로토콜은
// 죽지 않는다(CallTool→isError 텍스트, ListTools→빈 목록+stderr 로그, 절대 stdout 아님).
// configDir: wiki.autosave를 읽을 설정 폴더(모르면 생략 — 그때는 늘 묻는다, 안전한 쪽).
export function makeBridgeServer(url: string, configDir?: string): Server {
  // 브리지는 도구만 패스스루라 상주의 instructions가 전달되지 않는다 — 같은 안내문을 직접 싣는다.
  const server = new Server(
    { name: 'engram-bridge', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: instructionsWithPluginNotice() },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
    try {
      return await withUpstream(url, (client) => client.listTools());
    } catch (e) {
      console.error('[mcp-bridge] listTools failed:', e instanceof Error ? e.message : String(e));
      return { tools: [] };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    try {
      // ★저장 승인 대화상자는 여기서 띄운다(2026-07-25). 상주 /mcp는 stateless HTTP라
      // 서버→클라이언트 요청 경로가 없어 elicitation을 걸 수 없다(mcp-http.ts에서 차단) — stdio를
      // 쥔 브리지가 대신 묻고, 승인된 것만 상류로 넘긴다. 상류로 가는 Client는 elicitation을
      // 선언하지 않으므로 중복 질문도 없다. 미지원 클라이언트면 confirm이 'unavailable'이라
      // 아래 패스스루가 그대로 돈다(회귀 0).
      const save = wikiSaveRequest(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
      // wiki.autosave=direct면 여기서도 묻지 않는다 — 상류에만 검사가 있으면 브리지가 먼저 물어버려
      // 설정이 무시된다(2026-07-26). 상류와 같은 파일을 읽는다(설정 단일 출처).
      const autosave = save && configDir ? loadWikiSaveMode(configDir) === 'direct' : false;
      let approvedHere = false;
      if (save && !autosave) {
        const confirm = await confirmWikiSave(server, save);
        if (confirm === 'decline') return { content: [{ type: 'text', text: declinedText(save) }] };
        approvedHere = confirm === 'accept'; // 사람이 눌렀다 — 상류가 또 묻지 않게 이름으로 알린다
      }
      // ★채널 정체성 주입(AI 웹 조작) — browser_* 호출에만 붙는다(다른 도구는 인자 바이트 동일).
      const args = withChannelIdentity(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, process.env);
      return (await withUpstream(
        url,
        (client) => client.callTool({ name: req.params.name, arguments: args }),
        undefined,
        approvedHere ? BRIDGE_APPROVED_CLIENT : undefined,
      )) as CallToolResult;
    } catch (e) {
      return {
        content: [{ type: 'text', text: `bridge error: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
  });

  return server;
}

function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= 65535;
}

export function parseBridgeArgs(argv: string[], env: NodeJS.ProcessEnv): { url: string } {
  const idx = argv.indexOf('--port');
  const argPort = idx !== -1 ? Number(argv[idx + 1]) : NaN;
  const envPort = env.ENGRAM_PORT !== undefined ? Number(env.ENGRAM_PORT) : NaN;
  const port = isValidPort(argPort) ? argPort : isValidPort(envPort) ? envPort : DEFAULT_CHAT_PORT;
  return { url: `http://127.0.0.1:${port}/mcp` };
}

// 엔트리(직접 실행될 때만) — require.main===module로 테스트 임포트 시 자동실행 방지.
if (require.main === module) {
  const { url } = parseBridgeArgs(process.argv, process.env);
  const server = makeBridgeServer(url);
  const transport = new StdioServerTransport();
  server.connect(transport).catch((e) => {
    console.error('[mcp-bridge] fatal: failed to start stdio transport:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
