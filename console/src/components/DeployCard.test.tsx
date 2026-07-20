import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DeployCard } from './DeployCard';

afterEach(() => { vi.restoreAllMocks(); });

it('다운로드 버튼 클릭 → GET /admin/api/preset 후 임시 <a>.click()으로 저장 트리거', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url === '/admin/api/preset') {
      return new Response(JSON.stringify({ name: 'Our Team', endpoint: 'http://192.168.0.9:47800' }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="preset.json"' },
      });
    }
    return new Response(JSON.stringify({ error: 'unhandled: ' + url }), { status: 404 });
  });

  // jsdom엔 URL.createObjectURL이 구현돼 있지 않다 — 다운로드 트리거만 검증할 수 있게 최소 스텁.
  const createObjectURL = vi.fn(() => 'blob:mock-url');
  const revokeObjectURL = vi.fn();
  (URL as unknown as { createObjectURL: typeof createObjectURL }).createObjectURL = createObjectURL;
  (URL as unknown as { revokeObjectURL: typeof revokeObjectURL }).revokeObjectURL = revokeObjectURL;

  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

  render(<DeployCard />);
  fireEvent.click(screen.getByRole('button', { name: 'Download preset.json' }));

  await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/admin/api/preset', expect.anything()));
  await waitFor(() => expect(clickSpy).toHaveBeenCalled());
  expect(createObjectURL).toHaveBeenCalled();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
});
