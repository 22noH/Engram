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

  describe('onTool(두뇌 활동 표시 Task 1)', () => {
    it('도구 실행 직전마다 이름·1부터 시작하는 순번으로 발화한다(실행 전에 발화됨)', async () => {
      const calls: Array<{ name: string; seq: number }> = [];
      const order: string[] = [];
      const r = await runToolLoop(
        turnSeq([
          { text: '', toolCalls: [{ id: 't1', name: 'web_search', input: {} }], inputTokens: 1, outputTokens: 1 },
          { text: '완성', toolCalls: [], inputTokens: 1, outputTokens: 1 },
        ]),
        () => {},
        async (name) => { order.push(`exec:${name}`); return 'r'; },
        8,
        (name, seq) => { calls.push({ name, seq }); order.push(`onTool:${name}:${seq}`); },
      );
      expect(calls).toEqual([{ name: 'web_search', seq: 1 }]);
      expect(order).toEqual(['onTool:web_search:1', 'exec:web_search']); // 발화가 실행보다 먼저
      expect(r.text).toBe('완성');
    });

    it('여러 회전에 걸쳐 순번이 누적된다(회전마다 리셋 아님)', async () => {
      const calls: Array<{ name: string; seq: number }> = [];
      await runToolLoop(
        turnSeq([
          { text: '', toolCalls: [{ id: 't1', name: 'a', input: {} }], inputTokens: 0, outputTokens: 0 },
          { text: '', toolCalls: [{ id: 't2', name: 'b', input: {} }, { id: 't3', name: 'c', input: {} }], inputTokens: 0, outputTokens: 0 },
          { text: '끝', toolCalls: [], inputTokens: 0, outputTokens: 0 },
        ]),
        () => {},
        async () => 'r',
        8,
        (name, seq) => calls.push({ name, seq }),
      );
      expect(calls).toEqual([{ name: 'a', seq: 1 }, { name: 'b', seq: 2 }, { name: 'c', seq: 3 }]);
    });

    it('onTool 미주입이면 회귀 0(기존 결과와 동일)', async () => {
      const r = await runToolLoop(
        turnSeq([
          { text: '', toolCalls: [{ id: 't1', name: 'web_fetch', input: { url: 'u' } }], inputTokens: 10, outputTokens: 3 },
          { text: '완성 답변', toolCalls: [], inputTokens: 20, outputTokens: 7 },
        ]),
        () => {},
        async (name) => `result-of-${name}`,
      );
      expect(r).toEqual({ text: '완성 답변', inputTokens: 30, outputTokens: 10, hitLimit: false });
    });

    it('onTool이 던져도 도구 실행 자체는 계속된다(never-throw 격리)', async () => {
      const r = await runToolLoop(
        turnSeq([
          { text: '', toolCalls: [{ id: 't1', name: 'x', input: {} }], inputTokens: 0, outputTokens: 0 },
          { text: '끝', toolCalls: [], inputTokens: 0, outputTokens: 0 },
        ]),
        () => {},
        async () => 'r',
        8,
        () => { throw new Error('ui boom'); },
      );
      expect(r.text).toBe('끝');
      expect(r.hitLimit).toBe(false);
    });
  });
});
