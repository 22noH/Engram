// ws 프레임 계약 — 두뇌(src/edge/messenger)와 renderer/의 단일 진실원.
// 인터페이스만(런타임 값 0) → 양쪽에서 `import type`로 참조, 컴파일 시 erase.
// 현행 프레임을 명문화만 한다(신규 프레임 없음). Phase 11b에서 Message.actions 추가 예정.

import type { BrowserOp } from './browser-ops';

export interface Action {
  label: string;
  send: string;
  confirm?: string;
}

// 노력(effort) 수준 — claude CLI의 `--effort <level>` 허용값과 1:1. 계층 중립인 여기 한 곳에만 두고
// 두뇌 계층(src/brain/brain.port.ts)이 재수출해 쓴다(값이 갈라지지 않게). 이 파일은 런타임 값 0을
// 지키므로(위 주석) 검증용 배열은 여기 두지 않는다 — chat-store.ts의 EFFORT_LEVELS가 그 역할.
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// 권한 모드(코드 채널별) — "어디까지 알아서 할지". EffortLevel과 같은 결로 계층 중립인 여기 한 곳에만
// 두고(런타임 값 0 원칙 유지) 검증용 배열은 chat-store.ts의 PERM_MODES가 갖는다.
//  - plan       계획만: 읽고 분석만. 파일 수정·명령 실행 없음
//  - files      파일만: 파일 수정은 하되 명령은 실행 안 함
//  - restricted 제한: 승인된 명령 목록만 실행(permissions.json allow.commands / 내장 기본목록)
//  - auto       자동: 아무 명령이나 실행(현재 기본값)
//  - bypass     권한 무시: 파일 쓰기 울타리까지 해제(폴더 밖 수정 허용) — 위험
// 하드 백스톱(Engram 자기 저장소·시스템 폴더·denyPaths)은 bypass에서도 절대 안 풀린다.
export type PermMode = 'plan' | 'files' | 'restricted' | 'auto' | 'bypass';

export interface Channel {
  id: string;
  name: string;
  respondMode: 'all' | 'mention';
  mode?: 'chat' | 'code' | 'team'; // 누락/오염=chat
  repoPath?: string;      // Code 채널이 바인딩한 레포 절대경로
  creatorId?: string;     // Phase 16b: 만든 사람(소유권 예외)
  visibility?: 'public' | 'private'; // Phase 16c: 비공개 = 초대된 사람만
  memberIds?: string[];   // Phase 16c: 비공개 채널 입장 허용 계정 id
  brain?: string;         // Task 3: 채널이 쓰는 두뇌 이름. 미설정=기본 두뇌.
  // 노력(effort): 이 채널이 쓸 추론 노력 수준. 코드 채널만 사용자가 고를 수 있고(미설정=high),
  // Chat·Team 채널은 서버가 항상 high로 고정하므로 값이 있어도 무시된다.
  effort?: EffortLevel;
  // 권한 모드(permMode): 이 채널이 쓸 권한 모드. 코드 채널만 사용자가 고를 수 있고(미설정=전역 설정
  // permissions.json allow.commandMode 폴백), Chat·Team 채널은 값이 있어도 무시된다.
  permMode?: PermMode;
}

export interface Message {
  id: string;
  authorId: string; // 'engram' | 계정 id | 'owner'(무인증 모드)
  authorName?: string; // 작성 시점 표시이름(서버 스탬프) — 렌더용
  text: string;
  ts: string;
  threadId?: string;
  actions?: Action[];
  question?: { questions: QuestionItem[] }; // 질문 카드(두뇌 게시)
  answersId?: string;                        // 이 메시지가 답하는 카드 메시지 id
  attachments?: AttachmentMeta[];            // 채팅 첨부(이미지/파일) — 메시지와 운명 공유
  toolsUsed?: string[];                      // 두뇌 활동 표시(Task 1): 이 응답 생성 중 쓴 도구 이름들(순서대로, 원시 이름). 비어있으면 필드 자체 생략.
  // 진행 중 표시: 다단계 작업(코딩 루프·협업)이 올리는 "중간 보고" 메시지 표식. 서버가 게시 지점에서
  // 직접 스탬프한다(orchestrator의 onProgress 경로 — PostFn 5번째 인자). 렌더러는 이 필드로만 진행
  // 메시지를 식별한다: 텍스트 패턴("…중" 등) 매칭은 i18n에서 깨지고 오탐하므로 금지.
  // 미첨부=필드 자체 없음(기존 메시지와 완전히 동일 렌더 — 회귀 0).
  progress?: boolean;
  // 진행 카드(2026-07-25): 이 진행 보고가 "어느 실행"에 속하고 "어떤 성격의 단계"인지. 렌더러는
  // 이 표식만으로 연속된 진행 보고를 카드 하나로 묶는다 — 기록(jsonl)에 그대로 남으므로 앱을 껐다
  // 켜도 같은 묶음이 복원된다(휘발 상태 금지). run이 다르면 절대 섞이지 않는다(동시 실행 대비).
  // 이 필드가 없는 옛 진행 메시지는 카드로 묶지 않고 예전 그대로 한 줄씩 렌더한다(회귀 0).
  progressRun?: ProgressRun;
  // 완료 보고서(2026-07-25): 자율 코딩이 끝나고 두뇌가 쓴 구조화 보고 메시지 표식. 렌더러가 본문
  // 아래에 [변경점 보기]·[PR 생성] 줄을 붙인다(둘 다 앱 기능 호출이라 actions로는 못 싣는다).
  completionReport?: boolean;
}

