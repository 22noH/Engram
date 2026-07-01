// 앞단 중립 메신저 포트(설계 §9 / Phase 6a). 어댑터(Discord 등)가 구현하고,
// 코어는 채널 ID·답신 핸들 등 메신저 특유의 것을 모른다(CoreMessage 중립성 연장).

// 답신 경로 — 어댑터별 불투명 핸들. 코어를 통과하지 않고 어댑터↔bridge만 주고받는다.
export type ReplyTarget = unknown;

export interface MentionEvent {
  text: string;        // @Engram 멘션 토큰을 떼어낸 본문
  channelId: string;   // 방 식별자(맥락 네임스페이스로 쓰임)
  threadId?: string;   // 스레드(있으면)
  authorId: string;    // 보낸 사람
  target: ReplyTarget; // reply가 되돌려줄 핸들
}

export interface MessengerPort {
  onMention(handler: (e: MentionEvent) => Promise<void>): void;
  reply(target: ReplyTarget, text: string): Promise<void>;
  postToChannel(channelId: string, text: string, threadId?: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface MessengerConfig {
  provider?: string;   // 'discord' 등. 없으면 메신저 비활성.
  token?: string;      // 봇 토큰(env 우선).
  engramName?: string; // 표시 이름(기본 'Engram').
}
