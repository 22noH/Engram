// 교체 가능한 두뇌 포트(설계 §7.5). Phase 1 어댑터 = ClaudeCliBrain 1개.
export interface BrainResult {
  text: string; // 최종 답 본문
  costUsd: number; // 호출 비용(없으면 0)
  isError: boolean; // CLI 오류/타임아웃 여부
  raw?: unknown; // 원본 응답(디버깅용)
}

export interface BrainProvider {
  // onChunk: 텍스트 조각이 생성될 때마다 호출(스트리밍). 생략 시 블로킹 수집.
  complete(prompt: string, onChunk?: (text: string) => void): Promise<BrainResult>;
}

export const BRAIN = Symbol('BRAIN'); // DI 토큰
