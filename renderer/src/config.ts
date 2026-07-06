// 붙을 두뇌 ws 엔드포인트(Phase 11: 로컬 두뇌 1개 고정. Phase 12에서 다중/설정화).
export const WS_URL = 'ws://127.0.0.1:47800';
// UI 언어: 영어 기본, 시스템 로케일이 한국어면 한국어(두뇌 T 사전과 동일 판정).
export const ko = navigator.language.toLowerCase().startsWith('ko');
