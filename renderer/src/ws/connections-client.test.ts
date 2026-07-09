import { renderHook, act } from '@testing-library/react';
import { useConnections } from './connections-client';

// 최소 모의 소켓 — client.test.ts의 FakeWS와 동일 패턴, url로 인스턴스 식별.
class FakeWS {
  static instances: FakeWS[] = [];
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  sent: string[] = [];
  constructor(url: string) { this.url = url; FakeWS.instances.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  msg(obj: any) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

beforeEach(() => {
  FakeWS.instances = [];
  vi.stubGlobal('WebSocket', FakeWS as any);
  (FakeWS as any).OPEN = 1;
});

it('opens one socket per connection and tags frames by connId', () => {
  const frames: Array<[string, any]> = [];
  const conns = [
    { id: 'a', name: 'A', endpoint: 'ws://a' },
    { id: 'b', name: 'B', endpoint: 'ws://b' },
  ];
  renderHook(() => useConnections(conns, (id, f) => frames.push([id, f])));
  expect(FakeWS.instances).toHaveLength(2);
  expect(FakeWS.instances[0].url).toBe('ws://a');
  expect(FakeWS.instances[1].url).toBe('ws://b');

  act(() => {
    FakeWS.instances[0].open();
    FakeWS.instances[0].msg({ t: 'error', text: 'x' });
  });
  expect(frames).toEqual([['a', { t: 'error', text: 'x' }]]);

  // b의 프레임은 b로만 태깅된다(교차 오염 없음).
  act(() => {
    FakeWS.instances[1].open();
    FakeWS.instances[1].msg({ t: 'error', text: 'y' });
  });
  expect(frames).toEqual([['a', { t: 'error', text: 'x' }], ['b', { t: 'error', text: 'y' }]]);
});

it('onOpen(connId) fires and status flips true on open, false on close', () => {
  const opened: string[] = [];
  const conns = [{ id: 'a', name: 'A', endpoint: 'ws://a' }];
  const { result } = renderHook(() => useConnections(conns, () => {}, (id) => opened.push(id)));

  act(() => { FakeWS.instances[0].open(); });
  expect(opened).toEqual(['a']);
  expect(result.current.statusById.a).toBe(true);

  act(() => { FakeWS.instances[0].close(); });
  expect(result.current.statusById.a).toBe(false);
});

it('send(connId, frame) only sends on that connection when OPEN', () => {
  const conns = [
    { id: 'a', name: 'A', endpoint: 'ws://a' },
    { id: 'b', name: 'B', endpoint: 'ws://b' },
  ];
  const { result } = renderHook(() => useConnections(conns, () => {}));

  // a가 아직 OPEN이 아니므로 전송되지 않는다.
  act(() => { result.current.send('a', { t: 'channels' }); });
  expect(FakeWS.instances[0].sent).toHaveLength(0);

  act(() => { FakeWS.instances[0].open(); });
  act(() => { result.current.send('a', { t: 'channels' }); });
  expect(FakeWS.instances[0].sent).toEqual([JSON.stringify({ t: 'channels' })]);
  // b 소켓엔 안 갔다.
  expect(FakeWS.instances[1].sent).toHaveLength(0);
});

it('reconnects with backoff after close (1s → new socket)', () => {
  vi.useFakeTimers();
  const conns = [{ id: 'a', name: 'A', endpoint: 'ws://a' }];
  renderHook(() => useConnections(conns, () => {}));
  expect(FakeWS.instances).toHaveLength(1);

  act(() => {
    FakeWS.instances[0].open();
    FakeWS.instances[0].close();
  });
  expect(FakeWS.instances).toHaveLength(1); // 백오프 대기 중, 아직 새 소켓 없음

  act(() => { vi.advanceTimersByTime(1000); });
  expect(FakeWS.instances).toHaveLength(2); // 첫 백오프 1s 후 재연결

  // 두 번째 실패는 5s 백오프.
  act(() => {
    FakeWS.instances[1].open();
    FakeWS.instances[1].close();
  });
  act(() => { vi.advanceTimersByTime(999); });
  expect(FakeWS.instances).toHaveLength(2);
  act(() => { vi.advanceTimersByTime(4001); });
  expect(FakeWS.instances).toHaveLength(3);

  vi.useRealTimers();
});

it('opens new sockets and closes removed ones when connections array changes', () => {
  const conns = [
    { id: 'a', name: 'A', endpoint: 'ws://a' },
    { id: 'b', name: 'B', endpoint: 'ws://b' },
  ];
  const { result, rerender } = renderHook(
    ({ connections }) => useConnections(connections, () => {}),
    { initialProps: { connections: conns } },
  );
  expect(FakeWS.instances).toHaveLength(2);
  act(() => { FakeWS.instances[0].open(); FakeWS.instances[1].open(); });

  // b 제거, c 추가.
  const next = [
    { id: 'a', name: 'A', endpoint: 'ws://a' },
    { id: 'c', name: 'C', endpoint: 'ws://c' },
  ];
  act(() => { rerender({ connections: next }); });

  expect(FakeWS.instances).toHaveLength(3); // a(유지, 재연결 안 함) + b(닫힘) + c(신규)
  expect(FakeWS.instances[1].readyState).toBe(3); // b가 close()됨
  expect(FakeWS.instances[2].url).toBe('ws://c');
  expect(result.current.statusById.b).toBeUndefined(); // 제거된 연결 상태는 지워짐
  expect(result.current.statusById.a).toBe(true); // a는 유지된 채 그대로
});

it('토큰이 있으면 open 시 auth 프레임을 가장 먼저 보낸다', () => {
  const conns = [{ id: 'a', name: 'A', endpoint: 'ws://a', token: 'sekret' }];
  renderHook(() => useConnections(conns, () => {}));
  act(() => { FakeWS.instances[0].open(); });
  expect(FakeWS.instances[0].sent[0]).toBe(JSON.stringify({ t: 'auth', token: 'sekret' }));
});

it('토큰이 없으면 auth 프레임을 보내지 않는다', () => {
  const conns = [{ id: 'a', name: 'A', endpoint: 'ws://a' }];
  renderHook(() => useConnections(conns, () => {}));
  act(() => { FakeWS.instances[0].open(); });
  expect(FakeWS.instances[0].sent).toHaveLength(0);
});

it('authErr 수신 시 재연결하지 않는다', () => {
  vi.useFakeTimers();
  const conns = [{ id: 'a', name: 'A', endpoint: 'ws://a', token: 'wrong' }];
  renderHook(() => useConnections(conns, () => {}));
  act(() => {
    FakeWS.instances[0].open();
    FakeWS.instances[0].msg({ t: 'authErr' });
    FakeWS.instances[0].close();
  });
  act(() => { vi.advanceTimersByTime(30000); });
  expect(FakeWS.instances).toHaveLength(1); // 재연결 시도 없음
  vi.useRealTimers();
});

it('토큰을 바꾸면 소켓을 새 토큰으로 재접속한다', () => {
  const { rerender } = renderHook(
    ({ connections }) => useConnections(connections, () => {}),
    { initialProps: { connections: [{ id: 'a', name: 'A', endpoint: 'ws://a', token: 't1' }] } },
  );
  act(() => { FakeWS.instances[0].open(); });
  expect(FakeWS.instances).toHaveLength(1);
  act(() => { rerender({ connections: [{ id: 'a', name: 'A', endpoint: 'ws://a', token: 't2' }] }); });
  expect(FakeWS.instances).toHaveLength(2);          // 재생성
  expect(FakeWS.instances[0].readyState).toBe(3);    // 옛 소켓 닫힘
  act(() => { FakeWS.instances[1].open(); });
  expect(FakeWS.instances[1].sent[0]).toBe(JSON.stringify({ t: 'auth', token: 't2' }));
});
