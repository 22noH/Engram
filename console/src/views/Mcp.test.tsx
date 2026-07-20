import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Mcp } from './Mcp';

const mcpPayload = {
  servers: [
    { name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    { name: 'notion', url: 'https://mcp.notion.com/mcp' },
    { name: 'claude-mirrored', command: 'npx', args: ['-y', 'something'], source: 'claude' },
  ],
};
const membersPayload = { members: [] };

function mockFetch(extra: (url: string, init?: RequestInit) => Response | null = () => null) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const overridden = extra(url, init);
    if (overridden) return overridden;
    if (url === '/admin/api/mcp') return new Response(JSON.stringify(mcpPayload), { status: 200 });
    if (url === '/admin/api/members') return new Response(JSON.stringify(membersPayload), { status: 200 });
    return new Response(JSON.stringify({ error: 'unhandled: ' + url }), { status: 404 });
  });
}

afterEach(() => { vi.restoreAllMocks(); });

it('목록 렌더: 이름·command(args 결합)·url', async () => {
  mockFetch();
  render(<Mcp serverName="Our Team" role="owner" active="mcp" onNavigate={() => {}} />);

  await waitFor(() => expect(screen.getByText('github')).toBeInTheDocument());
  const ghRow = screen.getByText('github').closest('.row') as HTMLElement;
  expect(within(ghRow).getByText('npx -y @modelcontextprotocol/server-github')).toBeInTheDocument();

  const notionRow = screen.getByText('notion').closest('.row') as HTMLElement;
  expect(within(notionRow).getByText('https://mcp.notion.com/mcp')).toBeInTheDocument();
});

it('MCP 목록 행은 .grp의 직계 자식 .row다(구분선 회귀 방지)', async () => {
  mockFetch();
  const { container } = render(<Mcp serverName="Our Team" role="owner" active="mcp" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('github')).toBeInTheDocument());

  const grp = Array.from(container.querySelectorAll('.grp')).find((g) => g.querySelector('.row')) as HTMLElement;
  const rows = Array.from(grp.children).filter((el) => el.classList.contains('row'));
  expect(rows.length).toBe(3);
  for (const row of rows) expect(row.parentElement).toBe(grp);
});

it('source=claude 항목은 ⊖ 없이 "Managed by Claude"만 보인다', async () => {
  mockFetch();
  render(<Mcp serverName="Our Team" role="owner" active="mcp" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('claude-mirrored')).toBeInTheDocument());

  const row = screen.getByText('claude-mirrored').closest('.row') as HTMLElement;
  expect(within(row).queryByRole('button', { name: '⊖' })).not.toBeInTheDocument();
  expect(within(row).getByText('Managed by Claude')).toBeInTheDocument();

  const ghRow = screen.getByText('github').closest('.row') as HTMLElement;
  expect(within(ghRow).getByRole('button', { name: '⊖' })).toBeInTheDocument();
});

it('추가 폼 제출 → POST {name, commandOrUrl}', async () => {
  let captured: { url: string; body: unknown } | null = null;
  mockFetch((url, init) => {
    if (url === '/admin/api/mcp' && init?.method === 'POST') {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return null;
  });
  render(<Mcp serverName="Our Team" role="owner" active="mcp" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('github')).toBeInTheDocument());

  fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'linear' } });
  fireEvent.change(screen.getByPlaceholderText('npx -y … or https://…'), { target: { value: 'https://mcp.linear.app/sse' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));

  await waitFor(() => expect(captured).not.toBeNull());
  expect(captured).toEqual({
    url: '/admin/api/mcp',
    body: { name: 'linear', commandOrUrl: 'https://mcp.linear.app/sse' },
  });
});

it('⊖ 클릭 → DELETE 호출', async () => {
  const calls: string[] = [];
  mockFetch((url, init) => {
    if (url === '/admin/api/mcp/github' && init?.method === 'DELETE') {
      calls.push(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return null;
  });
  render(<Mcp serverName="Our Team" role="owner" active="mcp" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('github')).toBeInTheDocument());

  const row = screen.getByText('github').closest('.row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: '⊖' }));

  await waitFor(() => expect(calls).toEqual(['/admin/api/mcp/github']));
});
