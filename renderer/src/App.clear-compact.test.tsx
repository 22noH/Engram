import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import App from './App';

// App.test.tsx와 동일한 최소 모의 소켓(단일 연결).
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
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

// 채널 하나(g1='general')를 만들고 currentName이 그걸로 안착할 때까지 기다린다.
async function openWithChannel() {
  render(<App />);
  act(() => { FakeWS.last.onopen!(); });
  act(() => {
    FakeWS.last.onmessage!({ data: JSON.stringify({ t: 'channels', list: [{ id: 'g1', name: 'general', respondMode: 'all', mode: 'chat' }] }) });
  });
  await waitFor(() => expect(screen.getByText('# general')).toBeInTheDocument());
  const ws = FakeWS.last;
  ws.sent = []; // 초기 재동기화(channels/history) 프레임은 이후 단언에서 걸리적거리니 비운다
  return ws;
}

it('팔레트에서 /clear를 고르면 clearHistory를 보내고 입력창을 채우지 않는다', async () => {
  const ws = await openWithChannel();
  const input = document.getElementById('input') as HTMLInputElement;
  act(() => { fireEvent.change(input, { target: { value: '/clear' } }); });
  act(() => { fireEvent.keyDown(input, { key: 'Enter' }); });
  await waitFor(() => {
    expect(ws.sent.some((s) => s.includes('"clearHistory"') && s.includes('"id":"g1"'))).toBe(true);
  });
  expect(input.value).toBe('');
});

it('팔레트에서 /compact를 고르면 compact를 보내고 입력창을 채우지 않는다', async () => {
  const ws = await openWithChannel();
  const input = document.getElementById('input') as HTMLInputElement;
  act(() => { fireEvent.change(input, { target: { value: '/compact' } }); });
  act(() => { fireEvent.keyDown(input, { key: 'Enter' }); });
  await waitFor(() => {
    expect(ws.sent.some((s) => s.includes('"compact"') && s.includes('"id":"g1"'))).toBe(true);
  });
  expect(input.value).toBe('');
});

it('⋯메뉴 "요약해서 정리" 클릭 시 compact를 보낸다', async () => {
  const ws = await openWithChannel();
  const menuBtn = document.querySelector('#channels .ch .menu') as HTMLElement;
  fireEvent.click(menuBtn);
  const item = await screen.findByText(/요약해서 정리|Summarize/);
  act(() => { fireEvent.click(item); });
  await waitFor(() => {
    expect(ws.sent.some((s) => s.includes('"compact"') && s.includes('"id":"g1"'))).toBe(true);
  });
});

it('⋯메뉴 "대화 기록 삭제" 클릭 시 확인창 없이 clearHistory를 보낸다', async () => {
  const ws = await openWithChannel();
  const confirmSpy = vi.spyOn(window, 'confirm');
  const menuBtn = document.querySelector('#channels .ch .menu') as HTMLElement;
  fireEvent.click(menuBtn);
  const item = await screen.findByText(/대화 기록 삭제|Delete history/);
  act(() => { fireEvent.click(item); });
  await waitFor(() => {
    expect(ws.sent.some((s) => s.includes('"clearHistory"') && s.includes('"id":"g1"'))).toBe(true);
  });
  expect(confirmSpy).not.toHaveBeenCalled();
});

it('historyCleared 수신 → transcript가 비고 실행취소 토스트가 뜬다', async () => {
  const ws = await openWithChannel();
  act(() => { ws.onmessage!({ data: JSON.stringify({ t: 'history', channelId: 'g1', messages: [{ id: 'm1', authorId: 'owner', text: 'hello', ts: '2026-01-01T00:00:00Z' }] }) }); });
  await waitFor(() => expect(screen.getByText('hello')).toBeInTheDocument());

  act(() => { ws.onmessage!({ data: JSON.stringify({ t: 'historyCleared', channelId: 'g1' }) }); });
  await waitFor(() => expect(screen.queryByText('hello')).not.toBeInTheDocument());
  expect(screen.getByText(/대화 기록을 비웠어요|Cleared this conversation/)).toBeInTheDocument();
  expect(screen.getByText(/실행취소|Undo/)).toBeInTheDocument();
});

it('토스트 "실행취소" 클릭 → undoClear를 보내고 토스트를 끈다', async () => {
  const ws = await openWithChannel();
  act(() => { ws.onmessage!({ data: JSON.stringify({ t: 'historyCleared', channelId: 'g1' }) }); });
  await waitFor(() => expect(screen.getByText(/실행취소|Undo/)).toBeInTheDocument());

  fireEvent.click(screen.getByText(/실행취소|Undo/));
  await waitFor(() => {
    expect(ws.sent.some((s) => s.includes('"undoClear"') && s.includes('"id":"g1"'))).toBe(true);
  });
  expect(screen.queryByText(/실행취소|Undo/)).not.toBeInTheDocument();
  // undoClear는 백업을 지우면 안 되므로 dropClearBackup은 안 나가야 한다.
  expect(ws.sent.some((s) => s.includes('"dropClearBackup"'))).toBe(false);
});

it('토스트가 ~6초 뒤 만료되면 dropClearBackup을 보내고 스스로 닫힌다', async () => {
  const ws = await openWithChannel();
  // waitFor 등 RTL 비동기 헬퍼는 실타이머 폴링에 의존하므로, fake timers는 openWithChannel의
  // await가 다 끝난 뒤에만 켠다(안 그러면 waitFor가 멈춘다).
  vi.useFakeTimers();
  act(() => { ws.onmessage!({ data: JSON.stringify({ t: 'historyCleared', channelId: 'g1' }) }); });
  expect(screen.getByText(/실행취소|Undo/)).toBeInTheDocument();

  act(() => { vi.advanceTimersByTime(6000); });
  expect(ws.sent.some((s) => s.includes('"dropClearBackup"') && s.includes('"id":"g1"'))).toBe(true);
  expect(screen.queryByText(/실행취소|Undo/)).not.toBeInTheDocument();
});

it('historyRestored 수신 → 그 채널 메시지를 재로드(history 재요청)하고 토스트를 끈다', async () => {
  const ws = await openWithChannel();
  act(() => { ws.onmessage!({ data: JSON.stringify({ t: 'historyCleared', channelId: 'g1' }) }); });
  await waitFor(() => expect(screen.getByText(/실행취소|Undo/)).toBeInTheDocument());
  ws.sent = [];

  act(() => { ws.onmessage!({ data: JSON.stringify({ t: 'historyRestored', channelId: 'g1' }) }); });
  await waitFor(() => {
    expect(ws.sent.some((s) => s.includes('"history"') && s.includes('"channelId":"g1"'))).toBe(true);
  });
  expect(screen.queryByText(/실행취소|Undo/)).not.toBeInTheDocument();
});

it('compacted 수신 → 그 채널 메시지를 재로드(history 재요청)한다', async () => {
  const ws = await openWithChannel();
  act(() => { ws.onmessage!({ data: JSON.stringify({ t: 'compacted', channelId: 'g1', slug: 'some-slug' }) }); });
  await waitFor(() => {
    expect(ws.sent.some((s) => s.includes('"history"') && s.includes('"channelId":"g1"'))).toBe(true);
  });
});
