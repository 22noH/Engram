import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Members } from './Members';

const membersPayload = {
  members: [
    { id: 'u-owner', loginId: '22no', displayName: 'Owner', role: 'owner', status: 'active', permissions: [], groups: [] },
    {
      id: 'u-active', loginId: 'seojun', displayName: 'Seojun', role: 'member', status: 'active',
      permissions: [], groups: ['개발팀'],
    },
    { id: 'u-susp', loginId: 'haneul', displayName: 'Haneul', role: 'member', status: 'suspended', permissions: [], groups: [] },
    { id: 'u-pend', loginId: 'minsu', displayName: 'Minsu', role: 'member', status: 'pending', permissions: [], groups: [] },
  ],
};
const groupsPayload = { groups: [{ id: 'g1', name: '개발팀', memberIds: [], permissions: [], channelIds: [], createdAt: '' }] };

function mockFetch(extra: (url: string, init?: RequestInit) => Response | null = () => null) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const overridden = extra(url, init);
    if (overridden) return overridden;
    if (url === '/admin/api/members') return new Response(JSON.stringify(membersPayload), { status: 200 });
    if (url === '/admin/api/groups') return new Response(JSON.stringify(groupsPayload), { status: 200 });
    return new Response(JSON.stringify({ error: 'unhandled: ' + url }), { status: 404 });
  });
}

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it('목록 렌더 — 가입 대기·멤버(owner/활성/정지) 섹션', async () => {
  mockFetch();
  render(<Members serverName="Our Team" role="owner" active="members" onNavigate={() => {}} />);

  await waitFor(() => expect(screen.getByText('Minsu')).toBeInTheDocument());
  expect(screen.getByText('Me (server owner)')).toBeInTheDocument();
  expect(screen.getByText('Seojun')).toBeInTheDocument();
  expect(screen.getByText('Haneul')).toBeInTheDocument();
  expect(screen.getByText('개발팀')).toBeInTheDocument();
  expect(screen.getByText('owner')).toBeInTheDocument();
});

it('owner 자기 행에는 파괴적 버튼(비번 리셋·정지·거절)이 없다 — 권한만', async () => {
  mockFetch();
  render(<Members serverName="Our Team" role="owner" active="members" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('Me (server owner)')).toBeInTheDocument());

  const ownerRow = screen.getByText('Me (server owner)').closest('.row') as HTMLElement;
  expect(within(ownerRow).getByRole('button', { name: 'Permissions' })).toBeInTheDocument();
  expect(within(ownerRow).queryByRole('button', { name: 'Reset password' })).not.toBeInTheDocument();
  expect(within(ownerRow).queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument();
});

it('멤버 추가 폼 제출 → POST /admin/api/members 페이로드', async () => {
  let captured: { url: string; body: unknown } | null = null;
  mockFetch((url, init) => {
    if (url === '/admin/api/members' && init?.method === 'POST') {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({
        member: { id: 'new1', loginId: 'newbie', displayName: 'New', role: 'member', status: 'active', permissions: [], groups: [] },
      }), { status: 200 });
    }
    return null;
  });
  render(<Members serverName="Our Team" role="owner" active="members" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('Minsu')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: '+ Add member' }));
  fireEvent.change(screen.getByPlaceholderText('ID'), { target: { value: 'newbie' } });
  fireEvent.change(screen.getByPlaceholderText('Display name'), { target: { value: 'New' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));

  await waitFor(() => expect(captured).not.toBeNull());
  const c = captured as unknown as { url: string; body: { loginId: string; displayName: string; password: string } };
  expect(c.url).toBe('/admin/api/members');
  expect(c.body.loginId).toBe('newbie');
  expect(c.body.displayName).toBe('New');
  expect(c.body.password).toMatch(/^init-/); // 클라이언트가 자동 생성한 임시 비밀번호
});

it('승인 → status POST / 정지 → status POST', async () => {
  const calls: { url: string; body: unknown }[] = [];
  mockFetch((url, init) => {
    if (/\/admin\/api\/members\/.+\/status$/.test(url) && init?.method === 'POST') {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return null;
  });
  render(<Members serverName="Our Team" role="owner" active="members" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('Minsu')).toBeInTheDocument());

  const pendingRow = screen.getByText('Minsu').closest('.row') as HTMLElement;
  fireEvent.click(within(pendingRow).getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toEqual({ url: '/admin/api/members/u-pend/status', body: { status: 'active' } });

  const activeRow = screen.getByText('Seojun').closest('.row') as HTMLElement;
  fireEvent.click(within(activeRow).getByRole('button', { name: 'Suspend' }));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]).toEqual({ url: '/admin/api/members/u-active/status', body: { status: 'suspended' } });
});

it('거절 → 확인 후 DELETE /admin/api/members/:id', async () => {
  const calls: string[] = [];
  mockFetch((url, init) => {
    if (url === '/admin/api/members/u-pend' && init?.method === 'DELETE') {
      calls.push(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return null;
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<Members serverName="Our Team" role="owner" active="members" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('Minsu')).toBeInTheDocument());

  const pendingRow = screen.getByText('Minsu').closest('.row') as HTMLElement;
  fireEvent.click(within(pendingRow).getByRole('button', { name: 'Reject' }));

  await waitFor(() => expect(calls).toEqual(['/admin/api/members/u-pend']));
  expect(window.confirm).toHaveBeenCalled();
});

it('거절 확인창 취소 → DELETE 호출 안 함', async () => {
  let called = false;
  mockFetch((url, init) => {
    if (url === '/admin/api/members/u-pend' && init?.method === 'DELETE') { called = true; }
    return null;
  });
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<Members serverName="Our Team" role="owner" active="members" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('Minsu')).toBeInTheDocument());

  const pendingRow = screen.getByText('Minsu').closest('.row') as HTMLElement;
  fireEvent.click(within(pendingRow).getByRole('button', { name: 'Reject' }));

  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  expect(called).toBe(false);
});

it('비번 리셋 → POST reset-password, 반환된 임시 비번을 인라인으로 표시', async () => {
  mockFetch((url, init) => {
    if (url === '/admin/api/members/u-active/reset-password' && init?.method === 'POST') {
      return new Response(JSON.stringify({ tempPassword: 'temp-xyz9' }), { status: 200 });
    }
    return null;
  });
  render(<Members serverName="Our Team" role="owner" active="members" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('Seojun')).toBeInTheDocument());

  const activeRow = screen.getByText('Seojun').closest('.row') as HTMLElement;
  fireEvent.click(within(activeRow).getByRole('button', { name: 'Reset password' }));

  await waitFor(() => expect(screen.getByText('temp-xyz9')).toBeInTheDocument());
});

it('정지된 멤버는 복구 버튼만', async () => {
  mockFetch();
  render(<Members serverName="Our Team" role="owner" active="members" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('Haneul')).toBeInTheDocument());
  const suspRow = screen.getByText('Haneul').closest('.row') as HTMLElement;
  expect(within(suspRow).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  expect(within(suspRow).queryByRole('button', { name: 'Permissions' })).not.toBeInTheDocument();
});