// 진행 카드 표식. id=한 실행(카드 하나), title=카드 제목(작업명), kind=이 단계의 성격
// (미지정=보통 단계, retry=실패 후 재시도, fail=이번 시도 실패). 텍스트 패턴 매칭 금지의 연장선 —
// 마커(↻·✗)는 producer가 말해주는 이 값으로만 정한다.
export interface ProgressRun { id: string; title: string; kind?: 'retry' | 'fail' }

// 채팅 첨부 메타(Task 1). 실파일은 dataDir/attachments/<channelId>/<id>. 사용자 파일명은
// 메타로만 보존(경로엔 서버 발급 uuid만 — traversal 원천 차단).
export interface AttachmentMeta { id: string; name: string; mime: string; size: number }

export interface QuestionOption { label: string; desc?: string; recommended?: boolean }
export interface QuestionItem { q: string; header?: string; multiSelect?: boolean; options: QuestionOption[] }

export interface UserDto { id: string; displayName: string; role: 'owner' | 'member'; permissions?: string[] }
export interface AdminUserDto extends UserDto { loginId: string; status: 'pending' | 'active' | 'suspended'; createdAt: string; sso: boolean; permissions: string[] }
export interface AdminSettings { serverName?: string; oidc?: { issuer: string; clientId: string; clientSecret: string } }

export interface RosterEntry { id: string; displayName: string } // Phase 16c: 채널 멤버 관리용 — id+표시이름만(민감정보 없음)

export interface WikiPageMeta { slug: string; title: string; category: string; status: 'draft' | 'published'; updated: string }
export interface WikiPageDto extends WikiPageMeta { body: string }
export interface WikiSearchHit { slug: string; title: string; snippet: string; score: number }
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
  | { t: 'send'; channelId: string; text: string; threadId?: string; answersId?: string; attachments?: string[] }
  | { t: 'createChannel'; name: string; mode?: 'chat' | 'code' | 'team'; visibility?: 'public' | 'private' }
  | { t: 'deleteChannel'; id: string }
  | { t: 'setRepoPath'; id: string; repoPath: string }
  | { t: 'setRespondMode'; id: string; mode: 'all' | 'mention' }
  | { t: 'setChannelBrain'; id: string; brain: string | null }
  // 노력(effort): 이 채널의 노력 수준을 바꾼다(null=해제→서버 기본 high). setChannelBrain과 같은
  // 권한 게이트·같은 필드 이름 관례(id). 코드 채널에서만 의미가 있다.
  | { t: 'setChannelEffort'; id: string; effort: EffortLevel | null }
  // 권한 모드(permMode): 이 채널의 권한 모드를 바꾼다(null=해제→전역 설정 폴백). setChannelEffort와
  // 같은 권한 게이트(canAdminChannel)·같은 필드 이름 관례(id). 코드 채널에서만 의미가 있다.
  | { t: 'setChannelPermMode'; id: string; permMode: PermMode | null }
  | { t: 'clearHistory'; id: string }
  | { t: 'undoClear'; id: string }
  | { t: 'dropClearBackup'; id: string }
  | { t: 'compact'; id: string }
  | { t: 'wikiList' }
  | { t: 'wikiGet'; slug: string }
  | { t: 'wikiSearch'; query: string }
  | { t: 'wikiUnpublish'; slug: string }
  | { t: 'wikiEdit'; slug: string; body: string }
  | { t: 'wikiDelete'; slug: string }
  | { t: 'proposalsList' }
  | { t: 'proposalApprove'; id: string }
  | { t: 'proposalReject'; id: string }
  | { t: 'adminUsers' }
  | { t: 'adminApprove'; id: string }
  | { t: 'adminSuspend'; id: string }
  | { t: 'adminRestore'; id: string }
  | { t: 'adminResetPassword'; id: string; password: string }
  | { t: 'adminForceLogout'; id: string }
  | { t: 'adminGetSettings' }
  | { t: 'adminSetSettings'; settings: AdminSettings }
  | { t: 'adminSetPermissions'; id: string; permissions: string[] }
  | { t: 'setChannelVisibility'; id: string; visibility: 'public' | 'private' }
  | { t: 'setChannelMembers'; id: string; memberIds: string[] }
  | { t: 'channelRoster' }
  // Task 4(여러 줄 입력+생성 중지): 이 채널의 진행 중인 두뇌 턴을 중단. 무턴이면 서버가 조용히 무시.
  | { t: 'stopGeneration'; channelId: string }
  // AI 웹 조작(2단계): browserOp의 짝. 화면(독 브라우저 칸)이 조작을 끝내고 결과를 돌려준다.
  // opId로만 짝을 맞춘다 — 모르는/늦은 id는 서버가 조용히 버린다.
  | { t: 'browserResult'; opId: string; ok: boolean; text: string };

