import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Channels } from './Channels';

const channelsPayload = {
  channels: [
    { id: 'c1', name: 'general', mode: 'chat', visibility: 'public', memberCount: 5, groups: [] },
    { id: 'c2', name: 'design', mode: 'chat', visibility: 'private', memberCount: 0, brain: 'qwen3-8b', groups: ['디자인팀'] },
    { id: 'c3', name: 'exec', mode: 'chat', visibility: 'private', memberCount: 2, groups: [] },
  ],
};
const groupsPayload = {
  groups: [
    { id: 'g1', name: '디자인팀', memberIds: [], permissions: [], channelIds: ['c2'], createdAt: '' },
    { id: 'g2', name: '개발팀', memberIds: [], permissions: [], channelIds: [], createdAt: '' },
  ],
};
const membersPayload = {
  members: [
    { id: 'm1', loginId: 'jiyeon', displayName: 'Jiyeon', role: 'member', status: 'active', permissions: [], groups: [] },
    { id: 'm2', loginId: 'haneul', displayName: 'Haneul', role: 'member', status: 'active', permissions: [], groups: [] },
  ],
};
const channelDetail = {
  c2: { id: 'c2', name: 'design', visibility: 'private', memberIds: [], groupIds: ['g1'] },
  c3: { id: 'c3', name: 'exec', visibility: 'private', memberIds: ['m1'], groupIds: [] },
};

function mockFetch(extra: (url: string, init?: RequestInit) => Response | null = () => null) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const overridden = extra(url, init);
    if (overridden) return overridden;
    if (url === '/admin/api/channels') return new Response(JSON.stringify(channelsPayload), { status: 200 });
    if (url === '/admin/api/groups') return new Response(JSON.stringify(groupsPayload), { status: 200 });
    if (url === '/admin/api/members') return new Response(JSON.stringify(membersPayload), { status: 200 });
    if (url === '/admin/api/channels/c2') return new Response(JSON.stringify(channelDetail.c2), { status: 200 });
    if (url === '/admin/api/channels/c3') return new Response(JSON.stringify(channelDetail.c3), { status: 200 });
    return new Response(JSON.stringify({ error: 'unhandled: ' + url }), { status: 404 });
  });
}

afterEach(() => { vi.restoreAllMocks(); });

it('3단계 배지: 공개/그룹 한정(groups.length>0)/비공개(groups.length===0)', async () => {
  mockFetch();
  render(<Channels serverName="Our Team" role="owner" active="channels" onNavigate={() => {}} />);

  await waitFor(() => expect(screen.getByText('# general')).toBeInTheDocument());
  const generalRow = screen.getByText('# general').closest('.row') as HTMLElement;
  expect(within(generalRow).getByText('Public')).toBeInTheDocument();

  const designRow = screen.getByText('# design').closest('.row') as HTMLElement;
  expect(within(designRow).getByText('Group-limited')).toBeInTheDocument();
  expect(designRow.querySelector('.id')?.textContent).toBe('디자인팀 · Model: qwen3-8b');

  const execRow = screen.getByText('# exec').closest('.row') as HTMLElement;
  expect(within(execRow).getByText('Private')).toBeInTheDocument();
  expect(execRow.querySelector('.id')?.textContent).toBe('2 members · Model: Default');
});

it('모델 버튼은 항상 비활성', async () => {
  mockFetch();
  render(<Channels serverName="Our Team" role="owner" active="channels" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('# general')).toBeInTheDocument());

  for (const name of ['# general', '# design', '# exec']) {
    const row = screen.getByText(name).closest('.row') as HTMLElement;
    expect(within(row).getByRole('button', { name: 'Model' })).toBeDisabled();
  }
});

it('공개 채널만 "비공개 전환" 버튼 → POST visibility', async () => {
  let captured: { url: string; body: unknown } | null = null;
  mockFetch((url, init) => {
    if (url === '/admin/api/channels/c1/visibility' && init?.method === 'POST') {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return null;
  });
  render(<Channels serverName="Our Team" role="owner" active="channels" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('# general')).toBeInTheDocument());

  const row = screen.getByText('# general').closest('.row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Make private' }));

  await waitFor(() => expect(captured).not.toBeNull());
  expect(captured).toEqual({ url: '/admin/api/channels/c1/visibility', body: { visibility: 'private' } });
});

it('그룹 한정 채널: "접근" 편집 → 그룹 다중선택 → 저장 시 POST groups 페이로드', async () => {
  let captured: { url: string; body: unknown } | null = null;
  mockFetch((url, init) => {
    if (url === '/admin/api/channels/c2/groups' && init?.method === 'POST') {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return null;
  });
  render(<Channels serverName="Our Team" role="owner" active="channels" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('# design')).toBeInTheDocument());

  const row = screen.getByText('# design').closest('.row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Access' }));

  // 편집기가 GET 채널 상세로 채운 초기 선택(g1)을 보여준다 — 여기에 g2(개발팀)를 추가.
  await waitFor(() => expect(screen.getByLabelText('디자인팀')).toBeChecked());
  fireEvent.click(screen.getByLabelText('개발팀'));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(captured).not.toBeNull());
  const c = captured as unknown as { url: string; body: { groupIds: string[] } };
  expect(c.url).toBe('/admin/api/channels/c2/groups');
  expect(c.body.groupIds.sort()).toEqual(['g1', 'g2']);
});

it('비공개 채널: "멤버"·"접근" 둘 다 노출(합집합 모델) — "멤버" 편집 → 저장 시 POST members 페이로드', async () => {
  let captured: { url: string; body: unknown } | null = null;
  mockFetch((url, init) => {
    if (url === '/admin/api/channels/c3/members' && init?.method === 'POST') {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return null;
  });
  render(<Channels serverName="Our Team" role="owner" active="channels" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('# exec')).toBeInTheDocument());

  const row = screen.getByText('# exec').closest('.row') as HTMLElement;
  expect(within(row).getByRole('button', { name: 'Members' })).toBeInTheDocument();
  expect(within(row).getByRole('button', { name: 'Access' })).toBeInTheDocument();

  fireEvent.click(within(row).getByRole('button', { name: 'Members' }));
  await waitFor(() => expect(screen.getByLabelText('Jiyeon')).toBeChecked());
  fireEvent.click(screen.getByLabelText('Haneul'));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(captured).not.toBeNull());
  const c = captured as unknown as { url: string; body: { memberIds: string[] } };
  expect(c.url).toBe('/admin/api/channels/c3/members');
  expect(c.body.memberIds.sort()).toEqual(['m1', 'm2']);
});

it('삭제 → 확인 후 DELETE', async () => {
  const calls: string[] = [];
  mockFetch((url, init) => {
    if (url === '/admin/api/channels/c3' && init?.method === 'DELETE') {
      calls.push(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return null;
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<Channels serverName="Our Team" role="owner" active="channels" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('# exec')).toBeInTheDocument());

  const row = screen.getByText('# exec').closest('.row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));

  await waitFor(() => expect(calls).toEqual(['/admin/api/channels/c3']));
  expect(window.confirm).toHaveBeenCalled();
});
