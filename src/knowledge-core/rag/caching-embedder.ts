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
    // 캐시 적중은 그대로 채우고, 미스는 중복 제거해 unique만 한 번씩 위임한다(배치 내 중복 재임베딩 방지).
    const result: (number[] | undefined)[] = texts.map((t) => this.cache.get(t));
    const uniqueMisses: string[] = [];
    const seen = new Set<string>();
    result.forEach((v, i) => {
      if (v === undefined && !seen.has(texts[i])) {
        seen.add(texts[i]);
        uniqueMisses.push(texts[i]);
      }
    });
    if (uniqueMisses.length > 0) {
      const embedded = await this.inner.embed(uniqueMisses);
      // embedded 배열에서 직접 매핑한다(작은 max로 축출돼도 안전 — 캐시 재조회 금지).
      const byText = new Map<string, number[]>();
      uniqueMisses.forEach((t, j) => {
        byText.set(t, embedded[j]);
        this.cache.set(t, embedded[j]);
      });
      result.forEach((v, i) => {
        if (v === undefined) result[i] = byText.get(texts[i])!;
      });
    }
    return result as number[][];
  }
}
