// 붙을 두뇌 ws 엔드포인트. Electron이 loadFile 시 ?port=<설정포트>를 붙여줌(없으면 기본 47800).
const port = new URLSearchParams(window.location.search).get('port') || '47800';
export const WS_URL = `ws://127.0.0.1:${port}`;

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

// 사람 팀채팅(Team) 영역 — 배포 형태 분리(2026-07-19 설계 §2.2): preset 배포(원격 서버가
// 박혀 나감)에서만 노출. 스탠드얼론(preset 없음 = 데스크톱 무설치 기본)은 탭 자체가 없다.
export const TEAM_CHAT = PRESET !== null;
