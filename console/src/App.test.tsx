import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from './App';

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); });

it('미설정 상태=Setup 렌더(코드·아이디·비번 3필드)', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ configured: false, oidc: false }), { status: 200 }),
  );
  render(<App />);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Create server' })).toBeInTheDocument());
  expect(screen.getByLabelText('Setup code')).toBeInTheDocument();
  expect(screen.getByLabelText('ID')).toBeInTheDocument();
  expect(screen.getByLabelText('Password')).toBeInTheDocument();
});

it('setup 성공 시 Overview 전환+토큰 저장', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ configured: false, oidc: false }), { status: 200 })) // /auth/status
    .mockResolvedValueOnce(new Response(JSON.stringify({
      token: 'tok1', user: { id: 'u1', displayName: 'Owner', role: 'owner' },
    }), { status: 200 })) // /auth/setup
    .mockResolvedValue(new Response(JSON.stringify({
      members: 1, pendingMembers: 0, channels: 0, wikiPages: 0, pendingProposals: 0, todayMessages: 0,
      pendingMemberNames: [], pendingProposalTitles: [],
    }), { status: 200 })); // /admin/api/overview (이후 호출 전부)

  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('Setup code')).toBeInTheDocument());

  fireEvent.change(screen.getByLabelText('Setup code'), { target: { value: '9059-405f-5740' } });
  fireEvent.change(screen.getByLabelText('ID'), { target: { value: 'owner' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw12345' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create server' }));

  await waitFor(() => expect(localStorage.getItem('engram.console.session')).toContain('tok1'));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument());
});

it('configured+무세션=Login', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ configured: true, oidc: false, serverName: 'Our Team Server' }), { status: 200 }),
  );
  render(<App />);
  await waitFor(() => expect(screen.getByText('Sign in to Engram')).toBeInTheDocument());
  expect(screen.getByLabelText('ID')).toBeInTheDocument();
  expect(screen.getByLabelText('Password')).toBeInTheDocument();
});

it('로그인 성공=Overview(타일 4개+처리할 일)', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ configured: true, oidc: false, serverName: 'Our Team Server' }), { status: 200 })) // /auth/status
    .mockResolvedValueOnce(new Response(JSON.stringify({
      token: 'tok2', user: { id: 'u2', displayName: 'Owner', role: 'owner' },
    }), { status: 200 })) // /auth/login
    .mockResolvedValue(new Response(JSON.stringify({
      members: 3, pendingMembers: 2, channels: 5, wikiPages: 12, pendingProposals: 1, todayMessages: 148,
      pendingMemberNames: ['Alice', 'Bob'], pendingProposalTitles: ['New feature'],
    }), { status: 200 })); // /admin/api/overview

  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('ID')).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('ID'), { target: { value: 'owner' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

  await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument());
  expect(screen.getByText('5')).toBeInTheDocument();
  expect(screen.getByText('12')).toBeInTheDocument();
  expect(screen.getByText('148')).toBeInTheDocument();
  expect(screen.getByText('To-do')).toBeInTheDocument();
  expect(screen.getByText('2 pending members')).toBeInTheDocument();
  expect(screen.getByText('1 pending wiki proposals')).toBeInTheDocument();
  expect(screen.getByText('Alice, Bob')).toBeInTheDocument();
  expect(screen.getByText('New feature')).toBeInTheDocument();
});

it('api 401 응답=Login 복귀', async () => {
  localStorage.setItem('engram.console.session', JSON.stringify({
    token: 'expired', user: { id: 'u3', displayName: 'Owner', role: 'owner' },
  }));
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ configured: true, oidc: false, serverName: 'Our Team Server' }), { status: 200 })) // /auth/status
    .mockResolvedValue(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })); // /admin/api/overview

  render(<App />);
  await waitFor(() => expect(screen.getByText('Sign in to Engram')).toBeInTheDocument());
  expect(localStorage.getItem('engram.console.session')).toBeNull();
});
