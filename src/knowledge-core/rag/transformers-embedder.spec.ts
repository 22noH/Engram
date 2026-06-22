import { TransformersEmbedder } from './transformers-embedder';

// 통합테스트 실행(PowerShell): $env:NODE_OPTIONS='--experimental-vm-modules'; $env:ENGRAM_RAG_INTEGRATION='1'; npx jest src/knowledge-core/rag/transformers-embedder.spec.ts; $env:NODE_OPTIONS=$null; $env:ENGRAM_RAG_INTEGRATION=$null

// 실제 모델 다운로드가 필요해 기본 skip. 수동/CI에서 ENGRAM_RAG_INTEGRATION=1로 켠다.
const run = process.env.ENGRAM_RAG_INTEGRATION === '1' ? describe : describe.skip;

run('TransformersEmbedder (integration)', () => {
  const embedder = new TransformersEmbedder();

  it('차원 1024의 정규화된 벡터를 낸다', async () => {
    const [v] = await embedder.embed(['하이브리드 검색']);
    expect(v).toHaveLength(embedder.dimensions);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 2);
  }, 120_000);

  it('한국어와 영어가 의미적으로 가깝다', async () => {
    const [ko, en, off] = await embedder.embed(['고양이', 'cat', '주식 시장 금리']);
    const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
    expect(dot(ko, en)).toBeGreaterThan(dot(ko, off));
  }, 120_000);
});
