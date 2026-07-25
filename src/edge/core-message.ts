import type { AttachmentMeta } from '../../shared/protocol';
import type { EffortLevel } from '../brain/brain.port';

// 앞단 중립 메시지(설계 §9.1). Gateway 어댑터가 프론트엔드 입력을 이 타입으로 번역한다.
// 코어(Orchestrator/ReaderAgent)는 채널 ID·버튼 등 프론트 특유의 것을 모른다.
export interface CoreMessage {
  text: string; // 사용자 질문
  userId: string; // 멀티유저 네임스페이스(기본 DEFAULT_USER)
  mode?: 'chat' | 'code'; // Phase 10: Code 채널이면 classify 건너뛰고 코딩으로.
  repoPath?: string;      // Phase 10: Code 채널이 바인딩한 레포 절대경로.
  brain?: string;         // 채널별 두뇌 이름(설계 §3.2): 미설정=기존 주입 BRAIN(회귀 0).
  // Task 3(chat-attachments): MentionEvent.attachments 그대로 관통(additive) — ReaderAgent가
  // vision 이미지 블록·텍스트 삽입·경로 마커로 소비한다. 미첨부=기존과 바이트 동일(회귀 0).
  attachments?: Array<AttachmentMeta & { path: string }>;
  // 노력(effort): 어댑터가 실어보낼 땐 "채널에 저장된 값"(미설정 채널이면 없음)이고, orchestrator의
  // resolveTurnEffort를 지난 뒤엔 "이 턴에 실제로 적용할 확정값"이다. 결정은 오직 그 한 지점에서만
  // 한다 — 아래 소비자(ReaderAgent·answerInCode)는 실려온 값을 CompleteOpts로 옮기기만 한다.
  // 미설정(직접 route()를 부르는 CLI 게이트웨이 등)이면 아무 인수도 안 붙는다(회귀 0).
  effort?: EffortLevel;
}