// 서버 → 클라
export type ServerFrame =
  // defaultPermMode: 채널에 permMode가 없을 때 실제로 적용되는 전역 기본 권한 모드(permissions.json
  // allow.commandMode를 권한 모드 어휘로 옮긴 것 — auto→auto, allowlist→restricted, off→files).
  // defaultBrain과 같은 결로 "미설정 채널이 실제로 뭘로 도는지"를 배지가 정확히 쓰게 하기 위한 값.
  // 미주입(구식 배선·brain 모드·테스트) 시 필드 자체가 없다 → 클라는 기존대로 'auto'로 표시(회귀 0).
  | { t: 'channels'; list: Channel[]; brainNames: string[]; defaultBrain: string; defaultPermMode?: PermMode }
  | { t: 'history'; channelId: string; messages: Message[] }
  | { t: 'msg'; channelId: string; message: Message }
  | { t: 'historyCleared'; channelId: string }
  | { t: 'historyRestored'; channelId: string }
  | { t: 'compacted'; channelId: string; slug: string }
  | { t: 'authOk'; user: UserDto }
  | { t: 'authErr' }
  | { t: 'error'; text: string }
  | { t: 'wikiPages'; list: WikiPageMeta[] }
  | { t: 'wikiPage'; page: WikiPageDto }
  | { t: 'wikiResults'; query: string; list: WikiSearchHit[] }
  | { t: 'proposals'; list: ProposalDto[] }
  | { t: 'wikiChanged' }
  | { t: 'proposalsChanged' }
  | { t: 'adminUsers'; list: AdminUserDto[] }
  | { t: 'adminSettings'; settings: AdminSettings }
  | { t: 'roster'; list: RosterEntry[] }
  // 두뇌 활동 표시(Task 1): 대기 중 실시간 진행 라벨 — 휘발성(저장 안 함, 브로드캐스트만).
  | { t: 'activity'; channelId: string; label: string }
  // 답변 실시간 스트리밍: 생성 중인 답의 "증분" 텍스트 — activity와 똑같이 휘발성(저장 안 함,
  // 브로드캐스트만). 누적 전체가 아니라 증분이라 렌더러가 이어붙인다. 최종 확정은 항상 'msg' 프레임이고
  // 렌더러는 그 시점에 누적 버퍼를 버린다(중복 표시 금지). 서버가 짧은 간격으로 코얼레싱해서 보낸다.
  | { t: 'delta'; channelId: string; text: string }
  // AI 웹 조작(2단계): 두뇌가 요청한 브라우저 조작 1건. 그 채널을 보고 있는 데스크톱 클라이언트가
  // <webview>에서 수행하고 browserResult로 답한다(안전 확인·차단 판정은 전부 클라 쪽 — 화면과
  // 사용자 설정이 거기 있다). webview가 없는 클라(폰 브라우저)는 그대로 무시한다.
  | { t: 'browserOp'; channelId: string; opId: string; op: BrowserOp };
