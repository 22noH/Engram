// 임베딩 어댑터 포트(설계 §7.6). 운영=transformers.js, 테스트=FakeEmbedder.
export const EMBEDDER = Symbol('EMBEDDER');

export interface IEmbedder {
  // 임베딩 벡터 차원. LanceDB 스키마의 vector 필드 크기를 결정한다.
  readonly dimensions: number;
  // 텍스트 배열을 같은 순서의 벡터 배열로 변환한다.
  embed(texts: string[]): Promise<number[][]>;
}
