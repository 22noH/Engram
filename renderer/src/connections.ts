import { WS_URL, LOCAL_TOKEN } from './config';

export interface Connection { id: string; name: string; endpoint: string; token?: string }
interface State { connections: Connection[]; defaultConnId: string }

const KEY = 'engram.connections';

export function defaultEndpoint(): string { return WS_URL; }

function seed(): State {
  return { connections: [{ id: 'local', name: 'Local', endpoint: defaultEndpoint() }], defaultConnId: 'local' };
}

export function loadConnections(localToken: string | undefined = LOCAL_TOKEN): State {
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
  // 로컬 연결 토큰은 main(chat.json)이 진실원 — 부팅 주입값으로 맞춘다.
  // ponytail: localToken 있을 때만 패치. 서버 토큰 해제 후 stale 토큰이 남아도 무인증 서버는 무시하므로 무해.
  if (localToken) {
    const local = s.connections.find((c) => c.id === 'local');
    if (local) local.token = localToken;
  }
  return s;
}

export function saveConnections(state: State): void {
  localStorage.setItem(KEY, JSON.stringify(state));
}

function newId(state: State, name: string): string {
  const g = (globalThis.crypto as any)?.randomUUID?.();
  return g ?? `${name}-${state.connections.length}-${state.connections.length}`;
}

export function addConnection(state: State, name: string, endpoint: string, token?: string): State {
  const conn: Connection = { id: newId(state, name), name, endpoint, ...(token ? { token } : {}) };
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
