import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OpenAiApiBrain } from './openai-api.brain';
import { BrainProfile } from './brain.config';

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
  provider: 'openai-api', cli: '', model: 'llama3.3', concurrency: 1, timeoutMs: 5000,
  extraArgs: [], baseUrl: 'http://localhost:11434/v1',
};

function sse(chunks: Array<Record<string, unknown>>): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const TEXT_CHUNKS = [
  { choices: [{ delta: { content: 'Hi' } }] },
  { choices: [{ delta: { content: '!' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
];

const TOOL_CHUNKS = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'web_fetch', arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"url":"https://example.com/a"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } },
];

describe('OpenAiApiBrain', () => {
  it('단발 텍스트: onChunk 스트리밍 + usage 집계', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_CHUNKS)) as unknown as typeof fetch;
    const brain = new OpenAiApiBrain(PROFILE, fetchFn);
    const chunks: string[] = [];
    const r = await brain.complete('hello', (t) => chunks.push(t));
    expect(r.isError).toBe(false);
    expect(r.text).toBe('Hi!');
    expect(chunks).toEqual(['Hi', '!']);
    expect(r.costUsd).toBe(0); // 단가 미설정=0(Ollama)
    const req = (fetchFn as jest.Mock).mock.calls[0];
    expect(String(req[0])).toBe('http://localhost:11434/v1/chat/completions');
    expect(JSON.parse(req[1].body).tools[0].type).toBe('function');
    expect(req[1].headers.Authorization).toBeUndefined(); // apiKey 없음
  });

  it('도구루프: tool_calls 인자 조립 → 실행 → role:tool 되먹임 → 최종 답', async () => {
    let call = 0;
    const fetchFn = jest.fn(async (url: string) => {
      if (String(url).includes('/chat/completions')) {
        call++;
        return call === 1 ? sse(TOOL_CHUNKS) : sse(TEXT_CHUNKS);
      }
      return new Response('<p>Page body</p>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
    const r = await new OpenAiApiBrain(PROFILE, fetchFn).complete('go');
    expect(r.isError).toBe(false);
    expect(r.text).toBe('Hi!');
    const second = JSON.parse((fetchFn as jest.Mock).mock.calls.filter((c) => String(c[0]).includes('/chat/completions'))[1][1].body);
    const roles = second.messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool']);
    expect(second.messages[1].tool_calls[0].function.name).toBe('web_fetch');
    expect(second.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call1' });
    expect(second.messages[2].content).toContain('Page body');
  });

  it('apiKey 있으면 Bearer 헤더', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_CHUNKS)) as unknown as typeof fetch;
    await new OpenAiApiBrain({ ...PROFILE, apiKey: 'sk-o' }, fetchFn).complete('x');
    expect((fetchFn as jest.Mock).mock.calls[0][1].headers.Authorization).toBe('Bearer sk-o');
  });

  it('baseUrl 없으면 즉시 isError', async () => {
    const r = await new OpenAiApiBrain({ ...PROFILE, baseUrl: undefined }, jest.fn() as unknown as typeof fetch).complete('x');
    expect(r.isError).toBe(true);
    expect(String(r.raw)).toContain('baseUrl');
  });

  it('model 없으면 즉시 isError', async () => {
    const r = await new OpenAiApiBrain({ ...PROFILE, model: '' }, jest.fn() as unknown as typeof fetch).complete('x');
    expect(r.isError).toBe(true);
    expect(String(r.raw)).toContain('model');
  });

  it('opts.cwd는 즉시 isError·HTTP 5xx는 isError', async () => {
    const r1 = await new OpenAiApiBrain(PROFILE, jest.fn() as unknown as typeof fetch).complete('x', undefined, { cwd: 'C:/r' });
    expect(r1.isError).toBe(true);
    const f = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    const r2 = await new OpenAiApiBrain(PROFILE, f).complete('x');
    expect(r2.isError).toBe(true);
    expect(String(r2.raw)).toContain('503');
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
      if (String(url).includes('/chat/completions')) {
        modelCalls++;
        if (modelCalls === 1) return Promise.resolve(sse(TOOL_CHUNKS));
        return hangUntilAbort(init);
      }
      // web_fetch 도구 호출 — signal을 캡처하고 abort될 때까지 매달린다.
      toolSignal = init?.signal;
      return hangUntilAbort(init);
    }) as unknown as typeof fetch;
    const brain = new OpenAiApiBrain(PROFILE, fetchFn);
    const r = await brain.complete('x', undefined, { timeoutMs: 30 });
    expect(r.isError).toBe(true);
    expect(String(r.raw)).toContain('timeout');
    expect(toolSignal).toBeDefined();
    expect(toolSignal?.aborted).toBe(true);
  });

  it('opts.delegate 있으면 ask_brain 도구 노출 + 호출 시 delegate.run 라우팅', async () => {
    const ASK_CHUNKS = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'ask_brain', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"brain":"claude","task":"리뷰"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } },
    ];
    let call = 0;
    const fetchFn = jest.fn(async () => { call++; return call === 1 ? sse(ASK_CHUNKS) : sse(TEXT_CHUNKS); }) as unknown as typeof fetch;
    const ran: Array<{ brain: string; task: string }> = [];
    const delegate = { brains: ['claude', 'ollama'], run: async (brain: string, task: string) => { ran.push({ brain, task }); return '리뷰 결과'; } };
    const r = await new OpenAiApiBrain(PROFILE, fetchFn).complete('go', undefined, { delegate });
    expect(r.isError).toBe(false);
    expect(ran).toEqual([{ brain: 'claude', task: '리뷰' }]);
    const firstBody = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    const askDef = firstBody.tools.find((t: { function: { name: string } }) => t.function.name === 'ask_brain');
    expect(askDef).toBeDefined();
    expect(askDef.function.description).toContain('claude');
    expect(askDef.function.parameters.required).toEqual(['brain', 'task']); // parameters 매핑이 새 도구에도 적용됨
    expect(JSON.stringify((fetchFn as jest.Mock).mock.calls[1][1].body)).toContain('리뷰 결과');
  });

  it('opts.delegate 없으면 ask_brain 미노출', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_CHUNKS)) as unknown as typeof fetch;
    await new OpenAiApiBrain(PROFILE, fetchFn).complete('hi');
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['web_search', 'web_fetch']);
  });

  it('opts.askUser 있으면 ask_user 도구 노출 + 호출 시 askUser 라우팅(Task 4)', async () => {
    const ASK_USER_CHUNKS = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'ask_user', arguments: '' } }] } }] },
      {
        choices: [{
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"questions":[{"q":"어느 브랜치?","options":[{"label":"main"},{"label":"staging"}]}]}' } }],
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } },
    ];
    let call = 0;
    const fetchFn = jest.fn(async () => { call++; return call === 1 ? sse(ASK_USER_CHUNKS) : sse(TEXT_CHUNKS); }) as unknown as typeof fetch;
    const asked: unknown[] = [];
    const askUser = async (q: unknown) => { asked.push(q); };
    const r = await new OpenAiApiBrain(PROFILE, fetchFn).complete('go', undefined, { askUser });
    expect(r.isError).toBe(false);
    expect(asked).toHaveLength(1);
    const firstBody = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    const askDef = firstBody.tools.find((t: { function: { name: string } }) => t.function.name === 'ask_user');
    expect(askDef).toBeDefined();
    expect(askDef.function.parameters.required).toEqual(['questions']);
    expect(JSON.stringify((fetchFn as jest.Mock).mock.calls[1][1].body)).toContain('질문 카드를 게시했다');
  });

  it('opts.askUser 없으면 ask_user 미노출', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_CHUNKS)) as unknown as typeof fetch;
    await new OpenAiApiBrain(PROFILE, fetchFn).complete('hi');
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['web_search', 'web_fetch']);
  });

  it('opts.cwd+codeGuard면 코딩 루프: Write 도구가 파일을 만든다', async () => {
    const WRITE_CHUNKS = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'w1', type: 'function', function: { name: 'Write', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt","content":"hi"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } },
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-obrain-'));
    try {
      let call = 0;
      const fetchFn = jest.fn(async () => { call++; return call === 1 ? sse(WRITE_CHUNKS) : sse(TEXT_CHUNKS); }) as unknown as typeof fetch;
      const guarded: string[] = [];
      const codeGuard = (p: string) => { guarded.push(p); };
      const r = await new OpenAiApiBrain(PROFILE, fetchFn).complete('do', undefined, { cwd: dir, codeGuard });
      expect(r.isError).toBe(false);
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('hi');
      expect(guarded).toContain(path.resolve(dir, 'a.txt'));
      const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
      expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('opts.cwd 있고 codeGuard 없으면 isError(모델 호출 안 함)', async () => {
    const fetchFn = jest.fn() as unknown as typeof fetch;
    const r = await new OpenAiApiBrain(PROFILE, fetchFn).complete('do', undefined, { cwd: 'C:/x' });
    expect(r.isError).toBe(true);
    expect((fetchFn as jest.Mock)).not.toHaveBeenCalled();
  });

  it('coding + cmdGuard면 Bash 도구 노출 + 실행', async () => {
    const BASH_CHUNKS = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'b1', type: 'function', function: { name: 'Bash', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `{"command":"node -e \\"console.log('ran')\\""}` } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } },
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-obash-'));
    try {
      let call = 0;
      const fetchFn = jest.fn(async () => { call++; return call === 1 ? sse(BASH_CHUNKS) : sse(TEXT_CHUNKS); }) as unknown as typeof fetch;
      const seen: string[] = [];
      const r = await new OpenAiApiBrain(PROFILE, fetchFn).complete('do', undefined, {
        cwd: dir, codeGuard: () => {}, cmdGuard: (c: string) => { seen.push(c); },
      });
      expect(r.isError).toBe(false);
      expect(seen.length).toBe(1);
      const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
      expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toContain('Bash');
      expect(JSON.stringify((fetchFn as jest.Mock).mock.calls[1][1].body)).toContain('ran');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('coding인데 cmdGuard 없으면 Bash 미노출', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_CHUNKS)) as unknown as typeof fetch;
    await new OpenAiApiBrain(PROFILE, fetchFn).complete('do', undefined, { cwd: 'C:/x', codeGuard: () => {} });
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
  });
});

