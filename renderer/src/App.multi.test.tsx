import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import App from './App';
import { saveConnections } from './connections';

// Task 2 패턴과 동일한 최소 모의 소켓 — url로 인스턴스 식별.
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
  msg(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

beforeEach(() => {
  localStorage.clear();
  FakeWS.instances = [];
  (globalThis as any).WebSocket = FakeWS as any;
  (FakeWS as any).OPEN = 1;
});

// 두 연결을 시드(App은 마운트 시 loadConnections()로 이 상태를 읽는다).
function seedTwoConnections() {
  saveConnections({
    connections: [
      { id: 'home', name: 'Home', endpoint: 'ws://home' },
      { id: 'work', name: '회사', endpoint: 'ws://work' },
    ],
    defaultConnId: 'home',
  });
}

it('2연결이 동명 채널을 가지면 논리 채널 1개로 합쳐 보이고, 각 연결의 기록이 머지되어 보인다', async () => {
  seedTwoConnections();
  render(<App />);
  expect(FakeWS.instances).toHaveLength(2);
  const [homeWS, workWS] = FakeWS.instances;
  expect(homeWS.url).toBe('ws://home');
  expect(workWS.url).toBe('ws://work');

  act(() => { homeWS.open(); workWS.open(); });
  act(() => {
    homeWS.msg({ t: 'channels', list: [{ id: 'h1', name: '일반', respondMode: 'all', mode: 'chat' }] });
    workWS.msg({ t: 'channels', list: [{ id: 'w1', name: '일반', respondMode: 'all', mode: 'chat' }] });
  });

  // 논리 채널은 이름 기준으로 하나만 보인다(동명 중복 제거).
  await waitFor(() => expect(screen.getAllByText('# 일반')).toHaveLength(1));

  act(() => {
    homeWS.msg({ t: 'history', channelId: 'h1', messages: [{ id: 'm1', authorId: 'owner', text: 'from home', ts: '2026-01-01T00:00:00Z' }] });
    workWS.msg({ t: 'history', channelId: 'w1', messages: [{ id: 'm2', authorId: 'owner', text: 'from work', ts: '2026-01-01T00:01:00Z' }] });
  });

  // 두 연결의 기록이 머지되어 둘 다 보인다.
  await waitFor(() => {
    expect(screen.getByText('from home')).toBeInTheDocument();
    expect(screen.getByText('from work')).toBeInTheDocument();
  });
});

it('@이름으로 지목하면 그 연결의 소켓으로 send 프레임이 나간다', async () => {
  seedTwoConnections();
  render(<App />);
  const [homeWS, workWS] = FakeWS.instances;

  act(() => { homeWS.open(); workWS.open(); });
  act(() => {
    homeWS.msg({ t: 'channels', list: [{ id: 'h1', name: '일반', respondMode: 'all', mode: 'chat' }] });
    workWS.msg({ t: 'channels', list: [{ id: 'w1', name: '일반', respondMode: 'all', mode: 'chat' }] });
  });
  await waitFor(() => expect(screen.getByText('# 일반')).toBeInTheDocument());

  const input = document.getElementById('input') as HTMLInputElement;
  act(() => { fireEvent.change(input, { target: { value: '@회사 hi' } }); });
  act(() => { fireEvent.keyDown(input, { key: 'Enter' }); });

  await waitFor(() => {
    expect(workWS.sent.some((s) => s.includes('"send"') && s.includes('@회사 hi') && s.includes('"channelId":"w1"'))).toBe(true);
  });
  // home 소켓에는 send 프레임이 안 나갔다(라우팅이 work로만 갔다).
  expect(homeWS.sent.some((s) => s.includes('"send"'))).toBe(false);
});

it('한 연결에 동명(chat/code) 채널이 있으면 서로 다른 id로 풀려 메시지가 뒤섞이지 않는다', async () => {
  seedTwoConnections();
  render(<App />);
  const [homeWS] = FakeWS.instances;

  act(() => { homeWS.open(); });
  act(() => {
    homeWS.msg({
      t: 'channels',
      list: [
        { id: 'chat-1', name: '일반', respondMode: 'all', mode: 'chat' },
        { id: 'code-1', name: '일반', respondMode: 'all', mode: 'code' },
      ],
    });
  });
  await waitFor(() => expect(screen.getByText('# 일반')).toBeInTheDocument());

  // chat 모드: '일반' 히스토리 요청은 chat-1 대상이어야 한다(code-1 아님).
  await waitFor(() => {
    expect(homeWS.sent.some((s) => s.includes('"history"') && s.includes('"channelId":"chat-1"'))).toBe(true);
  });
  expect(homeWS.sent.some((s) => s.includes('"history"') && s.includes('"channelId":"code-1"'))).toBe(false);

  act(() => {
    homeWS.msg({ t: 'history', channelId: 'chat-1', messages: [{ id: 'm1', authorId: 'owner', text: 'chat msg', ts: '2026-01-01T00:00:00Z' }] });
  });
  await waitFor(() => expect(screen.getByText('chat msg')).toBeInTheDocument());

  homeWS.sent = [];
  const input = document.getElementById('input') as HTMLInputElement;
  act(() => { fireEvent.change(input, { target: { value: 'hello chat' } }); });
  act(() => { fireEvent.keyDown(input, { key: 'Enter' }); });

  // chat 모드에서 보낸 send는 chat-1(code-1 아님)로 나가야 한다 — 이름만으로 키를 잡으면 여기서 섞인다.
  await waitFor(() => {
    expect(homeWS.sent.some((s) => s.includes('"send"') && s.includes('"channelId":"chat-1"'))).toBe(true);
  });
  expect(homeWS.sent.some((s) => s.includes('"send"') && s.includes('"channelId":"code-1"'))).toBe(false);
});

it('연결별 에러는 서로 덮어쓰지 않는다(비-기본 연결 에러가 기본 연결 타이틀바를 오염시키지 않음)', async () => {
  seedTwoConnections();
  render(<App />);
  const [homeWS, workWS] = FakeWS.instances;
  act(() => { homeWS.open(); workWS.open(); });

  // work(비-기본) 연결에서만 에러가 나면 기본(home) 연결의 dot 툴팁은 비어 있어야 한다.
  act(() => { workWS.msg({ t: 'error', text: 'work broke' }); });
  await waitFor(() => {
    const dot = document.getElementById('dot');
    expect(dot?.getAttribute('title')).toBe('');
  });

  // home(기본) 연결에서 에러가 나면 그때는 기본 dot 툴팁에 반영된다.
  act(() => { homeWS.msg({ t: 'error', text: 'home broke' }); });
  await waitFor(() => {
    const dot = document.getElementById('dot');
    expect(dot?.getAttribute('title')).toBe('home broke');
  });
});
