// 교체 가능한 두뇌 포트(설계 §7.5). Phase 1 어댑터 = ClaudeCliBrain 1개.
export interface BrainResult {
  text: string; // 최종 답 본문
  costUsd: number; // 호출 비용(없으면 0)
  isError: boolean; // CLI 오류/타임아웃 여부
  raw?: unknown; // 원본 응답(디버깅용)
}

// Phase 4: 호출별 옵션(코딩 에이전트가 타깃 디렉터리·도구 플래그 지정에 사용).
export interface CompleteOpts {
  cwd?: string;          // 코딩 시 타깃 작업 디렉터리
  extraArgs?: string[];  // 도구 플래그 등 추가 인수
  timeoutMs?: number;    // 호출별 타임아웃(코딩은 길다)
}

export interface BrainProvider {
  // onChunk: 텍스트 조각이 생성될 때마다 호출(스트리밍). 생략 시 블로킹 수집.
  // opts: 코딩 에이전트 등 호출별 옵션(옵셔널, 하위호환).
  complete(prompt: string, onChunk?: (text: string) => void, opts?: CompleteOpts): Promise<BrainResult>;
}

export const BRAIN = Symbol('BRAIN'); // DI 토큰
export const JUDGE_BRAIN = Symbol('JUDGE_BRAIN'); // judge 전용 두뇌 DI 토큰(작성자≠검증자)
