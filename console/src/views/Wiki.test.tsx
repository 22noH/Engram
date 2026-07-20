import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Wiki } from './Wiki';

const wikiPayload = {
  remote: { url: 'git@github.com:ourteam/wiki.git', branch: 'main' },
  pages: 12,
  pendingProposals: 1,
};
const membersPayload = { members: [] };

function mockFetch(extra: (url: string, init?: RequestInit) => Response | null = () => null) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const overridden = extra(url, init);
    if (overridden) return overridden;
    if (url === '/admin/api/wiki') return new Response(JSON.stringify(wikiPayload), { status: 200 });
    if (url === '/admin/api/members') return new Response(JSON.stringify(membersPayload), { status: 200 });
    return new Response(JSON.stringify({ error: 'unhandled: ' + url }), { status: 404 });
  });
}

afterEach(() => { vi.restoreAllMocks(); });

it('통계 타일(페이지·승인 대기) + 원격 폼 초기값', async () => {
  mockFetch();
  render(<Wiki serverName="Our Team" role="owner" active="wiki" onNavigate={() => {}} />);

  await waitFor(() => expect(screen.getByText('12')).toBeInTheDocument());
  expect(screen.getByText('1')).toBeInTheDocument();
  expect(screen.getByDisplayValue('git@github.com:ourteam/wiki.git')).toBeInTheDocument();
  expect(screen.getByDisplayValue('main')).toBeInTheDocument();
});

it('원격 저장 → POST {url, branch}', async () => {
  let captured: { url: string; body: unknown } | null = null;
  mockFetch((url, init) => {
    if (url === '/admin/api/wiki/remote' && init?.method === 'POST') {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return null;
  });
  render(<Wiki serverName="Our Team" role="owner" active="wiki" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByDisplayValue('main')).toBeInTheDocument());

  fireEvent.change(screen.getByDisplayValue('git@github.com:ourteam/wiki.git'), {
    target: { value: 'git@github.com:ourteam/wiki2.git' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(captured).not.toBeNull());
  expect(captured).toEqual({
    url: '/admin/api/wiki/remote',
    body: { url: 'git@github.com:ourteam/wiki2.git', branch: 'main' },
  });
});
