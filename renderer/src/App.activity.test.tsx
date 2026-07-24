import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import App from './App';
import { T } from './i18n';

// App.clear-compact.test.tsx와 동일한 최소 모의 소켓(단일 연결).
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

// 채널 하나(g1='general')를 만들고 currentName이 그걸로 안착할 때까지 기다린다(App.clear-compact.test.tsx와 동형).
async function openWithChannel() {
  render(<App />);
  act(() => { FakeWS.last.onopen!(); });
  act(() => {
    FakeWS.last.onmessage!({ data: JSON.stringify({ t: 'channels', list: [{ id: 'g1', name: 'general', respondMode: 'all', mode: 'chat' }] }) });
  });
  await waitFor(() => expect(screen.getByText('# general')).toBeInTheDocument());
  const ws = FakeWS.last;
  ws.sent = [];
  return ws;
}

// 입력창에 텍스트를 치고 Enter — sendText→expectReply 경로를 타 awaiting을 켠다(회귀 0 확인용 기존 경로 재사용).
function sendMessage(text: string) {
  const input = document.getElementById('input') as HTMLInputElement;
  act(() => { fireEvent.change(input, { target: { value: text } }); });
  act(() => { fireEvent.keyDown(input, { key: 'Enter' }); });
}

it('전송 직후엔 기본 "생각 중" 문구가 뜬다', async () => {
  await openWithChannel();
  sendMessage('hi');
  await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());
});

it('activity 프레임이 오면 인디케이터 라벨이 실시간으로 갱신된다', async () => {
  const ws = await openWithChannel();
  sendMessage('검색해줘');
  await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());

  act(() => { ws.onmessage!({ data: JSON.stringify({ t: 'activity', channelId: 'g1', label: '웹 검색 중 · web_search' }) }); });
  await waitFor(() => expect(screen.getByText('웹 검색 중 · web_search')).toBeInTheDocument());
  expect(screen.queryByText(T.thinking)).toBeNull(); // 기본 문구는 치환되고 사라졌다
});

it('답(msg) 도착 시 인디케이터가 사라지고, 다음 대기는 다시 기본 문구부터 시작한다', async () => {
  const ws = await openWithChannel();
  sendMessage('첫 질문');
  await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());
  act(() => { ws.onmessage!({ data: JSON.stringify({ t: 'activity', channelId: 'g1', label: '페이지 읽는 중 · fetch_url' }) }); });
  await waitFor(() => expect(screen.getByText('페이지 읽는 중 · fetch_url')).toBeInTheDocument());

  act(() => {
    ws.onmessage!({ data: JSON.stringify({ t: 'msg', channelId: 'g1', message: { id: 'r1', authorId: 'engram', text: '답', ts: '2026-01-01T00:00:00Z' } }) });
  });
  await waitFor(() => expect(screen.queryByText('페이지 읽는 중 · fetch_url')).toBeNull());
  expect(screen.queryByText(T.thinking)).toBeNull(); // awaiting 자체가 꺼졌다(인디케이터 통째로 안 뜸)

  // 다음 대기는 이전 라벨이 새어 나오지 않고 기본 문구부터.
  sendMessage('두번째 질문');
  await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());
});

it('답 도착 후 늦게 온 activity 프레임은 무시된다(잔재가 다음 대기로 새지 않음)', async () => {
  const ws = await openWithChannel();
  sendMessage('질문');
  await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());
  act(() => {
    ws.onmessage!({ data: JSON.stringify({ t: 'msg', channelId: 'g1', message: { id: 'r2', authorId: 'engram', text: '답', ts: '2026-01-01T00:00:00Z' } }) });
  });
  await waitFor(() => expect(screen.queryByText(T.thinking)).toBeNull());

  // 늦게 도착한 activity(이미 답이 온 뒤) — 화면에 아무 영향 없어야 한다.
  act(() => { ws.onmessage!({ data: JSON.stringify({ t: 'activity', channelId: 'g1', label: '레이트라벨' }) }); });
  expect(screen.queryByText('레이트라벨')).toBeNull();
  expect(screen.queryByText(T.thinking)).toBeNull(); // awaiting 꺼진 채로 유지(인디케이터 자체가 안 뜸)

  // 다음 대기를 시작해도 늦은 라벨이 새어 나오지 않고 기본 문구.
  sendMessage('다음 질문');
  await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());
  expect(screen.queryByText('레이트라벨')).toBeNull();
});

it('타 채널의 activity 프레임은 현재 채널 인디케이터에 영향을 주지 않는다', async () => {
  render(<App />);
  act(() => { FakeWS.last.onopen!(); });
  act(() => {
    FakeWS.last.onmessage!({
      data: JSON.stringify({ t: 'channels', list: [
        { id: 'g1', name: 'general', respondMode: 'all', mode: 'chat' },
        { id: 'g2', name: 'other', respondMode: 'all', mode: 'chat' },
      ] }),
    });
  });
  await waitFor(() => expect(screen.getByText('# general')).toBeInTheDocument());
  const ws = FakeWS.last;
  ws.sent = [];

  // 'general'(g1)에서 대기 시작.
  sendMessage('hi');
  await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());

  // 'other'(g2, 대기 중이 아님)로 온 activity — g1 인디케이터는 그대로 기본 문구여야 한다.
  act(() => { ws.onmessage!({ data: JSON.stringify({ t: 'activity', channelId: 'g2', label: '딴채널라벨' }) }); });
  expect(screen.queryByText('딴채널라벨')).toBeNull();
  expect(screen.getByText(T.thinking)).toBeInTheDocument();
});
