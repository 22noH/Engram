import { useEffect, useRef, useState } from 'react';
import { WS_URL } from '../config';
import type { ClientFrame, ServerFrame } from '../../../shared/protocol';

const DELAYS = [1000, 5000, 30000]; // 재연결 백오프(chat.html과 동일)

// 두뇌 ws에 붙는 단일 연결 훅. onOpen에서 호출부가 재동기화(channels/history 재요청)한다.
export function useWs(onFrame: (f: ServerFrame) => void, onOpen?: () => void) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const attempt = useRef(0);
  const closed = useRef(false);
  // 최신 콜백을 ref로 잡아 재연결 루프가 stale 클로저를 안 쓰게.
  const onFrameRef = useRef(onFrame); onFrameRef.current = onFrame;
  const onOpenRef = useRef(onOpen); onOpenRef.current = onOpen;

  useEffect(() => {
    closed.current = false;
    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => { attempt.current = 0; setConnected(true); onOpenRef.current?.(); };
      ws.onclose = () => {
        setConnected(false);
        if (closed.current) return;
        const d = DELAYS[Math.min(attempt.current++, DELAYS.length - 1)];
        setTimeout(connect, d);
      };
      ws.onerror = () => { /* onclose가 재연결 담당 */ };
      ws.onmessage = (ev) => {
        let f: ServerFrame;
        try { f = JSON.parse(ev.data as string) as ServerFrame; } catch { return; }
        onFrameRef.current(f);
      };
    };
    connect();
    return () => { closed.current = true; wsRef.current?.close(); };
  }, []);

  const send = (f: ClientFrame): void => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
  };
  return { send, connected };
}
