import { runToolLoop, TurnResult } from './tool-loop';

function turnSeq(turns: TurnResult[]): () => Promise<TurnResult> {
  let i = 0;
  return async () => turns[Math.min(i++, turns.length - 1)];
}

describe('runToolLoop', () => {
  it('도구 호출 없으면 1회전에 종료·토큰 집계', async () => {
    const r = await runToolLoop(
      turnSeq([{ text: '답', toolCalls: [], inputTokens: 10, outputTokens: 5 }]),
      () => { throw new Error('호출되면 안 됨'); },
      async () => '',
    );
    expect(r).toEqual({ text: '답', inputTokens: 10, outputTokens: 5, hitLimit: false });
  });

  it('도구 호출 → 실행 → 되먹임 → 최종 텍스트(토큰 합산)', async () => {
    const pushed: unknown[] = [];
    const r = await runToolLoop(
      turnSeq([
        { text: '', toolCalls: [{ id: 't1', name: 'web_fetch', input: { url: 'u' } }], inputTokens: 10, outputTokens: 3 },
        { text: '완성 답변', toolCalls: [], inputTokens: 20, outputTokens: 7 },
      ]),
      (results) => pushed.push(results),
      async (name) => `result-of-${name}`,
    );
    expect(pushed).toEqual([[{ id: 't1', name: 'web_fetch', output: 'result-of-web_fetch' }]]);
    expect(r).toEqual({ text: '완성 답변', inputTokens: 30, outputTokens: 10, hitLimit: false });
  });

  it('상한 도달 시 hitLimit=true·마지막 텍스트 유지', async () => {
    const r = await runToolLoop(
      turnSeq([{ text: '중간 생각', toolCalls: [{ id: 'x', name: 'web_search', input: {} }], inputTokens: 1, outputTokens: 1 }]),
      () => {},
      async () => 'r',
      3,
    );
    expect(r.hitLimit).toBe(true);
    expect(r.text).toBe('중간 생각');
    expect(r.inputTokens).toBe(3);
  });

  it('도구 실행 함수가 던지면 루프도 던진다(도구 내부 never-throw는 web-tools 책임)', async () => {
    await expect(runToolLoop(
      turnSeq([{ text: '', toolCalls: [{ id: 'x', name: 'boom', input: {} }], inputTokens: 0, outputTokens: 0 }]),
      () => {},
      async () => { throw new Error('boom'); },
    )).rejects.toThrow('boom');
  });
});
