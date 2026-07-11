import { useEffect, useRef, useState } from 'react';
import type { Connection } from '../connections';
import type { ClientFrame, ServerFrame } from '../../../shared/protocol';

const DELAYS = [1000, 5000, 30000]; // 재연결 백오프(client.ts와 동일)

interface Slot {
  ws: WebSocket | null;
  attempt: number;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  authFailed: boolean;   // authErr 받으면 true → 재연결 중단
  session?: string;      // 이 소켓이 붙을 때 쓴 세션 토큰(변경 감지용)
}

// 연결마다 소켓 하나. connections 배열이 바뀌면(추가/삭제) 그에 맞춰 소켓을 열고/닫는다.
// 프레임은 onFrame(connId, frame)으로 로컬 태깅되어 올라간다(와이어에는 connId 없음).
export function useConnections(
  connections: Connection[],
  sessions: Record<string, string>,
  onFrame: (connId: string, f: ServerFrame) => void,
  onOpen?: (connId: string) => void,
) {
  const [statusById, setStatusById] = useState<Record<string, boolean>>({});
  const slotsRef = useRef<Map<string, Slot>>(new Map());
  // 최신 콜백/연결목록/세션을 ref로 잡아 재연결 루프가 stale 클로저를 안 쓰게(client.ts 패턴).
  const onFrameRef = useRef(onFrame); onFrameRef.current = onFrame;
  const onOpenRef = useRef(onOpen); onOpenRef.current = onOpen;
  const connectionsRef = useRef(connections); connectionsRef.current = connections;
  const sessionsRef = useRef(sessions); sessionsRef.current = sessions;

  const ids = connections.map((c) => `${c.id}:${sessions[c.id] ?? ''}`).join(',');

  useEffect(() => {
    const slots = slotsRef.current;
    const wanted = new Map(connections.map((c) => [c.id, c]));

    // 사라졌거나 세션이 바뀐 슬롯은 닫는다(세션 변경=재접속 필요).
    for (const [id, slot] of slots) {
      const w = wanted.get(id);
      if (w && (sessions[id] ?? '') === (slot.session ?? '')) continue;
      slot.closed = true;
      if (slot.timer) clearTimeout(slot.timer);
      slot.ws?.close();
      slots.delete(id);
      setStatusById((s) => {
        if (!(id in s)) return s;
        const next = { ...s };
        delete next[id];
        return next;
      });
    }

    // 새 연결마다 소켓을 연다.
    for (const conn of connections) {
      if (slots.has(conn.id)) continue;
      const connId = conn.id;
      const slot: Slot = { ws: null, attempt: 0, closed: false, timer: null, authFailed: false, session: sessions[conn.id] };
      slots.set(connId, slot);

      const connect = () => {
        if (slot.closed) return;
        const endpoint = connectionsRef.current.find((c) => c.id === connId)?.endpoint ?? conn.endpoint;
        const ws = new WebSocket(endpoint);
        slot.ws = ws;
        ws.onopen = () => {
          slot.attempt = 0;
          const tok = sessionsRef.current[connId];
          if (tok) ws.send(JSON.stringify({ t: 'auth', token: tok }));
          setStatusById((s) => ({ ...s, [connId]: true }));
          onOpenRef.current?.(connId);
        };
        ws.onclose = () => {
          setStatusById((s) => ({ ...s, [connId]: false }));
          if (slot.closed || slot.authFailed) return;
          const d = DELAYS[Math.min(slot.attempt++, DELAYS.length - 1)];
          slot.timer = setTimeout(connect, d);
        };
        ws.onerror = () => { /* onclose가 재연결 담당 */ };
        ws.onmessage = (ev) => {
          let f: ServerFrame;
          try { f = JSON.parse(ev.data as string) as ServerFrame; } catch { return; }
          if (f.t === 'authErr') slot.authFailed = true; // onclose가 재연결 중단
          onFrameRef.current(connId, f);
        };
      };
      connect();
    }
  }, [ids]);

  // 언마운트 시에는 모든 소켓을 닫는다(재연결 타이머 포함).
  useEffect(() => () => {
    for (const slot of slotsRef.current.values()) {
      slot.closed = true;
      if (slot.timer) clearTimeout(slot.timer);
      slot.ws?.close();
    }
    slotsRef.current.clear();
  }, []);

  const send = (connId: string, f: ClientFrame): void => {
    const ws = slotsRef.current.get(connId)?.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
  };

  return { send, statusById };
}
