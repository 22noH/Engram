// 앞단 중립 메신저 포트(설계 §9 / Phase 6a). 어댑터(Discord 등)가 구현하고,
// 코어는 채널 ID·답신 핸들 등 메신저 특유의 것을 모른다(CoreMessage 중립성 연장).

import type { Action } from '../../../shared/protocol';

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
}

export interface MessengerPort {
  onMention(handler: (e: MentionEvent) => Promise<void>): void;
  // 관찰(6c-1): 멘션이 아닌 일반 메시지 수신 — 옵셔널(어댑터가 지원할 때만). 정책 필터는 bridge 몫.
  onMessage?(handler: (e: MentionEvent) => Promise<void>): void;
  reply(target: ReplyTarget, text: string, actions?: Action[]): Promise<void>;
  postToChannel(channelId: string, text: string, threadId?: string): Promise<void>;
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
