// 위키 페이지 모델(설계 §5.1 — 버전관리형 WikiEngine).
// frontmatter에 출처(sources)와 상태(status)를 담아 C 자율쓰기의
// 검증·승인 흐름(§6)의 토대로 삼는다.

export type PageStatus = 'draft' | 'published';

export interface PageFrontmatter {
  title: string;
  category: string;
  status: PageStatus;
  sources: string[]; // 출처 포인터(대화/문서/URL). C 경로에선 비어 있으면 거부 대상.
  created: string; // ISO 8601
  updated: string; // ISO 8601
}

export interface WikiPage {
  slug: string; // 고유 식별자 = 파일명(확장자 제외)
  frontmatter: PageFrontmatter;
  body: string; // 마크다운 본문
}

export interface CreatePageInput {
  slug: string;
  title: string;
  category: string;
  body: string;
  sources?: string[];
  status?: PageStatus; // 기본 'draft'
}

export interface UpdatePageInput {
  title?: string;
  category?: string;
  body?: string;
  sources?: string[];
}
