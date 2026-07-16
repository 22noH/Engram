import { OpenAiApiBrain } from './openai-api.brain';
import { BrainProfile } from './brain.config';

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
});
