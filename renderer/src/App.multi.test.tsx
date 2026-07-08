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
