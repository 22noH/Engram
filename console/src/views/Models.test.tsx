import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Models } from './Models';

const modelsPayload = {
  default: 'qwen3-8b',
  harness: 'cli',
  models: [
    { key: 'qwen3-8b', provider: 'openai-api', model: 'qwen3:8b', isDefault: true, hasApiKey: false },
    { key: 'claude-api', provider: 'anthropic-api', model: '', isDefault: false, hasApiKey: false },
  ],
};
const membersPayload = { members: [] };

function mockFetch(extra: (url: string, init?: RequestInit) => Response | null = () => null) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const overridden = extra(url, init);
    if (overridden) return overridden;
    if (url === '/admin/api/models') return new Response(JSON.stringify(modelsPayload), { status: 200 });
    if (url === '/admin/api/members') return new Response(JSON.stringify(membersPayload), { status: 200 });
    return new Response(JSON.stringify({ error: 'unhandled: ' + url }), { status: 404 });
  });
}

afterEach(() => { vi.restoreAllMocks(); });

it('목록 렌더: 키·provider·model·기본 배지', async () => {
  mockFetch();
  render(<Models serverName="Our Team" role="owner" active="models" onNavigate={() => {}} />);

  await waitFor(() => expect(screen.getByText('qwen3-8b', { selector: '.n' })).toBeInTheDocument());
  const defaultRow = screen.getByText('qwen3-8b', { selector: '.n' }).closest('.row') as HTMLElement;
  expect(defaultRow.querySelector('.id')?.textContent).toBe('openai-api · qwen3:8b');
  expect(within(defaultRow).getByText('Default')).toBeInTheDocument();

  const otherRow = screen.getByText('claude-api', { selector: '.n' }).closest('.row') as HTMLElement;
  expect(within(otherRow).getByText('Active')).toBeInTheDocument();
});

it('모델 목록 행은 .grp의 직계 자식 .row다(구분선 회귀 방지)', async () => {
  mockFetch();
  const { container } = render(<Models serverName="Our Team" role="owner" active="models" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('qwen3-8b')).toBeInTheDocument());

  const grps = Array.from(container.querySelectorAll('.grp')).filter((g) => g.querySelector('.row'));
  const grp = grps[0];
  const rows = Array.from(grp.children).filter((el) => el.classList.contains('row'));
  expect(rows.length).toBe(2);
  for (const row of rows) expect(row.parentElement).toBe(grp);
});

it('기본 모델 행: 삭제 버튼 비활성(안내 툴팁)', async () => {
  mockFetch();
  render(<Models serverName="Our Team" role="owner" active="models" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('qwen3-8b')).toBeInTheDocument());

  const defaultRow = screen.getByText('qwen3-8b').closest('.row') as HTMLElement;
  expect(within(defaultRow).getByRole('button', { name: 'Delete' })).toBeDisabled();

  const otherRow = screen.getByText('claude-api', { selector: '.n' }).closest('.row') as HTMLElement;
  expect(within(otherRow).getByRole('button', { name: 'Delete' })).not.toBeDisabled();
});

it('기본 모델 select 변경 → POST default', async () => {
  let captured: { url: string; body: unknown } | null = null;
  mockFetch((url, init) => {
    if (url === '/admin/api/models/default' && init?.method === 'POST') {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return null;
  });
  render(<Models serverName="Our Team" role="owner" active="models" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('qwen3-8b')).toBeInTheDocument());

  fireEvent.change(screen.getByDisplayValue('qwen3-8b · qwen3:8b'), { target: { value: 'claude-api' } });

  await waitFor(() => expect(captured).not.toBeNull());
  expect(captured).toEqual({ url: '/admin/api/models/default', body: { key: 'claude-api' } });
});

it('로컬 모델 추가 폼 → POST ollama', async () => {
  let captured: { url: string; body: unknown } | null = null;
  mockFetch((url, init) => {
    if (url === '/admin/api/models/ollama' && init?.method === 'POST') {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return null;
  });
  render(<Models serverName="Our Team" role="owner" active="models" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('qwen3-8b')).toBeInTheDocument());

  fireEvent.change(screen.getByPlaceholderText('qwen3:8b'), { target: { value: 'llama3:8b' } });
  fireEvent.change(screen.getByPlaceholderText('Model name'), { target: { value: 'llama3-8b' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));

  await waitFor(() => expect(captured).not.toBeNull());
  expect(captured).toEqual({ url: '/admin/api/models/ollama', body: { model: 'llama3:8b', name: 'llama3-8b' } });
});

it('삭제 → DELETE 호출(기본 아닌 모델)', async () => {
  const calls: string[] = [];
  mockFetch((url, init) => {
    if (url === '/admin/api/models/claude-api' && init?.method === 'DELETE') {
      calls.push(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return null;
  });
  render(<Models serverName="Our Team" role="owner" active="models" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('claude-api', { selector: '.n' })).toBeInTheDocument());

  const row = screen.getByText('claude-api', { selector: '.n' }).closest('.row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));

  await waitFor(() => expect(calls).toEqual(['/admin/api/models/claude-api']));
});

it('API 키 저장: 성공 후 입력칸이 비워지고, 재조회 응답에서 hasApiKey=true면 목록에 "API key set"이 보인다 — 키 원문은 어디에도 렌더되지 않는다', async () => {
  const secretKey = 'sk-ant-super-secret-value-12345';
  let updated = false;
  let capturedBody: unknown = null;
  mockFetch((url, init) => {
    if (url === '/admin/api/models' && updated) {
      return new Response(JSON.stringify({
        ...modelsPayload,
        models: modelsPayload.models.map((m) => (m.key === 'claude-api' ? { ...m, hasApiKey: true } : m)),
      }), { status: 200 });
    }
    if (url === '/admin/api/models/api-key' && init?.method === 'POST') {
      capturedBody = JSON.parse(String(init.body));
      updated = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return null;
  });
  render(<Models serverName="Our Team" role="owner" active="models" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('claude-api', { selector: '.n' })).toBeInTheDocument());

  const input = screen.getByPlaceholderText('sk-ant-…') as HTMLInputElement;
  expect(input.type).toBe('password');
  fireEvent.change(input, { target: { value: secretKey } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);

  await waitFor(() => expect(capturedBody).toEqual({ apiKey: secretKey }));
  // POST 요청 자체는 apiKey를 실어 보내야(그래야 저장이 되니까) 하지만, 그 값이 응답으로 되돌아오거나
  // 화면 어딘가에 다시 렌더되는 일은 절대 없어야 한다(★보안 핵심).
  await waitFor(() => {
    const row = screen.getByText('claude-api', { selector: '.n' }).closest('.row') as HTMLElement;
    expect(row.querySelector('.id')?.textContent).toBe('anthropic-api · API key set');
  });
  await waitFor(() => expect((screen.getByPlaceholderText('sk-ant-…') as HTMLInputElement).value).toBe(''));
  expect(screen.queryByDisplayValue(secretKey)).not.toBeInTheDocument();
  expect(screen.queryByText(secretKey)).not.toBeInTheDocument();
  expect(document.body.innerHTML.includes(secretKey)).toBe(false);
});
