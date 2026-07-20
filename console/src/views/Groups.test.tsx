import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Groups } from './Groups';

const groupsPayload = {
  groups: [
    {
      id: 'g1', name: '디자인팀', memberIds: ['m1'], permissions: ['wiki.edit'],
      channelIds: ['c1'], createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'g2', name: '유령그룹', memberIds: [], permissions: [], channelIds: ['deleted-channel'], createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
};
const membersPayload = {
  members: [
    { id: 'm1', loginId: 'jiyeon', displayName: 'Jiyeon', role: 'member', status: 'active', permissions: [], groups: [] },
    { id: 'm2', loginId: 'haneul', displayName: 'Haneul', role: 'member', status: 'active', permissions: [], groups: [] },
  ],
};
const channelsPayload = {
  channels: [
    { id: 'c1', name: 'design', mode: 'chat', visibility: 'public', memberCount: 3 },
    { id: 'c2', name: 'general', mode: 'chat', visibility: 'public', memberCount: 5 },
  ],
};

function mockFetch(extra: (url: string, init?: RequestInit) => Response | null = () => null) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const overridden = extra(url, init);
    if (overridden) return overridden;
    if (url === '/admin/api/groups') return new Response(JSON.stringify(groupsPayload), { status: 200 });
    if (url === '/admin/api/members') return new Response(JSON.stringify(membersPayload), { status: 200 });
    if (url === '/admin/api/channels') return new Response(JSON.stringify(channelsPayload), { status: 200 });
    return new Response(JSON.stringify({ error: 'unhandled: ' + url }), { status: 404 });
  });
}

afterEach(() => { vi.restoreAllMocks(); });

it('목록 렌더 + 편집 폼: 멤버·채널 칩(삭제된 채널 id는 조용히 무시)', async () => {
  mockFetch();
  render(<Groups serverName="Our Team" role="owner" active="groups" onNavigate={() => {}} />);

  await waitFor(() => expect(screen.getByText('디자인팀')).toBeInTheDocument());
  expect(screen.getByText('유령그룹')).toBeInTheDocument();

  fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Jiyeon ✕' })).toBeInTheDocument());
  expect(screen.getByRole('button', { name: '# design ✕' })).toBeInTheDocument();

  // 유령그룹(채널이 삭제됨) 편집해도 크래시 없이 칩이 그냥 안 그려진다.
  fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]);
  await waitFor(() => expect(screen.getByText('Edit 유령그룹')).toBeInTheDocument());
  expect(screen.queryByRole('button', { name: /✕$/ })).not.toBeInTheDocument();
});

it('그룹 편집(멤버·권한·채널 변경) → 저장 시 PATCH 페이로드', async () => {
  let captured: { url: string; body: unknown } | null = null;
  mockFetch((url, init) => {
    if (url === '/admin/api/groups/g1' && init?.method === 'PATCH') {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ group: groupsPayload.groups[0] }), { status: 200 });
    }
    return null;
  });
  render(<Groups serverName="Our Team" role="owner" active="groups" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('디자인팀')).toBeInTheDocument());

  fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Jiyeon ✕' })).toBeInTheDocument());

  // 멤버 추가: Haneul
  fireEvent.click(screen.getByRole('button', { name: '+ Add' }));
  fireEvent.change(screen.getByDisplayValue('Choose a member…'), { target: { value: 'm2' } });

  // 권한 추가: 채널 관리
  fireEvent.click(screen.getByLabelText('Manage channels'));

  // 채널 추가: general
  fireEvent.click(screen.getByRole('button', { name: '+ Add channel' }));
  fireEvent.change(screen.getByDisplayValue('Choose a channel…'), { target: { value: 'c2' } });

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(captured).not.toBeNull());
  const c = captured as unknown as {
    url: string;
    body: { name: string; memberIds: string[]; permissions: string[]; channelIds: string[] };
  };
  expect(c.url).toBe('/admin/api/groups/g1');
  expect(c.body.name).toBe('디자인팀');
  expect(c.body.memberIds.sort()).toEqual(['m1', 'm2']);
  expect(c.body.permissions.sort()).toEqual(['channels.manage', 'wiki.edit']);
  expect(c.body.channelIds.sort()).toEqual(['c1', 'c2']);
});

it('그룹 설명줄(.id)은 font-family:inherit 스타일이 있다(픽셀 리뷰 fix #2 — mono 상속 방지)', async () => {
  mockFetch();
  render(<Groups serverName="Our Team" role="owner" active="groups" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('디자인팀')).toBeInTheDocument());

  const row = screen.getByText('디자인팀').closest('.row') as HTMLElement;
  const idEl = row.querySelector('.id') as HTMLElement;
  expect(idEl.style.fontFamily).toBe('inherit');
});

it('Nav 멤버 뱃지: Groups 화면도 가입 대기 수를 보여준다(픽셀 리뷰 fix #4)', async () => {
  mockFetch((url) => {
    if (url === '/admin/api/members') {
      return new Response(JSON.stringify({
        members: [
          ...membersPayload.members,
          { id: 'm3', loginId: 'minsu', displayName: 'Minsu', role: 'member', status: 'pending', permissions: [], groups: [] },
        ],
      }), { status: 200 });
    }
    return null;
  });
  const { container } = render(<Groups serverName="Our Team" role="owner" active="groups" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('디자인팀')).toBeInTheDocument());

  const badge = await waitFor(() => container.querySelector('.nitem .nbadge') as HTMLElement);
  expect(badge).toBeTruthy();
  expect(badge.textContent).toBe('1');
});

it('그룹 만들기 폼 제출 → POST 페이로드', async () => {
  let captured: { url: string; body: unknown } | null = null;
  mockFetch((url, init) => {
    if (url === '/admin/api/groups' && init?.method === 'POST') {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({
        group: { id: 'g3', name: 'QA팀', memberIds: [], permissions: [], channelIds: [], createdAt: '' },
      }), { status: 200 });
    }
    return null;
  });
  render(<Groups serverName="Our Team" role="owner" active="groups" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('디자인팀')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: '+ Create group' }));
  fireEvent.change(screen.getByPlaceholderText('Group name'), { target: { value: 'QA팀' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));

  await waitFor(() => expect(captured).not.toBeNull());
  expect((captured as unknown as { body: { name: string } }).body.name).toBe('QA팀');
});
