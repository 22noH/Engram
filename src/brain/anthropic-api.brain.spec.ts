import { AnthropicApiBrain } from './anthropic-api.brain';
import { BrainProfile } from './brain.config';

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

  it('opts.cwd(코딩 신호)는 즉시 isError', async () => {
    const r = await new AnthropicApiBrain(PROFILE, jest.fn() as unknown as typeof fetch).complete('x', undefined, { cwd: 'C:/repo' });
    expect(r.isError).toBe(true);
    expect(String(r.raw)).toContain('8b');
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
    expect(JSON.stringify((fetchFn as jest.Mock).mock.calls[1][1].body)).toContain('리뷰 결과');
  });

  it('opts.delegate 없으면 ask_brain 미노출(web 도구만)', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_TURN)) as unknown as typeof fetch;
    await new AnthropicApiBrain(PROFILE, fetchFn).complete('hi');
    const body = JSON.parse((fetchFn as jest.Mock).mock.calls[0][1].body);
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['web_search', 'web_fetch']);
  });
});
