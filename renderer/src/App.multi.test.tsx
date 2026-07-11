import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import App from './App';
import { saveConnections } from './connections';
import { T } from './i18n';

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

it('연결을 제거하면 그 연결의 채널이 사이드바에서 사라진다(고스트 채널 방지)', async () => {
  seedTwoConnections();
  render(<App />);
  const [homeWS, workWS] = FakeWS.instances;
  act(() => { homeWS.open(); workWS.open(); });
  act(() => {
    homeWS.msg({ t: 'channels', list: [{ id: 'h1', name: '일반', respondMode: 'all', mode: 'chat' }] });
    workWS.msg({ t: 'channels', list: [{ id: 'w1', name: '해외팀', respondMode: 'all', mode: 'chat' }] });
  });
  await waitFor(() => {
    expect(screen.getByText('# 일반')).toBeInTheDocument();
    expect(screen.getByText('# 해외팀')).toBeInTheDocument();
  });

  // Manage Engrams를 열어 work(회사) 연결을 삭제한다.
  fireEvent.click(screen.getByRole('button', { name: /Home/ }));
  fireEvent.click(screen.getByText(/Manage Engrams/));
  const row = screen.getByText('회사').closest('.engramRow') as HTMLElement;
  act(() => { fireEvent.click(row.querySelector('.danger') as HTMLElement); });

  // work 연결의 채널(해외팀)은 사이드바에서 사라지고, home의 채널(일반)은 남아 있어야 한다.
  await waitFor(() => expect(screen.queryByText('# 해외팀')).not.toBeInTheDocument());
  expect(screen.getByText('# 일반')).toBeInTheDocument();
});

it('연결 안 된 대상 연결로 보내면 조용히 버려지지 않고 그 연결 에러란에 안내가 남는다(생각중도 안 뜬다)', async () => {
  saveConnections({
    connections: [
      { id: 'home', name: 'Home', endpoint: 'ws://home' },
      { id: 'work', name: '회사', endpoint: 'ws://work' },
    ],
    defaultConnId: 'work',
  });
  render(<App />);
  const [homeWS, workWS] = FakeWS.instances;
  act(() => { homeWS.open(); }); // work는 열지 않는다(연결 안 됨 상태 유지).
  act(() => {
    homeWS.msg({ t: 'channels', list: [{ id: 'h1', name: '일반', respondMode: 'all', mode: 'chat' }] });
  });
  await waitFor(() => expect(screen.getByText('# 일반')).toBeInTheDocument());

  const input = document.getElementById('input') as HTMLInputElement;
  act(() => { fireEvent.change(input, { target: { value: 'hi' } }); });
  act(() => { fireEvent.keyDown(input, { key: 'Enter' }); });

  // 기본 연결(work)이 안 열려 있으므로: 전송 안 나가고, 그 연결 에러란(dot 툴팁)에 안내가 남는다.
  await waitFor(() => {
    const dot = document.getElementById('dot');
    expect(dot?.getAttribute('title')).toBe(T.notConnected('회사'));
  });
  expect(workWS.sent).toHaveLength(0);
  expect(screen.queryByText(T.thinking)).not.toBeInTheDocument();
});

it('지연 생성 flush는 이름뿐 아니라 모드도 맞아야 한다(동명·타모드 채널로 오발송 금지)', async () => {
  seedTwoConnections();
  render(<App />);
  const [homeWS, workWS] = FakeWS.instances;
  act(() => { homeWS.open(); workWS.open(); });
  act(() => {
    homeWS.msg({ t: 'channels', list: [{ id: 'h1', name: '일반', respondMode: 'all', mode: 'chat' }] });
    workWS.msg({ t: 'channels', list: [] }); // work엔 아직 '일반' 채널이 없다(chat/code 모두).
  });
  await waitFor(() => expect(screen.getByText('# 일반')).toBeInTheDocument());

  // @회사로 지목 → work엔 chat 모드 '일반' 채널이 없으니 createChannel(mode:chat)을 보내고 버퍼링한다.
  const input = document.getElementById('input') as HTMLInputElement;
  act(() => { fireEvent.change(input, { target: { value: '@회사 hi' } }); });
  act(() => { fireEvent.keyDown(input, { key: 'Enter' }); });
  await waitFor(() => {
    expect(workWS.sent.some((s) => s.includes('"createChannel"') && s.includes('"mode":"chat"'))).toBe(true);
  });

  // work가 code 모드의 동명 '일반' 채널만 갖고 응답 → 모드가 다르므로 flush되면 안 된다.
  act(() => {
    workWS.msg({ t: 'channels', list: [{ id: 'w-code', name: '일반', respondMode: 'all', mode: 'code' }] });
  });
  expect(workWS.sent.some((s) => s.includes('"send"'))).toBe(false);

  // work가 이제 chat 모드의 '일반' 채널로 응답 → 그제서야 버퍼링된 send가 그 채널로 flush된다.
  act(() => {
    workWS.msg({
      t: 'channels',
      list: [
        { id: 'w-code', name: '일반', respondMode: 'all', mode: 'code' },
        { id: 'w-chat', name: '일반', respondMode: 'all', mode: 'chat' },
      ],
    });
  });
  await waitFor(() => {
    expect(workWS.sent.some((s) => s.includes('"send"') && s.includes('"channelId":"w-chat"') && s.includes('@회사 hi'))).toBe(true);
  });
  expect(workWS.sent.some((s) => s.includes('"send"') && s.includes('"channelId":"w-code"'))).toBe(false);
});

