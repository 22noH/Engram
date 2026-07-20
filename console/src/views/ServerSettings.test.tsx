import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ServerSettings } from './ServerSettings';

const settingsPayload = {
  serverName: '우리팀 서버',
  port: 47800,
  bind: '0.0.0.0',
  exposure: 'lan',
  oidcIssuer: 'https://issuer.example.com',
  oidcClientId: 'client-1',
  hasOidcSecret: true,
  codingMode: 'off',
};
const membersPayload = { members: [] };

function mockFetch(extra: (url: string, init?: RequestInit) => Response | null = () => null) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const overridden = extra(url, init);
    if (overridden) return overridden;
    if (url === '/admin/api/server-settings') return new Response(JSON.stringify(settingsPayload), { status: 200 });
    if (url === '/admin/api/members') return new Response(JSON.stringify(membersPayload), { status: 200 });
    return new Response(JSON.stringify({ error: 'unhandled: ' + url }), { status: 404 });
  });
}

afterEach(() => { vi.restoreAllMocks(); });

it('필드 초기값 로드 + OIDC secret 입력은 type=password + hasOidcSecret이면 "Set" 힌트', async () => {
  mockFetch();
  render(<ServerSettings serverName="Our Team" role="owner" active="settings" onNavigate={() => {}} />);

  await waitFor(() => expect(screen.getByDisplayValue('우리팀 서버')).toBeInTheDocument());
  expect(screen.getByDisplayValue('47800')).toBeInTheDocument();
  expect(screen.getByDisplayValue('Local network (LAN)')).toBeInTheDocument();
  expect(screen.getByDisplayValue('https://issuer.example.com')).toBeInTheDocument();
  expect(screen.getByDisplayValue('client-1')).toBeInTheDocument();

  const secretInput = screen.getByPlaceholderText('OIDC client secret') as HTMLInputElement;
  expect(secretInput.type).toBe('password');
  expect(secretInput.value).toBe(''); // 시크릿 원문은 절대 채워지지 않는다
  expect(screen.getByText('Set')).toBeInTheDocument();
});

it('저장 → POST 페이로드(코딩 허용 off=꺼짐, 시크릿 미입력 시 빈 문자열 유지)', async () => {
  let captured: { url: string; body: unknown } | null = null;
  mockFetch((url, init) => {
    if (url === '/admin/api/server-settings' && init?.method === 'POST') {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return null;
  });
  render(<ServerSettings serverName="Our Team" role="owner" active="settings" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByDisplayValue('우리팀 서버')).toBeInTheDocument());

  fireEvent.change(screen.getByDisplayValue('47800'), { target: { value: '48000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(captured).not.toBeNull());
  const c = captured as unknown as { body: Record<string, unknown> };
  expect(c.body.serverName).toBe('우리팀 서버');
  expect(c.body.port).toBe('48000');
  expect(c.body.exposure).toBe('lan');
  expect(c.body.codingMode).toBe('off');
  expect((c.body.oidc as { clientSecret: string }).clientSecret).toBe('');
  expect((c.body.oidc as { issuer: string }).issuer).toBe('https://issuer.example.com');
});

it('코딩 허용 체크 → codingMode=auto', async () => {
  let captured: { url: string; body: unknown } | null = null;
  mockFetch((url, init) => {
    if (url === '/admin/api/server-settings' && init?.method === 'POST') {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return null;
  });
  render(<ServerSettings serverName="Our Team" role="owner" active="settings" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByDisplayValue('우리팀 서버')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(captured).not.toBeNull());
  expect((captured as unknown as { body: { codingMode: string } }).body.codingMode).toBe('auto');
});

it('OIDC 시크릿 입력 후 저장 → 페이로드에 실리고, 응답 후 입력칸은 비워진다(원문 재노출 금지)', async () => {
  let captured: { url: string; body: unknown } | null = null;
  mockFetch((url, init) => {
    if (url === '/admin/api/server-settings' && init?.method === 'POST') {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return null;
  });
  render(<ServerSettings serverName="Our Team" role="owner" active="settings" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByDisplayValue('우리팀 서버')).toBeInTheDocument());

  const secretInput = screen.getByPlaceholderText('OIDC client secret') as HTMLInputElement;
  fireEvent.change(secretInput, { target: { value: 'new-secret-value' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(captured).not.toBeNull());
  expect((captured as unknown as { body: { oidc: { clientSecret: string } } }).body.oidc.clientSecret).toBe('new-secret-value');
  await waitFor(() => expect((screen.getByPlaceholderText('OIDC client secret') as HTMLInputElement).value).toBe(''));
  expect(screen.queryByDisplayValue('new-secret-value')).not.toBeInTheDocument();
});

it('클라이언트 배포 카드가 서버 설정 화면 하단에 그려진다', async () => {
  mockFetch();
  render(<ServerSettings serverName="Our Team" role="owner" active="settings" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByDisplayValue('우리팀 서버')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Download preset.json' })).toBeInTheDocument();
});
