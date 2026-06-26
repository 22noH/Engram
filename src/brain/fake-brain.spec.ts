import { FakeBrain } from './fake-brain';

describe('FakeBrain', () => {
  it('주입한 결과를 반환한다', async () => {
    const brain = new FakeBrain({ text: '답', costUsd: 0, isError: false });
    const r = await brain.complete('질문');
    expect(r.text).toBe('답');
    expect(r.isError).toBe(false);
  });

  it('onChunk가 있으면 텍스트를 흘려보낸다', async () => {
    const brain = new FakeBrain({ text: 'hello', costUsd: 0, isError: false });
    const chunks: string[] = [];
    await brain.complete('q', (t) => chunks.push(t));
    expect(chunks.join('')).toBe('hello');
  });

  it('기본 결과는 isError=false', async () => {
    const r = await new FakeBrain().complete('q');
    expect(r.isError).toBe(false);
  });
});
