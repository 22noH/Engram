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
beforeEach(() => { localStorage.clear(); (globalThis as any).WebSocket = FakeWS as any; });
afterEach(() => { vi.restoreAllMocks(); });

it('open 후 channels 프레임을 받으면 채널 탭·목록을 렌더한다', async () => {
  render(<App />);
  act(() => { FakeWS.last.onopen!(); });
  act(() => { FakeWS.last.onmessage!({ data: JSON.stringify({ t: 'channels', list: [{ id: 'g', name: 'general', respondMode: 'all', mode: 'chat' }] }) }); });
  await waitFor(() => expect(screen.getByText('# general')).toBeInTheDocument());
  expect(FakeWS.last.sent.some((s) => s.includes('"channels"'))).toBe(true); // 재동기화 요청
});

// 배포 형태 분리(2026-07-19 설계 §2.2) — /auth/status.localFree=true는 기존 null(무인증) 처리와
// 같은 결로 게이트를 생략한다.
it('/auth/status.localFree=true면 로그인 게이트를 생략한다', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify({ configured: false, oidc: false, localFree: true }), { status: 200 }),
  );
  render(<App />);
  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
  expect(document.getElementById('loginGate')).toBeNull();
});

// 회귀 — configured:true는 종전대로 로그인 폼을 띄운다.
it('/auth/status.configured=true면 로그인 폼을 렌더한다(회귀)', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify({ configured: true, oidc: false, serverName: 'Local' }), { status: 200 }),
  );
  render(<App />);
  await waitFor(() => expect(document.getElementById('loginGate')).toBeTruthy());
  expect(screen.getByPlaceholderText(/id/i)).toBeInTheDocument();
});

// 미설정(원격, localFree 아님) — "내 서버 만들기" 셋업 폼은 삭제됐으므로 안내 문구만 뜬다.
it('/auth/status.configured=false·localFree 아님 → 셋업 폼 없이 안내 문구', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify({ configured: false, oidc: false }), { status: 200 }),
  );
  render(<App />);
  await waitFor(() => expect(document.getElementById('loginGate')).toBeTruthy());
  expect(screen.queryByPlaceholderText(/setup code/i)).toBeNull();
  expect(screen.getByText(/ask the server owner|서버 관리자에게 문의/i)).toBeInTheDocument();
});
