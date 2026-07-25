import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import App from './App';
import { T } from './i18n';

// App.activity.test.tsx와 동일한 최소 모의 소켓(단일 연결).
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

function sendMessage(text: string) {
  const input = document.getElementById('input') as HTMLInputElement;
  act(() => { fireEvent.change(input, { target: { value: text } }); });
  act(() => { fireEvent.keyDown(input, { key: 'Enter' }); });
}

function pushDelta(ws: FakeWS, text: string, channelId = 'g1') {
  act(() => { ws.onmessage!({ data: JSON.stringify({ t: 'delta', channelId, text }) }); });
}

it('델타가 오면 "생각 중" 자리에 흐르는 텍스트가 뜨고, 이어지는 델타는 이어붙는다', async () => {
  const ws = await openWithChannel();
  sendMessage('안녕?');
  await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());

  pushDelta(ws, '안녕하');
  await waitFor(() => expect(screen.getByText('안녕하')).toBeInTheDocument());
  expect(screen.queryByText(T.thinking)).toBeNull(); // 기본 문구는 흐르는 텍스트로 치환

  pushDelta(ws, '세요!'); // 증분 — 렌더러가 이어붙인다(누적 전체 텍스트가 아님)
  await waitFor(() => expect(screen.getByText('안녕하세요!')).toBeInTheDocument());
});

it('스트리밍 중에도 활동 라벨(도구 사용)이 답변 텍스트와 함께 보인다', async () => {
  const ws = await openWithChannel();
  sendMessage('검색해줘');
  await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());

  pushDelta(ws, '찾아볼게요');
  act(() => { ws.onmessage!({ data: JSON.stringify({ t: 'activity', channelId: 'g1', label: '웹 검색 중 · web_search' }) }); });
  await waitFor(() => expect(screen.getByText('찾아볼게요')).toBeInTheDocument());
  expect(screen.getByText('웹 검색 중 · web_search')).toBeInTheDocument();
});

it('최종 msg가 도착하면 델타 버퍼는 버려지고 확정 메시지만 남는다(중복 표시 금지)', async () => {
  const ws = await openWithChannel();
  sendMessage('질문');
  await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());
  pushDelta(ws, '부분 답');
  await waitFor(() => expect(screen.getByText('부분 답')).toBeInTheDocument());

  act(() => {
    ws.onmessage!({ data: JSON.stringify({ t: 'msg', channelId: 'g1', message: { id: 'r1', authorId: 'engram', text: '부분 답변 완성', ts: '2026-01-01T00:00:00Z' } }) });
  });
  await waitFor(() => expect(document.querySelector('.streaming')).toBeNull());
  expect(screen.queryByText(T.thinking)).toBeNull();

  // 다음 대기는 이전 델타 잔재 없이 기본 문구부터.
  sendMessage('두번째');
  await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());
  expect(document.querySelector('.streaming')).toBeNull();
});

it('답 도착 후 늦게 온 델타는 무시된다(activity와 동일 규칙)', async () => {
  const ws = await openWithChannel();
  sendMessage('질문');
  await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());
  act(() => {
    ws.onmessage!({ data: JSON.stringify({ t: 'msg', channelId: 'g1', message: { id: 'r2', authorId: 'engram', text: '답', ts: '2026-01-01T00:00:00Z' } }) });
  });
  await waitFor(() => expect(screen.queryByText(T.thinking)).toBeNull());

  pushDelta(ws, '레이트델타');
  expect(screen.queryByText('레이트델타')).toBeNull();

  sendMessage('다음 질문');
  await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());
  expect(screen.queryByText('레이트델타')).toBeNull();
});

it('타 채널의 델타는 현재 채널 인디케이터에 영향을 주지 않는다', async () => {
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

  sendMessage('hi');
  await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());
  pushDelta(ws, '딴채널델타', 'g2');
  expect(screen.queryByText('딴채널델타')).toBeNull();
  expect(screen.getByText(T.thinking)).toBeInTheDocument();
});

it('중지(Esc)하면 흐르던 텍스트도 즉시 정리된다', async () => {
  const ws = await openWithChannel();
  sendMessage('긴 질문');
  await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());
  pushDelta(ws, '쓰다 만 답');
  await waitFor(() => expect(screen.getByText('쓰다 만 답')).toBeInTheDocument());

  act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
  await waitFor(() => expect(screen.queryByText('쓰다 만 답')).toBeNull());
  // 답(중단 안내)이 오기 전까지는 여전히 대기 중 — 기본 문구로 되돌아간다.
  expect(screen.getByText(T.thinking)).toBeInTheDocument();
});
