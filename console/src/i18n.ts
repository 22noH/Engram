// 콘솔 언어 판정: renderer/src/config.ts와 같은 결 — ?lang= 우선, 없으면 navigator 폴백.
const langParam = new URLSearchParams(window.location.search).get('lang');
export const LANG = (langParam && langParam.trim()) || navigator.language.slice(0, 2).toLowerCase();
export const ko = LANG === 'ko';

export const T = {
  wordmark: 'ENGRAM SERVER',
  // ── 셋업 ──
  setupTitle: ko ? '서버 만들기' : 'Create server',
  setupSub: ko
    ? '설치할 때 터미널에 출력된 셋업 코드를 입력하세요. 이 서버의 소유자 계정을 만듭니다.'
    : 'Enter the setup code printed in your terminal during install. This creates the owner account for this server.',
  codeLabel: ko ? '셋업 코드' : 'Setup code',
  loginIdLabel: ko ? '아이디' : 'ID',
  passwordLabel: ko ? '비밀번호' : 'Password',
  setupSubmit: ko ? '서버 만들기' : 'Create server',
  // ── 로그인 ──
  signInTitle: ko ? 'Engram 로그인' : 'Sign in to Engram',
  loginSubmit: ko ? '로그인' : 'Sign in',
  // ── 에러 ──
  errInvalid: ko ? '아이디 또는 비밀번호가 올바르지 않아요' : 'Incorrect ID or password',
  errPending: ko ? '가입 승인 대기 중이에요' : 'Waiting for approval',
  errSuspended: ko ? '정지된 계정이에요' : 'This account is suspended',
  errSetup: ko ? '셋업 코드가 올바르지 않아요' : 'Invalid setup code',
  errNetwork: ko ? '서버에 연결할 수 없어요' : 'Cannot reach the server',
  // ── 네비 ──
  navOverview: ko ? '개요' : 'Overview',
  navMembers: ko ? '멤버' : 'Members',
  navGroups: ko ? '그룹' : 'Groups',
  navChannels: ko ? '채널' : 'Channels',
  navModels: ko ? '모델' : 'Models',
  navMcp: 'MCP',
  navWiki: ko ? '위키' : 'Wiki',
  navSettings: ko ? '서버 설정' : 'Server settings',
  navDeploy: ko ? '클라이언트 배포' : 'Client deploy',
  navStatus: ko ? '상태·로그' : 'Status & logs',
  comingSoon: ko ? '곧 제공' : 'Coming soon',
  statusOk: ko ? '정상 동작 중' : 'Running normally',
  loggedInAs: (role: string) => (ko ? `${role}로 로그인됨` : `signed in as ${role}`),
  // ── 개요 ──
  overviewTitle: ko ? '개요' : 'Overview',
  overviewSub: ko ? '서버 한눈에 보기.' : 'Your server at a glance.',
  statMembers: ko ? '멤버' : 'Members',
  statChannels: ko ? '채널' : 'Channels',
  statWikiPages: ko ? '위키 페이지' : 'Wiki pages',
  statTodayMessages: ko ? '오늘 대화' : "Today's messages",
  todoHeading: ko ? '처리할 일' : 'To-do',
  pendingMembersRow: (n: number) => (ko ? `가입 대기 ${n}건` : `${n} pending members`),
  pendingProposalsRow: (n: number) => (ko ? `위키 승인 대기 ${n}건` : `${n} pending wiki proposals`),
  goToMembers: ko ? '멤버로 이동' : 'Go to Members',
  goToWiki: ko ? '위키로 이동' : 'Go to Wiki',
  loading: ko ? '불러오는 중…' : 'Loading…',
  cancel: ko ? '취소' : 'Cancel',
  save: ko ? '저장' : 'Save',

  // ── 권한 토큰(permissions.ts PERMISSIONS 5종) — 멤버 권한 편집·그룹 권한 체크박스 공용 ──
  permWikiEdit: ko ? '위키 수정' : 'Edit wiki',
  permWikiApprove: ko ? '위키 승인' : 'Approve wiki',
  permChannelsManage: ko ? '채널 관리' : 'Manage channels',
  permWikiUnpublish: ko ? '위키 비공개 전환' : 'Unpublish wiki',
  permWikiDelete: ko ? '위키 삭제' : 'Delete wiki',

  // ── 멤버 ──
  membersTitle: ko ? '멤버' : 'Members',
  membersSub: ko ? '직접 만들어 주거나, 가입 요청을 승인하세요.' : 'Create accounts directly, or approve join requests.',
  addMemberBtn: ko ? '＋ 멤버 추가' : '+ Add member',
  addMemberHeading: ko ? '멤버 추가' : 'Add member',
  displayNameLabel: ko ? '표시 이름' : 'Display name',
  tempPasswordLabel: ko ? '임시 비밀번호' : 'Temporary password',
  tempPasswordHint: ko ? '첫 로그인 때 본인이 변경' : "They'll change it at first sign-in",
  groupLabel: ko ? '그룹' : 'Group',
  noGroupOption: ko ? '(그룹 없음)' : '(No group)',
  createBtn: ko ? '만들기' : 'Create',
  pendingHeading: (n: number) => (ko ? `가입 대기 ${n}` : `${n} pending`),
  membersHeading: (n: number) => (ko ? `멤버 ${n}` : `${n} members`),
  pendingChip: ko ? '대기' : 'Pending',
  approveBtn: ko ? '승인' : 'Approve',
  rejectBtn: ko ? '거절' : 'Reject',
  meServerOwner: ko ? '나 (서버 소유자)' : 'Me (server owner)',
  activeChip: ko ? '활성' : 'Active',
  suspendedChip: ko ? '정지' : 'Suspended',
  permissionsBtn: ko ? '권한' : 'Permissions',
  resetPasswordBtn: ko ? '비번 리셋' : 'Reset password',
  suspendBtn: ko ? '정지' : 'Suspend',
  restoreBtn: ko ? '복구' : 'Restore',

  // ── 그룹 ──
  groupsTitle: ko ? '그룹' : 'Groups',
  groupsSub: ko
    ? '멤버를 묶어서 권한과 채널 접근을 한 번에 관리해요. 멤버는 여러 그룹에 속할 수 있어요.'
    : 'Group members to manage permissions and channel access together. A member can belong to several groups.',
  addGroupBtn: ko ? '＋ 그룹 만들기' : '+ Create group',
  groupsHeading: (n: number) => (ko ? `그룹 ${n}` : `${n} groups`),
  groupNameLabel: ko ? '그룹 이름' : 'Group name',
  editBtn: ko ? '편집' : 'Edit',
  deleteBtn: ko ? '삭제' : 'Delete',
  editHeading: (name: string) => (ko ? `${name} 편집` : `Edit ${name}`),
  membersLabel: ko ? '멤버' : 'Members',
  addChip: ko ? '＋ 추가' : '+ Add',
  permissionsLabel: ko ? '권한' : 'Permissions',
  channelAccessLabel: ko ? '채널 접근' : 'Channel access',
  addChannelChip: ko ? '＋ 채널 추가' : '+ Add channel',
  groupMemberCount: (n: number) => (ko ? `${n}명` : `${n} members`),
  pickMemberPlaceholder: ko ? '멤버 선택…' : 'Choose a member…',
  pickChannelPlaceholder: ko ? '채널 선택…' : 'Choose a channel…',

  // ── 채널 ──
  channelsTitle: ko ? '채널' : 'Channels',
  channelsSub: ko
    ? '채널별 공개 범위·응답 모델을 관리해요. 대화 내용은 여기서 보지 않아요(감시 방지).'
    : "Manage each channel's visibility and reply model. Conversation content is never shown here (anti-surveillance).",
  publicChip: ko ? '공개' : 'Public',
  privateChip: ko ? '비공개' : 'Private',
  makePrivateBtn: ko ? '비공개 전환' : 'Make private',
  makePublicBtn: ko ? '공개 전환' : 'Make public',
  allMembers: ko ? '멤버 전체' : 'All members',
  channelMemberCount: (n: number) => (ko ? `멤버 ${n}명` : `${n} members`),
  modelLabel: ko ? '모델' : 'Model',
  defaultModel: ko ? '기본' : 'Default',
} as const;
