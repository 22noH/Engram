import { FakeEmbedder } from './fake-embedder';

describe('FakeEmbedder', () => {
  const embedder = new FakeEmbedder();

  it('같은 텍스트는 같은 벡터를 낸다(결정론적)', async () => {
    const [a] = await embedder.embed(['엔그램']);
    const [b] = await embedder.embed(['엔그램']);
    expect(a).toEqual(b);
  });

  it('다른 텍스트는 다른 벡터를 낸다', async () => {
    const [a] = await embedder.embed(['엔그램']);
    const [b] = await embedder.embed(['위키']);
    expect(a).not.toEqual(b);
  });

  it('차원이 dimensions와 일치하고 L2 정규화된다', async () => {
    const [v] = await embedder.embed(['hello world']);
    expect(v).toHaveLength(embedder.dimensions);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});
