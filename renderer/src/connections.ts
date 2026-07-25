import { WS_URL, PRESET } from './config';

export interface Connection { id: string; name: string; endpoint: string }
interface State { connections: Connection[]; defaultConnId: string }

const KEY = 'engram.connections';

export function defaultEndpoint(): string { return WS_URL; }

// 루프백 주소 집합 — 두뇌 계층의 isLoopback(src/edge/mcp/mcp-http.ts) 관례와 같은 값을 렌더러 쪽에도
// 독립 보유한다(renderer는 src/를 참조할 수 없는 별도 tsconfig 스코프라 공유 불가, 값만 맞춘다).
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1']);

// 이 연결이 "이 컴퓨터의 두뇌"인가. 입력바의 모델·노력 배지 게이트에 쓴다 — 원격 연결은 그 서버의
// 설정(어떤 모델로 어느 노력 수준으로 돌릴지)을 그대로 따르므로 클라가 바꿀 자리를 아예 안 보여준다.
// 파싱 실패·빈 값은 원격 취급(안전측: 배지를 숨긴다).
export function isLocalEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(endpoint).hostname.toLowerCase());
  } catch {
    return false;
  }
}

// 배포 프리셋(Task 15)이 있으면 그 서버를 기본 연결로 시드(로컬 두뇌도 그대로 유지).
function seed(): State {
  const local: Connection = { id: 'local', name: 'Local', endpoint: defaultEndpoint() };
  if (PRESET) {
    return { connections: [{ id: 'preset', name: PRESET.name, endpoint: PRESET.endpoint }, local], defaultConnId: 'preset' };
  }
  return { connections: [local], defaultConnId: 'local' };
}

export function loadConnections(): State {
  let s: State;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) { s = seed(); }
    else {
      const parsed = JSON.parse(raw) as State;
      if (!parsed.connections?.length) s = seed();
      else {
        if (!parsed.connections.some((c) => c.id === parsed.defaultConnId)) parsed.defaultConnId = parsed.connections[0].id;
        s = parsed;
      }
    }
  } catch { s = seed(); }
  return s;
}

export function saveConnections(state: State): void {
  localStorage.setItem(KEY, JSON.stringify(state));
}

function newId(state: State, name: string): string {
  const g = (globalThis.crypto as any)?.randomUUID?.();
  return g ?? `${name}-${state.connections.length}-${state.connections.length}`;
}

export function addConnection(state: State, name: string, endpoint: string): State {
  const conn: Connection = { id: newId(state, name), name, endpoint };
  return { connections: [...state.connections, conn], defaultConnId: state.defaultConnId };
}

export function removeConnection(state: State, id: string): State {
  const connections = state.connections.filter((c) => c.id !== id);
  const defaultConnId = state.defaultConnId === id ? (connections[0]?.id ?? '') : state.defaultConnId;
  return { connections, defaultConnId };
}

export function setDefault(state: State, id: string): State {
  return state.connections.some((c) => c.id === id) ? { ...state, defaultConnId: id } : state;
}