describe('OpenAiApiBrain — 첨부 vision 이미지 블록(Task 3, chat-attachments)', () => {
  it('opts.images 없으면 초기 user content가 문자열 그대로(요청 바디 byte-identical, 회귀 0)', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_CHUNKS)) as unknown as typeof fetch;
    await new OpenAiApiBrain(PROFILE, fetchFn).complete('hello');
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hello' });
  });

  it('opts.images 있으면 초기 user content가 [text, image_url...] 블록 배열로 실린다(data URL)', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_CHUNKS)) as unknown as typeof fetch;
    const images = [{ mime: 'image/png', dataBase64: 'AAAA' }];
    await new OpenAiApiBrain(PROFILE, fetchFn).complete('describe this', undefined, { images });
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
  });

  it('opts.images 여러 장이면 순서대로 텍스트 뒤에 image_url 블록이 이어진다', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_CHUNKS)) as unknown as typeof fetch;
    const images = [
      { mime: 'image/png', dataBase64: 'AAAA' },
      { mime: 'image/jpeg', dataBase64: 'BBBB' },
    ];
    await new OpenAiApiBrain(PROFILE, fetchFn).complete('x', undefined, { images });
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.messages[0].content).toHaveLength(3);
    expect(body.messages[0].content[1].image_url.url).toBe('data:image/png;base64,AAAA');
    expect(body.messages[0].content[2].image_url.url).toBe('data:image/jpeg;base64,BBBB');
  });
});

