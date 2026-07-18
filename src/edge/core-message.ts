// 앞단 중립 메시지(설계 §9.1). Gateway 어댑터가 프론트엔드 입력을 이 타입으로 번역한다.
// 코어(Orchestrator/ReaderAgent)는 채널 ID·버튼 등 프론트 특유의 것을 모른다.
export interface CoreMessage {
  text: string; // 사용자 질문
  userId: string; // 멀티유저 네임스페이스(기본 DEFAULT_USER)
  mode?: 'chat' | 'code'; // Phase 10: Code 채널이면 classify 건너뛰고 코딩으로.
  repoPath?: string;      // Phase 10: Code 채널이 바인딩한 레포 절대경로.
  brain?: string;         // 채널별 두뇌 이름(설계 §3.2): 미설정=기존 주입 BRAIN(회귀 0).
}
