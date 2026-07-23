import { AnthropicApiBrain } from './anthropic-api.brain';
import { BrainProfile } from './brain.config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// MCP(8c-1): 프로토콜은 Task2가 커버 — 여기선 두뇌의 병합·라우팅·수명(close)만 검증.
jest.mock('./mcp-client', () => ({ MCP_TOOL_PREFIX: 'mcp__', McpSession: { create: jest.fn() } }));
jest.mock('./mcp-config', () => ({ loadMcpServers: jest.fn() }));
import { McpSession } from './mcp-client';
import { loadMcpServers } from './mcp-config';

function fakeMcpSession(overrides: {
  connect?: jest.Mock; listToolDefs?: jest.Mock; owns?: (n: string) => boolean; callTool?: jest.Mock; close?: jest.Mock;
} = {}) {
  return {
    connect: overrides.connect ?? jest.fn().mockResolvedValue(true),
    listToolDefs: overrides.listToolDefs ?? jest.fn().mockResolvedValue([
      { name: 'mcp__srv__tool', description: 'a tool', parameters: { type: 'object' } },
    ]),
    owns: overrides.owns ?? ((n: string) => n === 'mcp__srv__tool'),
    callTool: overrides.callTool ?? jest.fn().mockResolvedValue('mcp tool result'),
    close: overrides.close ?? jest.fn().mockResolvedValue(undefined),
  };
}

