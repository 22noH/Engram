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
  displayNamePlaceholder: ko ? '이름' : 'Name',
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
  rejectMemberConfirm: (name: string) => (ko
    ? `${name}님의 가입 요청을 거절할까요? 계정이 삭제되며 되돌릴 수 없어요.`
    : `Reject ${name}'s join request? The account will be deleted and this cannot be undone.`),
  tempPasswordRevealHeading: ko ? '임시 비밀번호' : 'Temporary password',
  tempPasswordRevealHint: ko
    ? '복사해서 전달하세요. 창을 닫으면 다시 볼 수 없어요.'
    : "Copy and share it. You won't be able to see it again after closing.",
  closeBtn: ko ? '닫기' : 'Close',

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
  groupLimitedChip: ko ? '그룹 한정' : 'Group-limited',
  makePrivateBtn: ko ? '비공개 전환' : 'Make private',
  allMembers: ko ? '멤버 전체' : 'All members',
  channelMemberCount: (n: number) => (ko ? `멤버 ${n}명` : `${n} members`),
  modelLabel: ko ? '모델' : 'Model',
  defaultModel: ko ? '기본' : 'Default',
  modelBtn: ko ? '모델' : 'Model',
  modelBtnTooltip: ko ? 'S3에서 제공돼요' : 'Coming in S3',
  channelMembersBtn: ko ? '멤버' : 'Members',
  accessBtn: ko ? '접근' : 'Access',
  deleteChannelConfirm: (name: string) => (ko
    ? `# ${name} 채널을 삭제할까요? 되돌릴 수 없어요.`
    : `Delete #${name}? This cannot be undone.`),

  // ── 모델 ──
  modelsTitle: ko ? '모델' : 'Models',
  modelsSub: ko
    ? '데스크톱 설정창의 모델 섹션과 같은 문법 — 웹에서.'
    : "Same grammar as the desktop settings app's model section — on the web.",
  harnessLabel: ko ? '하네스' : 'Harness',
  harnessEngram: ko ? '엔그램 하네스' : 'Engram harness',
  harnessCli: ko ? 'CLI 하네스' : 'CLI harness',
  harnessEmptyHint: ko
    ? '이 하네스에 등록된 모델이 없어요 — 아래에서 추가하세요'
    : 'No models for this harness — add one below',
  defaultModelLabel: ko ? '기본 모델' : 'Default model',
  registeredModelsHeading: ko ? '등록된 모델' : 'Registered models',
  defaultBadge: ko ? '기본' : 'Default',
  apiKeySetLabel: ko ? 'API 키 설정됨' : 'API key set',
  deleteDefaultHint: ko ? '먼저 다른 모델을 기본으로 설정하세요' : 'Set another model as default first',
  addHeading: ko ? '추가' : 'Add',
  localModelLabel: ko ? '로컬 모델' : 'Local model',
  modelNamePlaceholder: ko ? '모델 이름' : 'Model name',
  addBtn: ko ? '추가' : 'Add',
  anthropicApiKeyLabel: ko ? 'Anthropic API 키' : 'Anthropic API key',
  apiKeyPlaceholder: 'sk-ant-…',
  setLabel: ko ? '설정됨' : 'Set',

  // ── MCP ──
  mcpTitle: 'MCP',
  mcpSub: ko ? '서버의 모델이 쓸 수 있는 외부 도구.' : 'External tools the server model can use.',
  registeredServersHeading: ko ? '등록된 서버' : 'Registered servers',
  claudeManagedChip: ko ? 'Claude 관리' : 'Managed by Claude',
  mcpNameLabel: ko ? '이름' : 'Name',
  mcpCommandOrUrlLabel: ko ? '명령 또는 URL' : 'Command or URL',
  mcpCommandOrUrlPlaceholder: ko ? 'npx -y … 또는 https://…' : 'npx -y … or https://…',

  // ── 위키(운영 설정) ──
  wikiOpsTitle: ko ? '위키' : 'Wiki',
  wikiOpsSub: ko
    ? '팀의 공유 지식. 페이지 열람·승인은 앱에서, 여기는 운영 설정.'
    : "Your team's shared knowledge. Read and approve pages in the app — this is operational settings.",
  statPages: ko ? '페이지' : 'Pages',
  statPendingProposals: ko ? '승인 대기' : 'Pending approval',
  gitRemoteHeading: ko ? 'git 원격 동기화' : 'Git remote sync',
  remoteRepoLabel: ko ? '원격 저장소' : 'Remote repository',
  branchLabel: ko ? '브랜치' : 'Branch',
  syncHint: ko ? '60초마다 pull/push · 충돌은 자동 병합' : 'Pulls/pushes every 60s · conflicts auto-merge',

  // ── 서버 설정 ──
  serverSettingsTitle: ko ? '서버 설정' : 'Server settings',
  serverSettingsSub: ko ? '바꾼 설정은 저장 후 적용돼요.' : 'Changes take effect after you save.',
  serverNameLabel: ko ? '서버 이름' : 'Server name',
  portLabel: ko ? '포트' : 'Port',
  portHint: ko ? '클라이언트가 붙는 포트' : 'The port clients connect to',
  restartHint: ko ? '재시작 후 적용' : 'Applies after restart',
  exposureLabel: ko ? '공개 범위' : 'Exposure',
  exposureLocal: ko ? '이 컴퓨터만' : 'This computer only',
  exposureLan: ko ? '내부망(LAN)까지' : 'Local network (LAN)',
  exposureInternet: ko ? '인터넷 공개' : 'Public internet',
  exposureHint: ko ? '인터넷 공개는 HTTPS 구성 안내를 참고하세요' : 'See the HTTPS setup guide before exposing to the internet',
  ssoLabel: ko ? 'SSO (선택)' : 'SSO (optional)',
  oidcIssuerPlaceholder: ko ? 'OIDC 발급자 URL' : 'OIDC issuer URL',
  oidcClientIdPlaceholder: ko ? 'OIDC 클라이언트 ID' : 'OIDC client ID',
  oidcClientSecretPlaceholder: ko ? 'OIDC 클라이언트 시크릿' : 'OIDC client secret',
  codingLabel: ko ? '코딩 허용' : 'Allow coding',
  codingOff: ko ? '꺼짐' : 'Off',
  codingAuto: ko ? '자동' : 'Auto',
  codingAllowlist: ko ? '허용목록' : 'Allowlist',
  codingHint: ko
    ? '자동 = 모든 명령을 실행해요, 허용목록 = 허용된 명령만 실행해요, 꺼짐 = 코딩 기능을 사용하지 않아요'
    : 'Auto runs any command, Allowlist runs only approved commands, Off disables coding entirely',
  retentionLabel: ko ? '대화 보존' : 'Conversation retention',
  retentionCountOption: ko ? '채널당 최근 1,000개' : 'Last 1,000 per channel',
  retentionDaysOption: ko ? '최근 90일' : 'Last 90 days',
  retentionUnlimitedOption: ko ? '무제한' : 'Unlimited',
  retentionHint: ko
    ? '넘치는 오래된 메시지는 자동 삭제 — 위키에 저장된 지식은 유지돼요'
    : 'Old messages beyond the limit are deleted automatically — knowledge saved to the wiki is kept',
  // clear-compact Task 6: 대화 보존 select 바로 아래 토글(목업 ⑤). 힌트 문구는 Task 5 리뷰 교훈을
  // 그대로 반영 — "끄면 그냥 삭제"를 명시해야 사용자가 꺼도 되는지 판단할 수 있다(안 그러면 꺼짐이
  // 뭘 잃는지 몰라 아무도 못 끔).
  autoCompactLabel: ko ? '자동 정리' : 'Auto cleanup',
  autoCompactCheckboxLabel: ko ? '지우기 전에 위키로 요약' : 'Summarize to wiki before deleting',
  autoCompactHint: ko
    ? '켜면 지우기 전에 위키로 요약해요 · 끄면 오래된 대화를 요약 없이 그냥 삭제해요'
    : 'On summarizes old messages to the wiki before deleting them · Off just deletes them, no summary',
  clientDeployHeading: ko ? '클라이언트 배포' : 'Client deploy',
  deployTitle: ko ? '팀원용 클라이언트 설정 내려받기' : 'Download client settings for teammates',
  deploySub: ko
    ? '이 파일(preset)을 엔그램 앱 설치 폴더에 넣으면, 그 앱은 켜자마자 이 서버의 로그인 화면으로 시작해요. 팀원에게 앱 설치 파일과 함께 전달하세요.'
    : "Drop this file (preset) into an Engram app's install folder and that app starts straight at this server's sign-in screen. Share it with teammates alongside the installer.",
  downloadPresetBtn: ko ? 'preset.json 다운로드' : 'Download preset.json',

  // ── 상태·로그 ──
  statusLogTitle: ko ? '상태·로그' : 'Status & logs',
  statusLogSub: ko ? '서버 건강 상태와 걸려 있는 예약 작업.' : 'Server health and pending scheduled jobs.',
  statUptime: ko ? '가동 시간' : 'Uptime',
  statLastHeartbeat: ko ? '마지막 생존 신호' : 'Last heartbeat',
  statChatBytes: ko ? '대화 기록 용량' : 'Chat history size',
  statKnowledgeBytes: ko ? '위키+지식 용량' : 'Wiki + knowledge size',
  heartbeatJustNow: ko ? '방금 ✓' : 'Just now ✓',
  heartbeatMinutesAgo: (n: number) => (ko ? `${n}분 전` : `${n}m ago`),
  heartbeatNever: '—',
  schedulesHeading: (n: number) => (ko ? `예약 작업 ${n}` : `${n} scheduled jobs`),
  recentLogsHeading: ko ? '최근 로그' : 'Recent logs',
} as const;