// Phase 16a: team 탭 전송 배선 — 자가선언 닉네임 대신 계정 인증(authOk) 기준.
it('team 모드에서 로그인된 사용자가 보내면 authorId 없이 send 프레임이 나간다(서버가 스탬프)', async () => {
  seedTwoConnections();
  render(<App />);
  const [homeWS] = FakeWS.instances;
  act(() => { homeWS.open(); });
  act(() => {
    homeWS.msg({ t: 'channels', list: [{ id: 't1', name: '팀', respondMode: 'all', mode: 'team' }] });
    homeWS.msg({ t: 'authOk', user: { id: 'u-alice', displayName: 'Alice', role: 'member' } });
  });

  fireEvent.click(screen.getByText(T.tabTeam));
  await waitFor(() => expect(screen.getByText('# 팀')).toBeInTheDocument());

  const input = document.getElementById('input') as HTMLInputElement;
  act(() => { fireEvent.change(input, { target: { value: 'hi team' } }); });
  act(() => { fireEvent.keyDown(input, { key: 'Enter' }); });

  await waitFor(() => {
    expect(homeWS.sent.some((s) => s.includes('"send"') && s.includes('hi team'))).toBe(true);
  });
  expect(homeWS.sent.some((s) => s.includes('"send"') && s.includes('"authorId"'))).toBe(false);
});

it('team 모드에서 로그인 안 된 상태면 전송이 나가지 않는다(send 프레임 없음)', async () => {
  seedTwoConnections();
  render(<App />);
  const [homeWS] = FakeWS.instances;
  act(() => { homeWS.open(); });
  act(() => {
    homeWS.msg({ t: 'channels', list: [{ id: 't1', name: '팀', respondMode: 'all', mode: 'team' }] });
  });

  fireEvent.click(screen.getByText(T.tabTeam));
  await waitFor(() => expect(screen.getByText('# 팀')).toBeInTheDocument());

  // 로그인(authOk)이 온 적 없다 — meByConn에 이 연결 엔트리가 없는 상태.
  const input = document.getElementById('input') as HTMLInputElement;
  act(() => { fireEvent.change(input, { target: { value: 'hi team' } }); });
  act(() => { fireEvent.keyDown(input, { key: 'Enter' }); });

  expect(homeWS.sent.some((s) => s.includes('"send"'))).toBe(false);
});

it('team 채널은 기본 연결로만 스코프된다 — 다른 연결의 동명 team 채널·기록과 안 섞인다', async () => {
  seedTwoConnections(); // defaultConnId: 'home'
  render(<App />);
  const [homeWS, workWS] = FakeWS.instances;
  act(() => { homeWS.open(); workWS.open(); });
  act(() => {
    homeWS.msg({ t: 'channels', list: [{ id: 'h-team', name: '팀', respondMode: 'all', mode: 'team' }] });
    workWS.msg({ t: 'channels', list: [{ id: 'w-team', name: '팀', respondMode: 'all', mode: 'team' }] });
  });

  fireEvent.click(screen.getByText(T.tabTeam));
  await waitFor(() => expect(screen.getByText('# 팀')).toBeInTheDocument());

  act(() => {
    homeWS.msg({ t: 'history', channelId: 'h-team', messages: [{ id: 'm1', authorId: 'a', text: 'from home team', ts: '2026-01-01T00:00:00Z' }] });
    workWS.msg({ t: 'history', channelId: 'w-team', messages: [{ id: 'm2', authorId: 'b', text: 'from work team', ts: '2026-01-01T00:01:00Z' }] });
  });

  // 기본 연결(home)의 기록만 보이고, work의 동명 team 채널 기록은 섞이지 않는다.
  await waitFor(() => expect(screen.getByText('from home team')).toBeInTheDocument());
  expect(screen.queryByText('from work team')).not.toBeInTheDocument();

  // work 연결에는 team 채널 기록 요청 자체가 나가지 않는다(스코프 밖 — history 폴링 트리거 안 됨).
  expect(workWS.sent.some((s) => s.includes('"history"') && s.includes('"channelId":"w-team"'))).toBe(false);
});