const PROFILE: BrainProfile = {
  provider: 'anthropic-api', cli: '', model: 'claude-opus-4-8', concurrency: 1, timeoutMs: 5000,
  extraArgs: [], apiKey: 'sk-test', inputUsdPerMTok: 5, outputUsdPerMTok: 25,
};

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const TEXT_TURN = [
  { type: 'message_start', message: { usage: { input_tokens: 100 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '안' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '녕' } },
  { type: 'message_delta', usage: { output_tokens: 4 } },
];

const TOOL_TURN = [
  { type: 'message_start', message: { usage: { input_tokens: 50 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'web_fetch' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"url":"https://ex' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ample.com/a"}' } },
  { type: 'message_delta', usage: { output_tokens: 2 } },
];

describe('AnthropicApiBrain', () => {
  it('단발 텍스트: 스트리밍 onChunk + 최종 텍스트 + costUsd 계산', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_TURN)) as unknown as typeof fetch;
    const brain = new AnthropicApiBrain(PROFILE, fetchFn);
    const chunks: string[] = [];
    const r = await brain.complete('hello', (t) => chunks.push(t));
    expect(r.isError).toBe(false);
    expect(r.text).toBe('안녕');
    expect(chunks).toEqual(['안', '녕']);
    expect(r.costUsd).toBeCloseTo((100 * 5 + 4 * 25) / 1_000_000);
    const req = (fetchFn as jest.Mock).mock.calls[0];
    expect(String(req[0])).toContain('/v1/messages');
    const body = JSON.parse(req[1].body);
    expect(body.stream).toBe(true);
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['web_search', 'web_fetch']);
    expect(req[1].headers['x-api-key']).toBe('sk-test');
  });

  it('도구루프: tool_use → web_fetch 실행 → tool_result 되먹임 → 최종 답', async () => {
    let call = 0;
    const fetchFn = jest.fn(async (url: string) => {
      if (String(url).includes('/v1/messages')) {
        call++;
        return call === 1 ? sse(TOOL_TURN) : sse(TEXT_TURN);
      }
      return new Response('<html><body>Hello page</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
    const brain = new AnthropicApiBrain(PROFILE, fetchFn);
    const r = await brain.complete('fetch it');
    expect(r.isError).toBe(false);
    expect(r.text).toBe('안녕');
    // 두 번째 모델 호출 body에 assistant tool_use + user tool_result가 실려야 함
    const secondBody = JSON.parse((fetchFn as jest.Mock).mock.calls.filter((c) => String(c[0]).includes('/v1/messages'))[1][1].body);
    const roles = secondBody.messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(secondBody.messages[2])).toContain('tool_result');
    expect(JSON.stringify(secondBody.messages[2])).toContain('Hello page');
    // 토큰 집계: 두 턴 합산
    expect(r.costUsd).toBeCloseTo(((50 + 100) * 5 + (2 + 4) * 25) / 1_000_000);
  });

  it('HTTP 4xx는 isError(never-throw)', async () => {
    const fetchFn = (async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch;
    const r = await new AnthropicApiBrain(PROFILE, fetchFn).complete('x');
    expect(r.isError).toBe(true);
    expect(String(r.raw)).toContain('401');
  });

  it('apiKey 없으면 즉시 isError(fetch 미호출)', async () => {
    const fetchFn = jest.fn() as unknown as typeof fetch;
    const r = await new AnthropicApiBrain({ ...PROFILE, apiKey: undefined }, fetchFn).complete('x');
    expect(r.isError).toBe(true);
    expect(String(r.raw)).toContain('apiKey');
    expect((fetchFn as jest.Mock)).not.toHaveBeenCalled();
  });

  it('opts.cwd(코딩 신호)는 codeGuard 없으면 즉시 isError', async () => {
    const r = await new AnthropicApiBrain(PROFILE, jest.fn() as unknown as typeof fetch).complete('x', undefined, { cwd: 'C:/repo' });
    expect(r.isError).toBe(true);
    expect(String(r.raw)).toContain('codeGuard');
  });

  it('타임아웃은 isError(raw=timeout)', async () => {
    const fetchFn = ((_u: string, init: { signal: AbortSignal }) =>
      new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
    const r = await new AnthropicApiBrain(PROFILE, fetchFn).complete('x', undefined, { timeoutMs: 30 });
    expect(r.isError).toBe(true);
    expect(String(r.raw)).toContain('timeout');
  });

  it('타임아웃이 도구 실행도 덮는다(Finding1: hanging web_fetch가 루프 타임아웃을 무시하지 않는다)', async () => {
    let modelCalls = 0;
    let toolSignal: AbortSignal | undefined;
    const hangUntilAbort = (init?: { signal?: AbortSignal }) =>
      new Promise((_res, rej) => {
        if (init?.signal?.aborted) return rej(new Error('aborted'));
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      });
    const fetchFn = jest.fn((url: string, init?: { signal?: AbortSignal }) => {
      if (String(url).includes('/v1/messages')) {
        modelCalls++;
        if (modelCalls === 1) return Promise.resolve(sse(TOOL_TURN));
        // 도구가 abort로 끝난 뒤 루프가 모델을 다시 부른다 — 이 턴도 abort될 때까지 매달려 루프가
        // 결국 타임아웃으로 종료되도록 한다(도구 abort만으로는 루프가 멈추지 않으므로).
        return hangUntilAbort(init);
      }
      // web_fetch 도구 호출 — signal을 캡처하고 abort될 때까지 매달린다.
      toolSignal = init?.signal;
      return hangUntilAbort(init);
    }) as unknown as typeof fetch;
    const brain = new AnthropicApiBrain(PROFILE, fetchFn);
    const r = await brain.complete('x', undefined, { timeoutMs: 30 });
    expect(r.isError).toBe(true);
    expect(String(r.raw)).toContain('timeout');
    expect(toolSignal).toBeDefined();
    expect(toolSignal?.aborted).toBe(true);
  });

  it('opts.delegate 있으면 ask_brain 도구 노출 + 호출 시 delegate.run 라우팅', async () => {
    const ASK_TURN = [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'ab1', name: 'ask_brain' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"brain":"ollama","task":"리뷰"}' } },
      { type: 'message_delta', usage: { output_tokens: 2 } },
    ];
    let call = 0;
    const fetchFn = jest.fn(async () => { call++; return call === 1 ? sse(ASK_TURN) : sse(TEXT_TURN); }) as unknown as typeof fetch;
    const ran: Array<{ brain: string; task: string }> = [];
    const delegate = { brains: ['ollama', 'claude'], run: async (brain: string, task: string) => { ran.push({ brain, task }); return '리뷰 결과'; } };
    const r = await new AnthropicApiBrain(PROFILE, fetchFn).complete('do it', undefined, { delegate });
    expect(r.isError).toBe(false);
    expect(ran).toEqual([{ brain: 'ollama', task: '리뷰' }]);
    const firstBody = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    const askDef = firstBody.tools.find((t: { name: string }) => t.name === 'ask_brain');
    expect(askDef).toBeDefined();
    expect(askDef.description).toContain('ollama');
    expect(askDef.input_schema.required).toEqual(['brain', 'task']); // parameters→input_schema 매핑이 새 도구에도 적용됨
    expect(JSON.stringify((fetchFn as jest.Mock).mock.calls[1][1].body)).toContain('리뷰 결과');
  });

  it('opts.delegate 없으면 ask_brain 미노출(web 도구만)', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_TURN)) as unknown as typeof fetch;
    await new AnthropicApiBrain(PROFILE, fetchFn).complete('hi');
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['web_search', 'web_fetch']);
  });

  it('opts.askUser 있으면 ask_user 도구 노출 + 호출 시 askUser 라우팅(Task 4)', async () => {
    const ASK_USER_TURN = [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'au1', name: 'ask_user' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"questions":[{"q":"어느 브랜치?","options":[{"label":"main"},{"label":"staging"}]}]}' },
      },
      { type: 'message_delta', usage: { output_tokens: 2 } },
    ];
    let call = 0;
    const fetchFn = jest.fn(async () => { call++; return call === 1 ? sse(ASK_USER_TURN) : sse(TEXT_TURN); }) as unknown as typeof fetch;
    const asked: unknown[] = [];
    const askUser = async (q: unknown) => { asked.push(q); };
    const r = await new AnthropicApiBrain(PROFILE, fetchFn).complete('do it', undefined, { askUser });
    expect(r.isError).toBe(false);
    expect(asked).toHaveLength(1);
    const firstBody = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    const askDef = firstBody.tools.find((t: { name: string }) => t.name === 'ask_user');
    expect(askDef).toBeDefined();
    expect(askDef.input_schema.required).toEqual(['questions']);
    expect(JSON.stringify((fetchFn as jest.Mock).mock.calls[1][1].body)).toContain('질문 카드를 게시했다');
  });

  it('opts.askUser 없으면 ask_user 미노출(web 도구만)', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_TURN)) as unknown as typeof fetch;
    await new AnthropicApiBrain(PROFILE, fetchFn).complete('hi');
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['web_search', 'web_fetch']);
  });

  it('opts.cwd+codeGuard면 코딩 루프: Write 도구가 파일을 만든다', async () => {
    const WRITE_TURN = [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'w1', name: 'Write' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt","content":"hi"}' } },
      { type: 'message_delta', usage: { output_tokens: 2 } },
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-abrain-'));
    try {
      let call = 0;
      const fetchFn = jest.fn(async () => { call++; return call === 1 ? sse(WRITE_TURN) : sse(TEXT_TURN); }) as unknown as typeof fetch;
      const guarded: string[] = [];
      const codeGuard = (p: string) => { guarded.push(p); };
      const r = await new AnthropicApiBrain(PROFILE, fetchFn).complete('do', undefined, { cwd: dir, codeGuard });
      expect(r.isError).toBe(false);
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('hi');
      expect(guarded).toContain(path.resolve(dir, 'a.txt'));
      const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
      expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('opts.cwd 있고 codeGuard 없으면 isError(모델 호출 안 함)', async () => {
    const fetchFn = jest.fn() as unknown as typeof fetch;
    const r = await new AnthropicApiBrain(PROFILE, fetchFn).complete('do', undefined, { cwd: 'C:/x' });
    expect(r.isError).toBe(true);
    expect((fetchFn as jest.Mock)).not.toHaveBeenCalled();
  });

  it('coding + cmdGuard면 Bash 도구 노출 + 실행', async () => {
    const BASH_TURN = [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'b1', name: 'Bash' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: `{"command":"node -e \\"console.log('ran')\\""}` } },
      { type: 'message_delta', usage: { output_tokens: 2 } },
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-abash-'));
    try {
      let call = 0;
      const fetchFn = jest.fn(async () => { call++; return call === 1 ? sse(BASH_TURN) : sse(TEXT_TURN); }) as unknown as typeof fetch;
      const seen: string[] = [];
      const r = await new AnthropicApiBrain(PROFILE, fetchFn).complete('do', undefined, {
        cwd: dir, codeGuard: () => {}, cmdGuard: (c: string) => { seen.push(c); },
      });
      expect(r.isError).toBe(false);
      expect(seen.length).toBe(1); // cmdGuard 호출됨
      const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
      expect(body.tools.map((t: { name: string }) => t.name)).toContain('Bash');
      expect(JSON.stringify((fetchFn as jest.Mock).mock.calls[1][1].body)).toContain('ran'); // 실행 결과 되먹임
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('coding인데 cmdGuard 없으면 Bash 미노출(파일도구만)', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_TURN)) as unknown as typeof fetch;
    await new AnthropicApiBrain(PROFILE, fetchFn).complete('do', undefined, { cwd: 'C:/x', codeGuard: () => {} });
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
  });
});

describe('AnthropicApiBrain — MCP 배선(8c-1)', () => {
  beforeEach(() => {
    (loadMcpServers as jest.Mock).mockReset().mockReturnValue({});
    (McpSession.create as jest.Mock).mockReset();
  });

  it('configDir 미전달이면 loadMcpServers 자체를 호출하지 않음(기존 두뇌 100% 회귀 0)', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_TURN)) as unknown as typeof fetch;
    const r = await new AnthropicApiBrain(PROFILE, fetchFn).complete('hi');
    expect(r.isError).toBe(false);
    expect(loadMcpServers as jest.Mock).not.toHaveBeenCalled();
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['web_search', 'web_fetch']);
  });

  it('configDir는 있으나 mcp.json 서버 없음 → mcp__ 도구 없음', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_TURN)) as unknown as typeof fetch;
    const r = await new AnthropicApiBrain(PROFILE, fetchFn, '/cfg').complete('hi');
    expect(r.isError).toBe(false);
    expect(loadMcpServers as jest.Mock).toHaveBeenCalledWith('/cfg');
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['web_search', 'web_fetch']);
  });

  it('서버 1개 연결 성공 → 채팅 toolDefs 끝에 mcp__ 도구 추가 + 호출 시 해당 세션 callTool로 라우팅', async () => {
    (loadMcpServers as jest.Mock).mockReturnValue({ srv: { command: 'node', args: [], env: {} } });
    const session = fakeMcpSession();
    (McpSession.create as jest.Mock).mockReturnValue(session);
    const MCP_TURN = [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'm1', name: 'mcp__srv__tool' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
      { type: 'message_delta', usage: { output_tokens: 2 } },
    ];
    let call = 0;
    const fetchFn = jest.fn(async () => { call++; return call === 1 ? sse(MCP_TURN) : sse(TEXT_TURN); }) as unknown as typeof fetch;
    const r = await new AnthropicApiBrain(PROFILE, fetchFn, '/cfg').complete('hi');
    expect(r.isError).toBe(false);
    expect(McpSession.create as jest.Mock).toHaveBeenCalledWith('srv', { command: 'node', args: [], env: {} });
    const firstBody = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(firstBody.tools.map((t: { name: string }) => t.name)).toEqual(['web_search', 'web_fetch', 'mcp__srv__tool']);
    expect(session.callTool).toHaveBeenCalledWith('mcp__srv__tool', { x: 1 });
    const secondBody = JSON.parse((fetchFn as jest.Mock).mock.calls[1][1].body);
    expect(JSON.stringify(secondBody.messages)).toContain('mcp tool result');
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('connect()=false인 서버는 제외(도구 없음)하고 close 호출, 나머지 서버는 정상', async () => {
    (loadMcpServers as jest.Mock).mockReturnValue({
      dead: { command: 'node', args: [], env: {} },
      alive: { command: 'node', args: [], env: {} },
    });
    const dead = fakeMcpSession({ connect: jest.fn().mockResolvedValue(false) });
    const alive = fakeMcpSession({
      listToolDefs: jest.fn().mockResolvedValue([{ name: 'mcp__alive__t', description: 'd', parameters: { type: 'object' } }]),
      owns: (n: string) => n === 'mcp__alive__t',
    });
    (McpSession.create as jest.Mock).mockImplementation((name: string) => (name === 'dead' ? dead : alive));
    const fetchFn = jest.fn(async () => sse(TEXT_TURN)) as unknown as typeof fetch;
    const r = await new AnthropicApiBrain(PROFILE, fetchFn, '/cfg').complete('hi');
    expect(r.isError).toBe(false);
    expect(dead.close).toHaveBeenCalledTimes(1);
    expect(dead.listToolDefs).not.toHaveBeenCalled();
    expect(alive.close).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['web_search', 'web_fetch', 'mcp__alive__t']);
  });

  it('알 수 없는 mcp__ 도구 호출은 에러 텍스트로 되먹임(소유 세션 없음)', async () => {
    (loadMcpServers as jest.Mock).mockReturnValue({ srv: { command: 'node', args: [], env: {} } });
    const session = fakeMcpSession({ owns: () => false });
    (McpSession.create as jest.Mock).mockReturnValue(session);
    const MCP_TURN = [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'm1', name: 'mcp__srv__tool' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'message_delta', usage: { output_tokens: 2 } },
    ];
    let call = 0;
    const fetchFn = jest.fn(async () => { call++; return call === 1 ? sse(MCP_TURN) : sse(TEXT_TURN); }) as unknown as typeof fetch;
    const r = await new AnthropicApiBrain(PROFILE, fetchFn, '/cfg').complete('hi');
    expect(r.isError).toBe(false);
    expect(session.callTool).not.toHaveBeenCalled();
    const secondBody = JSON.parse((fetchFn as jest.Mock).mock.calls[1][1].body);
    expect(JSON.stringify(secondBody.messages)).toContain('mcp error: unknown tool mcp__srv__tool');
  });

  it('정상 종료·에러 종료(타임아웃) 모두에서 세션 close 호출(finally)', async () => {
    (loadMcpServers as jest.Mock).mockReturnValue({ srv: { command: 'node', args: [], env: {} } });
    const session = fakeMcpSession();
    (McpSession.create as jest.Mock).mockReturnValue(session);
    const fetchFn = ((_u: string, init: { signal: AbortSignal }) =>
      new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
    const r = await new AnthropicApiBrain(PROFILE, fetchFn, '/cfg').complete('x', undefined, { timeoutMs: 30 });
    expect(r.isError).toBe(true);
    expect(String(r.raw)).toContain('timeout');
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('코딩 루프(opts.cwd+codeGuard)에서도 mcp__ 도구가 병합된다', async () => {
    (loadMcpServers as jest.Mock).mockReturnValue({ srv: { command: 'node', args: [], env: {} } });
    const session = fakeMcpSession();
    (McpSession.create as jest.Mock).mockReturnValue(session);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-abrain-mcp-'));
    try {
      const fetchFn = jest.fn(async () => sse(TEXT_TURN)) as unknown as typeof fetch;
      const r = await new AnthropicApiBrain(PROFILE, fetchFn, '/cfg').complete('do', undefined, { cwd: dir, codeGuard: () => {} });
      expect(r.isError).toBe(false);
      const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
      expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'mcp__srv__tool']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
