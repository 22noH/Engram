import { LRUCache } from 'lru-cache';
import { IEmbedder } from './embedder.port';

// 임베딩 캐시 데코레이터(설계 §10.3 "모든 캐시는 lru-cache, 크기 제한"). text→vector를
// 바운드 LRU로 캐싱해 미변경 청크·반복 쿼리의 재임베딩을 피한다. 정확성은 캐시와 무관.
export class CachingEmbedder implements IEmbedder {
  private readonly cache: LRUCache<string, number[]>;

  // ponytail: max는 메모리 바운드 knob(초과 시 LRU 축출, 정확성 무관). 기본 4096 청크
  //           (1024d×4byte ≈ 4KB/개 → 약 16MB). 적중률 낮으면 키우고, 메모리 빡빡하면 줄임.
  constructor(
    private readonly inner: IEmbedder,
    max = 4096,
  ) {
    this.cache = new LRUCache<string, number[]>({ max });
  }

  get dimensions(): number {
    return this.inner.dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    // 캐시 미스만 모아 한 번에 위임(배치 유지) 후 원래 순서로 재조립한다.
    const result: (number[] | undefined)[] = texts.map((t) => this.cache.get(t));
    const missIdx: number[] = [];
    const missTexts: string[] = [];
    result.forEach((v, i) => {
      if (v === undefined) {
        missIdx.push(i);
        missTexts.push(texts[i]);
      }
    });
    if (missTexts.length > 0) {
      const embedded = await this.inner.embed(missTexts);
      embedded.forEach((vec, j) => {
        this.cache.set(texts[missIdx[j]], vec);
        result[missIdx[j]] = vec;
      });
    }
    return result as number[][];
  }
}
