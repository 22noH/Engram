import { renderHook, act, waitFor } from '@testing-library/react';
import { useWs } from './client';

// 최소 모의 소켓: 인스턴스를 배열에 모아 테스트가 open/close/message를 구동.
class FakeWS {
  static instances: FakeWS[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  sent: string[] = [];
  constructor(public url: string) { FakeWS.instances.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
  _open() { this.readyState = 1; this.onopen?.(); }
}

beforeEach(() => { FakeWS.instances = []; (globalThis as any).WebSocket = FakeWS as any; });

it('open 시 connected=true, onOpen 콜백 발화, onFrame이 파싱된 프레임을 받는다', async () => {
  const frames: any[] = [];
  let opened = 0;
  const { result } = renderHook(() => useWs((f) => frames.push(f), () => { opened++; }));
  act(() => { FakeWS.instances[0]._open(); });
  await waitFor(() => expect(result.current.connected).toBe(true));
  expect(opened).toBe(1);
  act(() => { FakeWS.instances[0].onmessage!({ data: JSON.stringify({ t: 'error', text: 'x' }) }); });
  expect(frames).toEqual([{ t: 'error', text: 'x' }]);
});

it('손상 프레임은 무시한다', () => {
  const frames: any[] = [];
  renderHook(() => useWs((f) => frames.push(f)));
  act(() => { FakeWS.instances[0].onmessage!({ data: '{broken' }); });
  expect(frames).toHaveLength(0);
});

it('close 시 백오프 후 재연결한다', () => {
  vi.useFakeTimers();
  renderHook(() => useWs(() => {}));
  act(() => { FakeWS.instances[0]._open(); FakeWS.instances[0].close(); });
  expect(FakeWS.instances).toHaveLength(1);
  act(() => { vi.advanceTimersByTime(1000); });
  expect(FakeWS.instances).toHaveLength(2); // 첫 백오프 1s 후 새 소켓
  vi.useRealTimers();
});