// Phase 14 최종리뷰 Fix#1: fanoutToName이 team 모드에서 전체 연결을 순회하면 동명 team 채널을
// 가진 다른 연결까지 삭제/변경되어 버린다 — viewConns(스코프)로만 나가야 한다.
it('team 모드에서 채널을 삭제하면 스코프된 연결(home)에만 deleteChannel이 나가고, 동명 채널을 가진 다른 연결(work)에는 안 나간다', async () => {
  seedTwoConnections(); // defaultConnId: 'home'
  render(<App />);
  const [homeWS, workWS] = FakeWS.instances;
  act(() => { homeWS.open(); workWS.open(); });
  act(() => {
    homeWS.msg({ t: 'channels', list: [{ id: 'h-team', name: '팀', respondMode: 'all', mode: 'team' }] });
    workWS.msg({ t: 'channels', list: [{ id: 'w-team', name: '팀', respondMode: 'all', mode: 'team' }] });
  });

  fireEvent.click(screen.getByText(T.tabTeam));
  await waitFor(() => expect(screen.getByText('# 팀')).toBeInTheDocument());

  vi.spyOn(window, 'confirm').mockReturnValue(true);
  // ⋯ 메뉴를 열고 삭제를 누른다(Channels.test.tsx와 달리 실제 App을 통해 popmenu를 구동).
  const menuBtn = document.querySelector('#channels .ch .menu') as HTMLElement;
  fireEvent.click(menuBtn);
  const delItem = await screen.findByText(T.delChannel);
  act(() => { fireEvent.click(delItem); });

  await waitFor(() => {
    expect(homeWS.sent.some((s) => s.includes('"deleteChannel"') && s.includes('"id":"h-team"'))).toBe(true);
  });
  // work는 동명(팀) team 채널을 갖고 있지만 스코프 밖 — deleteChannel이 나가면 안 된다.
  expect(workWS.sent.some((s) => s.includes('"deleteChannel"'))).toBe(false);
});

// Phase 15a Task 4: 위키 배선 — Wiki 탭 진입 시 기본 연결로 wikiList/proposalsList 요청, 승인 시 proposalApprove 전송.
it('Wiki 탭 진입 시 기본 연결로 wikiList·proposalsList 요청', async () => {
  seedTwoConnections();
  render(<App />);
  const [homeWS] = FakeWS.instances;
  act(() => { homeWS.open(); });
  fireEvent.click(screen.getByText(T.tabWiki));
  await waitFor(() => {
    expect(homeWS.sent.some((s) => s.includes('"wikiList"'))).toBe(true);
    expect(homeWS.sent.some((s) => s.includes('"proposalsList"'))).toBe(true);
  });
});

it('승인함 제안 승인 시 proposalApprove 전송', async () => {
  seedTwoConnections();
  render(<App />);
  const [homeWS] = FakeWS.instances;
  act(() => { homeWS.open(); });
  fireEvent.click(screen.getByText(T.tabWiki));
  act(() => {
    homeWS.msg({ t: 'proposals', list: [{ id: 'p1', op: 'create', targetSlug: 's1', title: 'P1', category: 'c', payload: 'body', sources: [], importance: 2, confidence: 0.5, reason: 'r' }] });
  });
  fireEvent.click(screen.getByText(/inbox|승인함/i));
  fireEvent.click(screen.getByRole('button', { name: /approve|승인/i }));
  await waitFor(() => expect(homeWS.sent.some((s) => s.includes('"proposalApprove"') && s.includes('"id":"p1"'))).toBe(true));
});
