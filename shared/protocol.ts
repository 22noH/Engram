// ws 프레임 계약 — 두뇌(src/edge/messenger)와 renderer/의 단일 진실원.
// 인터페이스만(런타임 값 0) → 양쪽에서 `import type`로 참조, 컴파일 시 erase.
// 현행 프레임을 명문화만 한다(신규 프레임 없음). Phase 11b에서 Message.actions 추가 예정.

export interface Action {
  label: string;
  send: string;
  confirm?: string;
}

export interface Channel {
  id: string;
  name: string;
  respondMode: 'all' | 'mention';
  mode?: 'chat' | 'code' | 'team'; // 누락/오염=chat
  repoPath?: string;      // Code 채널이 바인딩한 레포 절대경로
}

export interface Message {
  id: string;
  authorId: string; // 'engram' | 'owner' | ...
  text: string;
  ts: string;
  threadId?: string;
  actions?: Action[];
}

export interface WikiPageMeta { slug: string; title: string; category: string; status: 'draft' | 'published'; updated: string }
export interface WikiPageDto extends WikiPageMeta { body: string }
export interface ProposalDto {
  id: string;
  op: 'create' | 'append' | 'supersede';
  targetSlug: string;
  title: string;
  category: string;
  payload: string;
  sources: string[];
  importance: number;
  confidence: number;
  reason: string;
  conflictSlugs?: string[];
}

// 클라 → 서버
export type ClientFrame =
  | { t: 'auth'; token: string }
  | { t: 'channels' }
  | { t: 'history'; channelId: string; before?: string }
  | { t: 'send'; channelId: string; text: string; threadId?: string; authorId?: string }
  | { t: 'createChannel'; name: string; mode?: 'chat' | 'code' | 'team' }
  | { t: 'deleteChannel'; id: string }
  | { t: 'setRepoPath'; id: string; repoPath: string }
  | { t: 'setRespondMode'; id: string; mode: 'all' | 'mention' }
  | { t: 'wikiList' }
  | { t: 'wikiGet'; slug: string }
  | { t: 'proposalsList' }
  | { t: 'proposalApprove'; id: string }
  | { t: 'proposalReject'; id: string };

// 서버 → 클라
export type ServerFrame =
  | { t: 'channels'; list: Channel[] }
  | { t: 'history'; channelId: string; messages: Message[] }
  | { t: 'msg'; channelId: string; message: Message }
  | { t: 'authErr' }
  | { t: 'error'; text: string }
  | { t: 'wikiPages'; list: WikiPageMeta[] }
  | { t: 'wikiPage'; page: WikiPageDto }
  | { t: 'proposals'; list: ProposalDto[] }
  | { t: 'wikiChanged' }
  | { t: 'proposalsChanged' };