describe('OpenAiApiBrain — MCP 배선(8c-1)', () => {
  beforeEach(() => {
    (loadMcpServers as jest.Mock).mockReset().mockReturnValue({});
    (McpSession.create as jest.Mock).mockReset();
  });

  it('configDir 미전달이면 loadMcpServers 자체를 호출하지 않음(기존 두뇌 100% 회귀 0)', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_CHUNKS)) as unknown as typeof fetch;
    const r = await new OpenAiApiBrain(PROFILE, fetchFn).complete('hi');
    expect(r.isError).toBe(false);
    expect(loadMcpServers as jest.Mock).not.toHaveBeenCalled();
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['web_search', 'web_fetch']);
  });

  it('configDir는 있으나 mcp.json 서버 없음 → mcp__ 도구 없음', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_CHUNKS)) as unknown as typeof fetch;
    const r = await new OpenAiApiBrain(PROFILE, fetchFn, '/cfg').complete('hi');
    expect(r.isError).toBe(false);
    expect(loadMcpServers as jest.Mock).toHaveBeenCalledWith('/cfg');
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['web_search', 'web_fetch']);
  });

  it('서버 1개 연결 성공 → 채팅 toolDefs 끝에 mcp__ 도구 추가 + 호출 시 해당 세션 callTool로 라우팅', async () => {
    (loadMcpServers as jest.Mock).mockReturnValue({ srv: { command: 'node', args: [], env: {} } });
    const session = fakeMcpSession();
    (McpSession.create as jest.Mock).mockReturnValue(session);
    const MCP_CHUNKS = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'm1', type: 'function', function: { name: 'mcp__srv__tool', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } },
    ];
    let call = 0;
    const fetchFn = jest.fn(async () => { call++; return call === 1 ? sse(MCP_CHUNKS) : sse(TEXT_CHUNKS); }) as unknown as typeof fetch;
    const r = await new OpenAiApiBrain(PROFILE, fetchFn, '/cfg').complete('hi');
    expect(r.isError).toBe(false);
    expect(McpSession.create as jest.Mock).toHaveBeenCalledWith('srv', { command: 'node', args: [], env: {} });
    const firstBody = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(firstBody.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['web_search', 'web_fetch', 'mcp__srv__tool']);
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
    const fetchFn = jest.fn(async () => sse(TEXT_CHUNKS)) as unknown as typeof fetch;
    const r = await new OpenAiApiBrain(PROFILE, fetchFn, '/cfg').complete('hi');
    expect(r.isError).toBe(false);
    expect(dead.close).toHaveBeenCalledTimes(1);
    expect(dead.listToolDefs).not.toHaveBeenCalled();
    expect(alive.close).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['web_search', 'web_fetch', 'mcp__alive__t']);
  });

  it('알 수 없는 mcp__ 도구 호출은 에러 텍스트로 되먹임(소유 세션 없음)', async () => {
    (loadMcpServers as jest.Mock).mockReturnValue({ srv: { command: 'node', args: [], env: {} } });
    const session = fakeMcpSession({ owns: () => false });
    (McpSession.create as jest.Mock).mockReturnValue(session);
    const MCP_CHUNKS = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'm1', type: 'function', function: { name: 'mcp__srv__tool', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } },
    ];
    let call = 0;
    const fetchFn = jest.fn(async () => { call++; return call === 1 ? sse(MCP_CHUNKS) : sse(TEXT_CHUNKS); }) as unknown as typeof fetch;
    const r = await new OpenAiApiBrain(PROFILE, fetchFn, '/cfg').complete('hi');
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
    const r = await new OpenAiApiBrain(PROFILE, fetchFn, '/cfg').complete('x', undefined, { timeoutMs: 30 });
    expect(r.isError).toBe(true);
    expect(String(r.raw)).toContain('timeout');
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('코딩 루프(opts.cwd+codeGuard)에서도 mcp__ 도구가 병합된다', async () => {
    (loadMcpServers as jest.Mock).mockReturnValue({ srv: { command: 'node', args: [], env: {} } });
    const session = fakeMcpSession();
    (McpSession.create as jest.Mock).mockReturnValue(session);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-obrain-mcp-'));
    try {
      const fetchFn = jest.fn(async () => sse(TEXT_CHUNKS)) as unknown as typeof fetch;
      const r = await new OpenAiApiBrain(PROFILE, fetchFn, '/cfg').complete('do', undefined, { cwd: dir, codeGuard: () => {} });
      expect(r.isError).toBe(false);
      const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
      expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'mcp__srv__tool']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
