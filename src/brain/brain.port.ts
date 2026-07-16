// 교체 가능한 두뇌 포트(설계 §7.5). Phase 1 어댑터 = ClaudeCliBrain 1개.
export interface BrainResult {
  text: string; // 최종 답 본문
  costUsd: number; // 호출 비용(없으면 0)
  isError: boolean; // CLI 오류/타임아웃 여부
  raw?: unknown; // 원본 응답(디버깅용)
}

// Phase 8d: 지휘자가 다른 두뇌를 부르는 위임 핸들(agent-layer가 만들어 주입 — src/brain은 함수만 부름).
export interface DelegateHandle {
  brains: string[];                                    // 위임 가능한 두뇌 이름들(brains.json 등록 전부)
  run(brain: string, task: string): Promise<string>;   // never-throw — 실패·미지 두뇌는 에러 텍스트
}

// Phase 4: 호출별 옵션(코딩 에이전트가 타깃 디렉터리·도구 플래그 지정에 사용).
export interface CompleteOpts {
  cwd?: string;          // 코딩 시 타깃 작업 디렉터리
  extraArgs?: string[];  // 도구 플래그 등 추가 인수
  timeoutMs?: number;    // 호출별 타임아웃(코딩은 길다)
  delegate?: DelegateHandle;   // Phase 8d: 있으면 엔그램 하네스가 ask_brain 도구를 노출
}

export interface BrainProvider {
  // onChunk: 텍스트 조각이 생성될 때마다 호출(스트리밍). 생략 시 블로킹 수집.
  // opts: 코딩 에이전트 등 호출별 옵션(옵셔널, 하위호환).
  complete(prompt: string, onChunk?: (text: string) => void, opts?: CompleteOpts): Promise<BrainResult>;
  // Phase 8d: 이 두뇌가 지휘자(ask_brain 위임)를 지원하는가. 엔그램 자체 하네스(anthropic-api·openai-api)만 true.
  // CLI 두뇌는 우리 도구 루프를 안 타므로 미지원(undefined=false). ReaderAgent가 지휘자 활성 여부를 이걸로 가른다.
  readonly canDelegate?: boolean;
}

export const BRAIN = Symbol('BRAIN'); // DI 토큰
export const JUDGE_BRAIN = Symbol('JUDGE_BRAIN'); // judge 전용 두뇌 DI 토큰(작성자≠검증자)
