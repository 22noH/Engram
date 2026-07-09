// 팀채팅 표시용 자가선언 닉네임(전역 1개). 검증 안 함 — 계정은 Phase 16.
const KEY = 'engram.displayName';

export function loadDisplayName(): string {
  try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; }
}

export function saveDisplayName(name: string): void {
  try { localStorage.setItem(KEY, name); } catch { /* 무시 */ }
}
