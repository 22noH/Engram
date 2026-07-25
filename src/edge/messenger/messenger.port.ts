// 앞단 중립 메신저 포트(설계 §9 / Phase 6a). 어댑터(Discord 등)가 구현하고,
// 코어는 채널 ID·답신 핸들 등 메신저 특유의 것을 모른다(CoreMessage 중립성 연장).

import type { Action, AttachmentMeta, Message, EffortLevel, PermMode } from '../../../shared/protocol';

// 답신 경로 — 어댑터별 불투명 핸들. 코어를 통과하지 않고 어댑터↔bridge만 주고받는다.
export type ReplyTarget = unknown;

export interface MentionEvent {
  text: string;        // @Engram 멘션 토큰을 떼어낸 본문
  channelId: string;   // 방 식별자(맥락 네임스페이스로 쓰임)
  threadId?: string;   // 스레드(있으면)
  authorId: string;    // 보낸 사람
  target: ReplyTarget; // reply가 되돌려줄 핸들
  mode?: 'chat' | 'code'; // Phase 10: 어댑터가 채널 모드를 실어줌(Discord는 미설정=chat).
  repoPath?: string;      // Phase 10: Code 채널 바인딩 경로.
  brain?: string;         // 채널별 두뇌(스펙 §3.2): 어댑터가 채널의 brain 이름을 실어줌. 미첨부=기본(Discord는 비범위).
  // 노력(effort): brain과 같은 결 — 어댑터가 채널에 저장된 값을 실어준다(미설정 채널=미첨부, 회귀 0).
  // "이 턴에 실제로 쓸 값"은 여기가 아니라 orchestrator.resolveTurnEffort가 정한다(코드 채널만 저장값 사용).
  effort?: EffortLevel;
  // 권한 모드(permMode): effort와 같은 결 — 어댑터가 채널에 저장된 값을 실어준다(미설정 채널=미첨부,
  // 회귀 0). "이 턴에 실제로 쓸 값"은 orchestrator.resolveTurnPermMode가 정한다(코드 채널만 저장값 사용,
  // 미설정이면 undefined로 남아 PermissionFence가 전역 설정으로 폴백).
  permMode?: PermMode;
  // 최종 리뷰 픽스(ask-user 답↔질문 상관관계): answersId 답장의 재트리거일 때, 어댑터가 원본 카드의
  // 질문(questionFallbackText 렌더링)을 실어준다. 카드가 없거나(펜스텍스트 경로처럼 대화이력에서
  // 자연히 보임) 일반 send면 미첨부 — 기존 이벤트와 바이트 동일(회귀 0).
  answeredQuestion?: string;
  // Task 3(chat-attachments): onSend이 실재 id만(위조 무시) 해석해 실어주는 첨부 메타+서버-로컬
  // 절대경로. 미첨부 send=기존과 바이트 동일(회귀 0). path는 두뇌 하네스가 vision/텍스트 읽기용으로만
  // 쓴다 — 렌더러/클라에는 이 이벤트가 노출되지 않는다(edge 내부 전용).
  attachments?: Array<AttachmentMeta & { path: string }>;
}

export interface MessengerPort {
  onMention(handler: (e: MentionEvent) => Promise<void>): void;
  // 관찰(6c-1): 멘션이 아닌 일반 메시지 수신 — 옵셔널(어댑터가 지원할 때만). 정책 필터는 bridge 몫.
  onMessage?(handler: (e: MentionEvent) => Promise<void>): void;
  // Task 2(ask-user): question은 additive 옵션 4번째 인자 — 3인자 구현체(다른 어댑터)는 구조적 호환 유지.
  // Task 1(brain-activity): toolsUsed는 additive 5번째 인자 — 4인자 이하 구현체도 구조적 호환 유지.
  // 진행 중 표시: progress는 additive 6번째 인자(다단계 작업의 중간 보고 표식) — 같은 이유로 무영향.
  reply(target: ReplyTarget, text: string, actions?: Action[], question?: Message['question'], toolsUsed?: string[], progress?: boolean): Promise<void>;
  postToChannel(channelId: string, text: string, threadId?: string): Promise<void>;
  // Task 1(brain-activity): 옵셔널 — 실시간 활동 라벨(예: "웹 검색 중 · web_search")을 그 채널에만
  // 브로드캐스트. 저장 안 함(휘발) — 미구현 어댑터(Discord 등)는 구조적으로 no-op(회귀 0).
  activity?(channelId: string, label: string): void;
  // 답변 실시간 스트리밍: 옵셔널 — 생성 중인 답의 증분 텍스트를 그 채널에만 브로드캐스트. activity와
  // 동일하게 저장 안 함(휘발) — 미구현 어댑터(Discord 등)는 구조적으로 no-op(회귀 0). 코얼레싱은
  // 호출부(messenger-bridge)가 하므로 어댑터는 받은 조각을 그대로 프레임 1개로 내보내면 된다.
  delta?(channelId: string, text: string): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface MessengerConfig {
  provider?: string;   // 'discord' 등. 없으면 메신저 비활성.
  token?: string;      // 봇 토큰(env 우선).
  engramName?: string; // 표시 이름(기본 'Engram').
}

// 게시만 필요한 소비자(예약·ambient)용 좁은 포트 — Hub가 이것만 구현.
export type ChannelPoster = Pick<MessengerPort, 'postToChannel'>;
