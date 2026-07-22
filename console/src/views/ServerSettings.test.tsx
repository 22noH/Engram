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
  retention: { mode: 'unlimited' },
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

it('저장 → POST 페이로드(codingMode 안 건드리면 안 실림, 시크릿 미입력 시 빈 문자열 유지)', async () => {
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

  // 서버 이름 등 코딩 허용과 무관한 필드만 바꿔 저장 — codingMode select는 건드리지 않았다.
  fireEvent.change(screen.getByDisplayValue('47800'), { target: { value: '48000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(captured).not.toBeNull());
  const c = captured as unknown as { body: Record<string, unknown> };
  expect(c.body.serverName).toBe('우리팀 서버');
  expect(c.body.port).toBe('48000');
  expect(c.body.exposure).toBe('lan');
  // ★핵심 회귀 방지: codingMode를 건드리지 않은 저장은 그 필드 자체를 안 보낸다(allowlist 등
  // 서버에 저장된 값을 무단으로 auto로 강등시키지 않기 위해서 — review Important).
  expect('codingMode' in c.body).toBe(false);
  expect((c.body.oidc as { clientSecret: string }).clientSecret).toBe('');
  expect((c.body.oidc as { issuer: string }).issuer).toBe('https://issuer.example.com');
});

it('코딩 허용 select: 꺼짐/자동/허용목록 3개 옵션을 보여준다', async () => {
  mockFetch();
  render(<ServerSettings serverName="Our Team" role="owner" active="settings" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByDisplayValue('우리팀 서버')).toBeInTheDocument());

  const codingSelect = screen.getByDisplayValue('Off') as HTMLSelectElement; // settingsPayload.codingMode = 'off'
  const optionTexts = Array.from(codingSelect.options).map((o) => o.textContent);
  expect(optionTexts).toEqual(['Off', 'Auto', 'Allowlist']);
});

it('코딩 허용 select에서 허용목록 선택 → 저장 → codingMode=allowlist', async () => {
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

  const codingSelect = screen.getByDisplayValue('Off') as HTMLSelectElement;
  fireEvent.change(codingSelect, { target: { value: 'allowlist' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(captured).not.toBeNull());
  expect((captured as unknown as { body: { codingMode: string } }).body.codingMode).toBe('allowlist');
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

it('대화 보존 select: 3개 프리셋을 보여주고 저장된 mode를 선택한다(값이 프리셋과 달라도 mode로 매칭)', async () => {
  mockFetch((url) => {
    if (url === '/admin/api/server-settings') {
      return new Response(JSON.stringify({ ...settingsPayload, retention: { mode: 'days', value: 45 } }), { status: 200 });
    }
    return null;
  });
  render(<ServerSettings serverName="Our Team" role="owner" active="settings" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByDisplayValue('우리팀 서버')).toBeInTheDocument());

  const retentionSelect = screen.getByDisplayValue('Last 90 days') as HTMLSelectElement;
  const optionTexts = Array.from(retentionSelect.options).map((o) => o.textContent);
  expect(optionTexts).toEqual(['Last 1,000 per channel', 'Last 90 days', 'Unlimited']);
  expect(retentionSelect.value).toBe('days'); // 저장값 value=45는 프리셋(90)과 다르지만 mode로 선택됨
});

it('대화 보존 select에서 "채널당 최근 1,000개" 선택 → 저장 → retention={mode:count,value:1000}', async () => {
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

  const retentionSelect = screen.getByDisplayValue('Unlimited') as HTMLSelectElement; // settingsPayload 기본값
  fireEvent.change(retentionSelect, { target: { value: 'count' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(captured).not.toBeNull());
  expect((captured as unknown as { body: { retention: { mode: string; value: number } } }).body.retention)
    .toEqual({ mode: 'count', value: 1000 });
});

it('보존 select를 안 건드린 저장은 retention 필드 자체를 안 보낸다(비프리셋 값 눌러 프루닝 방지)', async () => {
  // ★핵심 데이터-안전 회귀 방지(최종 리뷰): select는 mode만 추적하고 저장 시 프리셋 값으로 눌러버리므로,
  // 안 건드린 저장이 retention을 실어 보내면 raw API/수동편집으로 넣어둔 비프리셋 값(예: count=5000)을
  // 프리셋(count=1000)으로 조여 초과 대화를 영구 프루닝한다 → codingMode처럼 건드렸을 때만 보낸다.
  let captured: { url: string; body: Record<string, unknown> } | null = null;
  mockFetch((url, init) => {
    if (url === '/admin/api/server-settings' && init?.method === 'POST') {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url === '/admin/api/server-settings') {
      return new Response(JSON.stringify({ ...settingsPayload, retention: { mode: 'count', value: 5000 } }), { status: 200 });
    }
    return null;
  });
  render(<ServerSettings serverName="Our Team" role="owner" active="settings" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByDisplayValue('우리팀 서버')).toBeInTheDocument());

  // 포트만 바꿔 저장 — 보존 select는 건드리지 않았다.
  fireEvent.change(screen.getByDisplayValue('47800'), { target: { value: '48000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(captured).not.toBeNull());
  expect('retention' in (captured as unknown as { body: Record<string, unknown> }).body).toBe(false);
});

// clear-compact Task 6: 자동 정리 토글 — retentionTouched와 완전히 같은 게이트 패턴이므로
// 위 보존 테스트들과 짝을 이룬다(mirror).

it('자동 정리 토글: settingsPayload에 autoCompact 없으면(서버 기본 true) 기본 체크됨', async () => {
  mockFetch();
  render(<ServerSettings serverName="Our Team" role="owner" active="settings" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByDisplayValue('우리팀 서버')).toBeInTheDocument());

  const toggle = screen.getByRole('checkbox') as HTMLInputElement;
  expect(toggle.checked).toBe(true);
});

it('자동 정리 토글: GET이 autoCompact:false를 주면 꺼진 상태로 반영', async () => {
  mockFetch((url) => {
    if (url === '/admin/api/server-settings') {
      return new Response(JSON.stringify({ ...settingsPayload, autoCompact: false }), { status: 200 });
    }
    return null;
  });
  render(<ServerSettings serverName="Our Team" role="owner" active="settings" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByDisplayValue('우리팀 서버')).toBeInTheDocument());

  const toggle = screen.getByRole('checkbox') as HTMLInputElement;
  expect(toggle.checked).toBe(false);
});

it('자동 정리 토글을 꺼서 저장 → 페이로드에 autoCompact:false가 실린다', async () => {
  let captured: { url: string; body: Record<string, unknown> } | null = null;
  mockFetch((url, init) => {
    if (url === '/admin/api/server-settings' && init?.method === 'POST') {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return null;
  });
  render(<ServerSettings serverName="Our Team" role="owner" active="settings" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByDisplayValue('우리팀 서버')).toBeInTheDocument());

  const toggle = screen.getByRole('checkbox') as HTMLInputElement;
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(captured).not.toBeNull());
  expect((captured as unknown as { body: { autoCompact: boolean } }).body.autoCompact).toBe(false);
});

it('자동 정리 토글을 안 건드린 저장은 autoCompact 필드 자체를 안 보낸다(touched 게이트)', async () => {
  // ★retention의 "안 건드린 저장은 필드 자체를 안 보낸다" 회귀 방지 테스트와 동일한 위험을 막는다 —
  // GET이 비기본값(false)을 줬는데 토글을 안 만졌다고 저장이 무조건 true(기본)를 실어 보내면
  // 사용자가 명시적으로 꺼둔 자동정리가 다른 필드(포트 등)만 바꾼 저장에 몰래 다시 켜진다.
  let captured: { url: string; body: Record<string, unknown> } | null = null;
  mockFetch((url, init) => {
    if (url === '/admin/api/server-settings' && init?.method === 'POST') {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url === '/admin/api/server-settings') {
      return new Response(JSON.stringify({ ...settingsPayload, autoCompact: false }), { status: 200 });
    }
    return null;
  });
  render(<ServerSettings serverName="Our Team" role="owner" active="settings" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByDisplayValue('우리팀 서버')).toBeInTheDocument());

  // 포트만 바꿔 저장 — 자동 정리 토글은 건드리지 않았다.
  fireEvent.change(screen.getByDisplayValue('47800'), { target: { value: '48000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(captured).not.toBeNull());
  expect('autoCompact' in (captured as unknown as { body: Record<string, unknown> }).body).toBe(false);
});
