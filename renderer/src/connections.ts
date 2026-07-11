import { WS_URL, PRESET } from './config';

export interface Connection { id: string; name: string; endpoint: string }
interface State { connections: Connection[]; defaultConnId: string }

const KEY = 'engram.connections';

export function defaultEndpoint(): string { return WS_URL; }

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
