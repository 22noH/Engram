import { sseJson } from './sse';

async function collect(text: string): Promise<Array<Record<string, unknown>>> {
  const res = new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const out: Array<Record<string, unknown>> = [];
  for await (const ev of sseJson(res.body)) out.push(ev);
  return out;
}

describe('sseJson', () => {
  it('여러 이벤트를 순서대로 파싱한다', async () => {
    const text = 'data: {"a":1}\n\ndata: {"a":2}\n\ndata: [DONE]\n\n';
    expect(await collect(text)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('마지막 data: 라인에 trailing 개행이 없어도 플러시한다(Finding3)', async () => {
    const text = 'data: {"a":1}\n\ndata: {"a":2}';
    expect(await collect(text)).toEqual([{ a: 1 }, { a: 2 }]);
  });
});
