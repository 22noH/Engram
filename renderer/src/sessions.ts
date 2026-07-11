// 연결별 세션 토큰(localStorage). 로그인하면 저장 — 매번 로그인하지 않는다(스펙 §2.5).
const KEY = 'engram.sessions';

export function loadSessions(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, string> : {};
  } catch { return {}; }
}
function save(m: Record<string, string>): Record<string, string> {
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* 무시 */ }
  return m;
}
export function saveSessionFor(connId: string, token: string): Record<string, string> {
  return save({ ...loadSessions(), [connId]: token });
}
export function clearSessionFor(connId: string): Record<string, string> {
  const m = { ...loadSessions() };
  delete m[connId];
  return save(m);
}
