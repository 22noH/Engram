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
} as const;
