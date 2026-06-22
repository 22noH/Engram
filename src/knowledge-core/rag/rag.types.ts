// RagStore와 소비자(WikiEngine, 워처) 사이의 공유 계약.
// WikiPage 전체에 의존하지 않도록 색인에 필요한 필드만 추린 평탄 타입을 쓴다(결합 약화).

export interface IndexablePage {
  slug: string;
  title: string;
  category: string;
  sources: string[];
  body: string;
}

export interface SearchResult {
  slug: string;
  title: string;
  text: string; // 매칭된 청크 본문
  score: number; // RRF 융합 점수
}

// WikiEngine → RagStore 단방향 결합을 약화시키는 포트.
// WikiEngine은 이 토큰을 @Optional로 주입받아, 없으면 색인을 건너뛴다(Part 1 호환).
export const PAGE_INDEXER = Symbol('PAGE_INDEXER');

export interface PageIndexer {
  indexPage(page: IndexablePage): Promise<void>;
  removePage(slug: string): Promise<void>;
}
