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

function input(): HTMLTextAreaElement {
  return document.getElementById('input') as HTMLTextAreaElement;
}

function sentFrames(ws: FakeWS): any[] {
  return ws.sent.map((s) => JSON.parse(s));
}

describe('여러 줄 입력(Task 4) — Enter/Shift+Enter/자동높이', () => {
  it('#input은 textarea다', async () => {
    await openWithChannel();
    expect(input().tagName).toBe('TEXTAREA');
  });

  it('Enter(시프트 없음)는 전송하고 입력을 비운다', async () => {
    const ws = await openWithChannel();
    const i = input();
    act(() => { fireEvent.change(i, { target: { value: '안녕' } }); });
    act(() => { fireEvent.keyDown(i, { key: 'Enter' }); });
    await waitFor(() => expect(sentFrames(ws).some((f) => f.t === 'send' && f.text === '안녕')).toBe(true));
    expect(i.value).toBe('');
  });

  it('Shift+Enter는 전송하지 않고 커서 위치에 줄바꿈을 삽입한다', async () => {
    const ws = await openWithChannel();
    const i = input();
    act(() => { fireEvent.change(i, { target: { value: '첫줄' } }); });
    // 커서를 끝에 둔 상태로 Shift+Enter.
    i.selectionStart = i.selectionEnd = i.value.length;
    act(() => { fireEvent.keyDown(i, { key: 'Enter', shiftKey: true }); });
    expect(i.value).toBe('첫줄\n');
    expect(sentFrames(ws).some((f) => f.t === 'send')).toBe(false); // 전송 안 됨
    // 이어서 둘째 줄을 치고 일반 Enter로 전송하면 두 줄 다 실린다.
    act(() => { fireEvent.change(i, { target: { value: '첫줄\n둘째줄' } }); });
    act(() => { fireEvent.keyDown(i, { key: 'Enter' }); });
    await waitFor(() => expect(sentFrames(ws).some((f) => f.t === 'send' && f.text === '첫줄\n둘째줄')).toBe(true));
  });

  it('팔레트가 열려 있으면 Enter는 팔레트 선택(전송·줄바꿈 아님)', async () => {
    const ws = await openWithChannel();
    const i = input();
    act(() => { fireEvent.change(i, { target: { value: '/clear' } }); });
    act(() => { fireEvent.keyDown(i, { key: 'Enter' }); });
    await waitFor(() => expect(sentFrames(ws).some((f) => f.t === 'clearHistory')).toBe(true));
    expect(sentFrames(ws).some((f) => f.t === 'send')).toBe(false);
    expect(i.value).toBe(''); // 전송 텍스트로 남지 않음(팔레트 액션은 입력창을 비운다)
  });

  it('onChange마다 오토사이즈(scrollHeight 기반 height)를 다시 잰다', async () => {
    await openWithChannel();
    const i = input();
    const spy = vi.spyOn(i, 'scrollHeight', 'get').mockReturnValue(84);
    act(() => { fireEvent.change(i, { target: { value: '여러줄\n텍스트\n입니다' } }); });
    expect(i.style.height).toBe('84px');
    spy.mockRestore();
  });

  it('전송 후 높이가 리셋된다(오토사이즈 재계산)', async () => {
    const ws = await openWithChannel();
    const i = input();
    const spy = vi.spyOn(i, 'scrollHeight', 'get').mockReturnValue(90);
    act(() => { fireEvent.change(i, { target: { value: '긴 텍스트\n여러 줄' } }); });
    expect(i.style.height).toBe('90px');
    spy.mockRestore();
    const spy2 = vi.spyOn(i, 'scrollHeight', 'get').mockReturnValue(21); // 비워진 뒤 1줄 높이
    act(() => { fireEvent.keyDown(i, { key: 'Enter' }); });
    await waitFor(() => expect(sentFrames(ws).some((f) => f.t === 'send')).toBe(true));
    expect(i.style.height).toBe('21px');
    spy2.mockRestore();
  });
});

describe('생성 중지(Task 4) — 버튼 스왑·Esc·중복 클릭 방지', () => {
  function sendMessage(text: string) {
    const i = input();
    act(() => { fireEvent.change(i, { target: { value: text } }); });
    act(() => { fireEvent.keyDown(i, { key: 'Enter' }); });
  }

  it('대기 중엔 보내기 버튼이 중지(■) 버튼으로 바뀐다', async () => {
    await openWithChannel();
    sendMessage('질문');
    await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: `■ ${T.stopGen}` })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: T.send })).toBeNull();
  });

  it('중지 버튼 클릭 → stopGeneration 프레임을 보내고 버튼이 잠긴다(중복 클릭 방지)', async () => {
    const ws = await openWithChannel();
    sendMessage('질문');
    await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());
    const stopBtn = screen.getByRole('button', { name: `■ ${T.stopGen}` });
    act(() => { fireEvent.click(stopBtn); });
    await waitFor(() => expect(sentFrames(ws).some((f) => f.t === 'stopGeneration' && f.channelId === 'g1')).toBe(true));
    expect(stopBtn).toBeDisabled();
    const beforeCount = sentFrames(ws).filter((f) => f.t === 'stopGeneration').length;
    act(() => { fireEvent.click(stopBtn); }); // 잠긴 상태 — 재클릭해도 프레임 재전송 없음
    expect(sentFrames(ws).filter((f) => f.t === 'stopGeneration').length).toBe(beforeCount);
  });

  it('중단 안내(msg) 도착 시 버튼이 보내기로 돌아오고 잠금도 풀린다', async () => {
    const ws = await openWithChannel();
    sendMessage('질문');
    await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());
    act(() => { fireEvent.click(screen.getByRole('button', { name: `■ ${T.stopGen}` })); });
    act(() => {
      ws.onmessage!({ data: JSON.stringify({ t: 'msg', channelId: 'g1', message: { id: 'r1', authorId: 'engram', text: '⏹ Stopped', ts: '2026-01-01T00:00:00Z' } }) });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: T.send })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: `■ ${T.stopGen}` })).toBeNull();
  });

  it('대기 중 Esc는 stopGeneration을 보낸다(입력창 포커스 여부 무관, window 레벨)', async () => {
    const ws = await openWithChannel();
    sendMessage('질문');
    await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    await waitFor(() => expect(sentFrames(ws).some((f) => f.t === 'stopGeneration' && f.channelId === 'g1')).toBe(true));
  });

  it('대기 중이 아니면 Esc가 아무 프레임도 안 보낸다', async () => {
    const ws = await openWithChannel();
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(sentFrames(ws).some((f) => f.t === 'stopGeneration')).toBe(false);
  });

  it('팔레트가 열려 있으면 Esc는 팔레트만 닫고(중지 프레임 없음) — 대기 중이어도', async () => {
    const ws = await openWithChannel();
    sendMessage('질문');
    await waitFor(() => expect(screen.getByText(T.thinking)).toBeInTheDocument());
    const i = input();
    act(() => { fireEvent.change(i, { target: { value: '/' } }); });
    act(() => { fireEvent.keyDown(i, { key: 'Escape' }); });
    expect(sentFrames(ws).some((f) => f.t === 'stopGeneration')).toBe(false);
  });
});
