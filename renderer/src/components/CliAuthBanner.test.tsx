import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { CliAuthBanner } from './CliAuthBanner';
import { T } from '../i18n';

// CLI 두뇌 로그인 배너 — "물어보기 전에 미리 알려준다"(목업 ①).
// 오경보 금지가 핵심 계약: 판정이 'logged-out'일 때만 뜬다('unknown'은 판단 불가 → 무표시).

type Auth = { provider: string; state: string; detail?: string; fixCommand: string } | null;

function desktop(initial: Auth, over: Record<string, unknown> = {}) {
  const api = {
    cliAuthState: vi.fn(async () => initial),
    cliAuthRefresh: vi.fn(async () => initial),
    onCliAuthChanged: vi.fn((_cb: (s: Auth) => void) => vi.fn()),
    ...over,
  };
  (window as any).engramDesktop = api;
  return api;
}

const loggedOut: Auth = { provider: 'claude-cli', state: 'logged-out', fixCommand: 'claude' };

afterEach(() => {
  delete (window as any).engramDesktop;
  vi.clearAllMocks();
});

async function renderBanner(initial: Auth, over: Record<string, unknown> = {}) {
  const api = desktop(initial, over);
  const r = render(<CliAuthBanner />);
  await act(async () => {}); // 초기 조회(cliAuthState) 반영
  return { api, ...r };
}

describe('CliAuthBanner — 언제 뜨는가', () => {
  it("state='logged-out'이면 배너를 띄운다(provider 문구)", async () => {
    const { container } = await renderBanner(loggedOut);
    expect(container.querySelector('#cliAuthBanner')).toBeInTheDocument();
    expect(screen.getByText(T.cliAuthTitle('Claude CLI'))).toBeInTheDocument();
    expect(screen.getByText(T.cliAuthBody, { exact: false })).toBeInTheDocument();
  });

  it('codex-cli면 Codex 문구로 띄운다', async () => {
    await renderBanner({ provider: 'codex-cli', state: 'logged-out', fixCommand: 'codex login' });
    expect(screen.getByText(T.cliAuthTitle('Codex CLI'))).toBeInTheDocument();
  });

  it("state='unknown'이면 아무것도 안 보인다(오경보 금지)", async () => {
    const { container } = await renderBanner({ provider: 'claude-cli', state: 'unknown', fixCommand: 'claude' });
    expect(container.querySelector('#cliAuthBanner')).toBeNull();
  });

  it("state='logged-in'이면 아무것도 안 보인다", async () => {
    const { container } = await renderBanner({ provider: 'claude-cli', state: 'logged-in', detail: 'a@b.com', fixCommand: 'claude' });
    expect(container.querySelector('#cliAuthBanner')).toBeNull();
  });

  it('null(기본 두뇌가 CLI가 아님)이면 아무것도 안 보인다', async () => {
    const { container } = await renderBanner(null);
    expect(container.querySelector('#cliAuthBanner')).toBeNull();
  });

  it('데스크톱이 아니면(engramDesktop 없음) 조회도 배너도 없다', async () => {
    const { container } = render(<CliAuthBanner />);
    await act(async () => {});
    expect(container.querySelector('#cliAuthBanner')).toBeNull();
  });
});

describe('CliAuthBanner — 상태 변화 구독', () => {
  it('로그인이 회복되면(push) 배너가 저절로 사라진다', async () => {
    let push!: (s: Auth) => void;
    const { container } = await renderBanner(loggedOut, {
      onCliAuthChanged: vi.fn((cb: (s: Auth) => void) => { push = cb; return vi.fn(); }),
    });
    expect(container.querySelector('#cliAuthBanner')).toBeInTheDocument();
    act(() => { push({ provider: 'claude-cli', state: 'logged-in', fixCommand: 'claude' }); });
    expect(container.querySelector('#cliAuthBanner')).toBeNull();
  });

  it('언마운트 시 구독을 반드시 해제한다(반환된 해제 함수 호출)', async () => {
    const off = vi.fn();
    const { unmount } = await renderBanner(loggedOut, { onCliAuthChanged: vi.fn(() => off) });
    expect(off).not.toHaveBeenCalled();
    unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });
});

describe('CliAuthBanner — 닫기', () => {
  it('✕를 누르면 이번 실행에선 사라진다(서버 상태는 안 건드림)', async () => {
    const { container, api } = await renderBanner(loggedOut);
    act(() => { fireEvent.click(screen.getByTitle(T.close)); });
    expect(container.querySelector('#cliAuthBanner')).toBeNull();
    expect(api.cliAuthRefresh).not.toHaveBeenCalled();
  });
});

describe('CliAuthBanner — 해결 방법', () => {
  it('[해결 방법]을 누르면 명령 안내가 펼쳐진다', async () => {
    await renderBanner(loggedOut);
    expect(screen.queryByText(T.cliAuthCopy)).toBeNull();
    act(() => { fireEvent.click(screen.getByText(T.cliAuthHowTo)); });
    expect(screen.getByText(T.cliAuthFixClaude, { exact: false })).toBeInTheDocument();
    expect(screen.getByText('claude')).toBeInTheDocument();
  });

  it('[명령 복사]는 fixCommand를 클립보드에 넣는다', async () => {
    const writeText = vi.fn(async () => {});
    (navigator as any).clipboard = { writeText };
    await renderBanner({ provider: 'codex-cli', state: 'logged-out', fixCommand: 'codex login' });
    act(() => { fireEvent.click(screen.getByText(T.cliAuthHowTo)); });
    await act(async () => { fireEvent.click(screen.getByText(T.cliAuthCopy)); });
    expect(writeText).toHaveBeenCalledWith('codex login');
    expect(screen.getByText(T.cliAuthCopied)).toBeInTheDocument();
    delete (navigator as any).clipboard;
  });

  it('[다시 확인]은 cliAuthRefresh(IPC)를 부르고 결과를 반영한다', async () => {
    const { api, container } = await renderBanner(loggedOut, {
      cliAuthRefresh: vi.fn(async () => ({ provider: 'claude-cli', state: 'logged-in', fixCommand: 'claude' })),
    });
    act(() => { fireEvent.click(screen.getByText(T.cliAuthHowTo)); });
    await act(async () => { fireEvent.click(screen.getByText(T.cliAuthRecheck)); });
    expect(api.cliAuthRefresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(container.querySelector('#cliAuthBanner')).toBeNull());
  });

  it('[다시 확인] 진행 중에는 확인 중 표시로 바뀌고 중복 호출을 막는다', async () => {
    let release!: (s: Auth) => void;
    const { api } = await renderBanner(loggedOut, {
      cliAuthRefresh: vi.fn(() => new Promise<Auth>((r) => { release = r; })),
    });
    act(() => { fireEvent.click(screen.getByText(T.cliAuthHowTo)); });
    act(() => { fireEvent.click(screen.getByText(T.cliAuthRecheck)); });
    const busy = screen.getByText(T.cliAuthChecking);
    expect(busy).toBeInTheDocument();
    act(() => { fireEvent.click(busy); });
    expect(api.cliAuthRefresh).toHaveBeenCalledTimes(1);
    await act(async () => { release(loggedOut); });
  });
});
