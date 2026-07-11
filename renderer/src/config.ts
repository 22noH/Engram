// 붙을 두뇌 ws 엔드포인트. Electron이 loadFile 시 ?port=<설정포트>를 붙여줌(없으면 기본 47800).
const port = new URLSearchParams(window.location.search).get('port') || '47800';
export const WS_URL = `ws://127.0.0.1:${port}`;
// 사람 팀채팅(Team) 영역 — Phase 11b는 구조만, 서버 없으니 기본 숨김(Phase 14에서 켠다).
export const TEAM_CHAT = true; // Phase 14: 팀채팅 개방(11b 봉인 해제).

// 설정 언어: Electron이 ?lang= 주입(main.ts). 없으면 navigator 폴백('ko'|기타→2자).
const langParam = new URLSearchParams(window.location.search).get('lang');
export const LANG = (langParam && langParam.trim()) || navigator.language.slice(0, 2).toLowerCase();
// UI 언어: 설정 언어(LANG)가 한국어면 한국어(두뇌 T 사전과 동일 판정).
export const ko = LANG === 'ko';

// 배포 프리셋(Phase 16a Task 15): Electron이 configDir/preset.json이 있으면 ?presetName=&presetEndpoint=를 주입.
// 없으면 null — connections.ts seed()가 기존 local-only로 폴백.
const presetName = new URLSearchParams(window.location.search).get('presetName');
const presetEndpoint = new URLSearchParams(window.location.search).get('presetEndpoint');
export const PRESET = presetEndpoint ? { name: presetName || 'Server', endpoint: presetEndpoint } : null;
