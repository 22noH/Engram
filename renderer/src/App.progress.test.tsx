import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import App from './App';

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

function push(ws: FakeWS, message: Record<string, unknown>) {
  act(() => { ws.onmessage!({ data: JSON.stringify({ t: 'msg', channelId: 'g1', message }) }); });
}

const ts = () => new Date().toISOString();

describe('진행 중 애니메이션 — 마지막 진행 메시지 하나만', () => {
  it('진행 메시지가 쌓이면 마지막 하나만 running, 앞의 것들은 done', async () => {
    const ws = await openWithChannel();
    push(ws, { id: 'p1', authorId: 'engram', text: '· 분해 완료 — 작업 2개', ts: ts(), progress: true });
    push(ws, { id: 'p2', authorId: 'engram', text: '· 코딩 중: backend', ts: ts(), progress: true });

    await waitFor(() => expect(document.querySelectorAll('.msg.progress').length).toBe(2));
    const running = document.querySelectorAll('.msg.progress.running');
    expect(running.length).toBe(1);
    expect(running[0].textContent).toContain('코딩 중: backend');
    expect(document.querySelectorAll('.msg.progress.done').length).toBe(1);
  });

  it('답(진행 표시 없는 메시지)이 오면 애니메이션이 즉시 멈춘다', async () => {
    const ws = await openWithChannel();
    push(ws, { id: 'p1', authorId: 'engram', text: '· 코딩 중: backend', ts: ts(), progress: true });
    await waitFor(() => expect(document.querySelectorAll('.msg.progress.running').length).toBe(1));

    push(ws, { id: 'r1', authorId: 'engram', text: '✅ 코딩 완료', ts: ts() });
    await waitFor(() => expect(document.querySelectorAll('.msg.progress.running').length).toBe(0));
    expect(document.querySelectorAll('.msg.progress.done').length).toBe(1); // 완료 표시로 남는다
  });

  it('진행 표시 없는 기존 메시지들만 있으면 아무 변화 없다(회귀 0)', async () => {
    const ws = await openWithChannel();
    push(ws, { id: 'm1', authorId: 'engram', text: '보통 답', ts: ts() });
    await waitFor(() => expect(screen.getByText('보통 답')).toBeInTheDocument());
    expect(document.querySelectorAll('.msg.progress').length).toBe(0);
  });
});

describe('이미 쓴 버튼 숨기기', () => {
  const card = { id: 'c1', authorId: 'engram', text: '완성조건…', ts: ts(),
    actions: [{ label: '✅ 승인', send: '승인' }, { label: '취소', send: '취소' }] };

  it('클릭하면 answersId(카드 id)와 함께 전송되고, 그 답이 오면 버튼이 사라진다', async () => {
    const ws = await openWithChannel();
    push(ws, card);
    await waitFor(() => expect(screen.getByText('✅ 승인')).toBeInTheDocument());

    act(() => { fireEvent.click(screen.getByText('✅ 승인')); });
    const sent = ws.sent.map((s) => JSON.parse(s)).find((f) => f.t === 'send');
    expect(sent).toMatchObject({ text: '승인', answersId: 'c1' });

    // 서버가 그 답을 기록해 되돌려줌(echo) → 버튼은 흔적도 없이 사라진다.
    push(ws, { id: 'u1', authorId: 'owner', text: '승인', ts: ts(), answersId: 'c1' });
    await waitFor(() => expect(screen.queryByText('✅ 승인')).toBeNull());
    expect(screen.queryByText('취소')).toBeNull();
    expect(screen.getByText('완성조건…')).toBeInTheDocument(); // 카드 본문은 남는다
  });

  it('새로고침·재접속(history) 후에도 숨김이 유지된다', async () => {
    const ws = await openWithChannel();
    act(() => {
      ws.onmessage!({ data: JSON.stringify({ t: 'history', channelId: 'g1', messages: [
        card,
        { id: 'u1', authorId: 'owner', text: '승인', ts: ts(), answersId: 'c1' },
      ] }) });
    });
    await waitFor(() => expect(screen.getByText('완성조건…')).toBeInTheDocument());
    expect(screen.queryByText('✅ 승인')).toBeNull();
  });

  it('버튼을 안 썼으면(다른 말만 했으면) 그대로 보인다 — 서버 pending은 아직 살아 있다', async () => {
    const ws = await openWithChannel();
    push(ws, card);
    push(ws, { id: 'u2', authorId: 'owner', text: '잠깐, 이거 먼저 물어볼게', ts: ts() });
    await waitFor(() => expect(screen.getByText('잠깐, 이거 먼저 물어볼게')).toBeInTheDocument());
    expect(screen.getByText('✅ 승인')).toBeInTheDocument();
  });

  it('옛 기록(answersId 없이 그 답 텍스트만 있는 경우)도 숨긴다', async () => {
    const ws = await openWithChannel();
    act(() => {
      ws.onmessage!({ data: JSON.stringify({ t: 'history', channelId: 'g1', messages: [
        card,
        { id: 'u3', authorId: 'owner', text: '승인', ts: ts() },
      ] }) });
    });
    await waitFor(() => expect(screen.getByText('완성조건…')).toBeInTheDocument());
    expect(screen.queryByText('✅ 승인')).toBeNull();
  });
});
