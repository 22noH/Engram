import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Channels } from './Channels';

const channelsPayload = {
  channels: [
    { id: 'c1', name: 'general', mode: 'chat', visibility: 'public', memberCount: 5 },
    { id: 'c2', name: 'exec', mode: 'chat', visibility: 'private', memberCount: 2, brain: 'qwen3-8b' },
  ],
};

function mockFetch(extra: (url: string, init?: RequestInit) => Response | null = () => null) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const overridden = extra(url, init);
    if (overridden) return overridden;
    if (url === '/admin/api/channels') return new Response(JSON.stringify(channelsPayload), { status: 200 });
    return new Response(JSON.stringify({ error: 'unhandled: ' + url }), { status: 404 });
  });
}

afterEach(() => { vi.restoreAllMocks(); });

it('채널 목록 렌더 — 공개/비공개 칩+모델+멤버수', async () => {
  mockFetch();
  render(<Channels serverName="Our Team" role="owner" active="channels" onNavigate={() => {}} />);

  await waitFor(() => expect(screen.getByText('# general')).toBeInTheDocument());
  expect(screen.getByText('# exec')).toBeInTheDocument();
  expect(screen.getByText('Public')).toBeInTheDocument();
  expect(screen.getByText('Private')).toBeInTheDocument();

  const generalRow = screen.getByText('# general').closest('.row') as HTMLElement;
  expect(generalRow.querySelector('.id')?.textContent).toBe('All members · Model: Default');
  const execRow = screen.getByText('# exec').closest('.row') as HTMLElement;
  expect(execRow.querySelector('.id')?.textContent).toBe('2 members · Model: qwen3-8b');
});

it('visibility 전환 → POST 페이로드', async () => {
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

it('삭제 → DELETE', async () => {
  const calls: string[] = [];
  mockFetch((url, init) => {
    if (url === '/admin/api/channels/c2' && init?.method === 'DELETE') {
      calls.push(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return null;
  });
  render(<Channels serverName="Our Team" role="owner" active="channels" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('# exec')).toBeInTheDocument());

  const row = screen.getByText('# exec').closest('.row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));

  await waitFor(() => expect(calls).toEqual(['/admin/api/channels/c2']));
});
