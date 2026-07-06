// 붙을 두뇌 ws 엔드포인트. Electron이 loadFile 시 ?port=<설정포트>를 붙여줌(없으면 기본 47800).
const port = new URLSearchParams(window.location.search).get('port') || '47800';
export const WS_URL = `ws://127.0.0.1:${port}`;
// UI 언어: 영어 기본, 시스템 로케일이 한국어면 한국어(두뇌 T 사전과 동일 판정).
export const ko = navigator.language.toLowerCase().startsWith('ko');
