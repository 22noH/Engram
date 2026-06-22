import { Injectable } from '@nestjs/common';
import { IEmbedder } from './embedder.port';

// CommonJS에서 ESM 패키지를 안전하게 가져오기 위한 간접 import(컴파일러가 require로 바꾸지 못하게).
const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;

// 로컬 다국어 임베더(설계 §5.2). 기본 bge-m3(1024차원), 환경변수로 교체 가능.
// 첫 호출 시 모델을 1회 다운로드·캐시한다.
@Injectable()
export class TransformersEmbedder implements IEmbedder {
  readonly dimensions = 1024; // bge-m3 / multilingual-e5-large 공통
  private readonly modelId = process.env.ENGRAM_EMBED_MODEL ?? 'Xenova/bge-m3';
  private extractor: ((texts: string[], opts: object) => Promise<{ tolist(): number[][] }>) | null =
    null;

  private async pipe(): Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>> {
    if (!this.extractor) {
      const { pipeline } = await dynamicImport('@huggingface/transformers');
      this.extractor = await pipeline('feature-extraction', this.modelId);
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.extractor!;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const extractor = await this.pipe();
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    return output.tolist();
  }
}
