import { render, screen, waitFor } from '@testing-library/react';
import { Deploy } from './Deploy';

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url === '/admin/api/members') return new Response(JSON.stringify({ members: [] }), { status: 200 });
    return new Response(JSON.stringify({ error: 'unhandled: ' + url }), { status: 404 });
  });
}

afterEach(() => { vi.restoreAllMocks(); });

it('클라이언트 배포 전용 뷰 — DeployCard 재사용(다운로드 버튼 노출)', async () => {
  mockFetch();
  render(<Deploy serverName="Our Team" role="owner" active="deploy" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Download preset.json' })).toBeInTheDocument());
  expect(screen.getByRole('heading', { name: 'Client deploy' })).toBeInTheDocument();
});
