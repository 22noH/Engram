import { render, screen, act, waitFor } from '@testing-library/react';
import App from './App';

class FakeWS {
  static last: FakeWS;
  static OPEN = 1;
  onopen: (() => void) | null = null; onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null; onerror: (() => void) | null = null;
  readyState = 1; sent: string[] = [];
  constructor() { FakeWS.last = this; }
  send(d: string) { this.sent.push(d); }
  close() {}
}
beforeEach(() => { (globalThis as any).WebSocket = FakeWS as any; });

it('open 후 channels 프레임을 받으면 채널 탭·목록을 렌더한다', async () => {
  render(<App />);
  act(() => { FakeWS.last.onopen!(); });
  act(() => { FakeWS.last.onmessage!({ data: JSON.stringify({ t: 'channels', list: [{ id: 'g', name: 'general', respondMode: 'all', mode: 'chat' }] }) }); });
  await waitFor(() => expect(screen.getByText('# general')).toBeInTheDocument());
  expect(FakeWS.last.sent.some((s) => s.includes('"channels"'))).toBe(true); // 재동기화 요청
});
