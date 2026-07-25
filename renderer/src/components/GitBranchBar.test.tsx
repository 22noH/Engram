import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { GitBranchBar } from './GitBranchBar';
import { T } from '../i18n';

// 코드 채널 상단 줄(B안) — `⑂ <브랜치>  +<추가>  −<삭제>   [PR 생성]`.
// PR 생성은 push+PR을 즉시 실행하는 되돌리기 어려운 동작이라 확인 단계가 필수다.

function api(over: Record<string, unknown> = {}) {
  const a = {
    gitBranchStatus: vi.fn(async () => ({ ok: true as const, branch: 'feat/x', detached: false, added: 1741, removed: 16, files: 9 })),
    gitCreatePr: vi.fn(async () => ({ ok: true as const, url: 'https://github.com/o/r/pull/7', alreadyExisted: false })),
    ...over,
  };
  (window as any).engramDesktop = a;
  return a;
}

afterEach(() => { delete (window as any).engramDesktop; vi.restoreAllMocks(); });

async function mount(repoPath = 'C:/repo/proj') {
  render(<GitBranchBar repoPath={repoPath} />);
  await waitFor(() => expect(document.querySelector('.gitBranchBar')).toBeInTheDocument());
}

describe('GitBranchBar — 표시', () => {
  it('브랜치·추가·삭제 줄을 그리고 PR 버튼을 둔다', async () => {
    const a = api();
    await mount();
    expect(a.gitBranchStatus).toHaveBeenCalledWith('C:/repo/proj');
    await waitFor(() => expect(screen.getByText(/feat\/x/)).toBeInTheDocument());
    expect(screen.getByText('+1741')).toBeInTheDocument();
    expect(screen.getByText('−16')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: T.prCreate })).toBeInTheDocument();
  });

  it('ok:false(not-repo)면 최소 안내만 남기고 PR 버튼은 없다', async () => {
    api({ gitBranchStatus: vi.fn(async () => ({ ok: false as const, reason: 'not-repo' })) });
    render(<GitBranchBar repoPath="C:/x" />);
    await waitFor(() => expect(screen.getByText(T.codeDiffNotRepo)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: T.prCreate })).toBeNull();
  });

  it('ok:false(git-missing)면 git 미설치 안내', async () => {
    api({ gitBranchStatus: vi.fn(async () => ({ ok: false as const, reason: 'git-missing' })) });
    render(<GitBranchBar repoPath="C:/x" />);
    await waitFor(() => expect(screen.getByText(T.codeDiffGitMissing)).toBeInTheDocument());
  });

  it('ok:false(error)면 줄 자체를 숨긴다', async () => {
    api({ gitBranchStatus: vi.fn(async () => ({ ok: false as const, reason: 'error' })) });
    const { container } = render(<GitBranchBar repoPath="C:/x" />);
    await waitFor(() => expect(container.querySelector('.gitBranchBar')).toBeNull());
  });

  it('refreshKey가 바뀌면 다시 조회한다(메시지 도착 시 갱신)', async () => {
    const a = api();
    const { rerender } = render(<GitBranchBar repoPath="C:/repo/proj" refreshKey={0} />);
    await waitFor(() => expect(a.gitBranchStatus).toHaveBeenCalledTimes(1));
    rerender(<GitBranchBar repoPath="C:/repo/proj" refreshKey={1} />);
    await waitFor(() => expect(a.gitBranchStatus).toHaveBeenCalledTimes(2));
  });

  it('포커스 복귀 시 다시 조회한다(과한 폴링 대신 이벤트 기반)', async () => {
    const a = api();
    await mount();
    await waitFor(() => expect(a.gitBranchStatus).toHaveBeenCalledTimes(1));
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(a.gitBranchStatus).toHaveBeenCalledTimes(2));
  });
});

describe('GitBranchBar — PR 생성 확인 단계(⚠️ 되돌리기 어려운 동작)', () => {
  it('확인을 거절하면 gitCreatePr를 부르지 않는다', async () => {
    const a = api();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: T.prCreate })).toBeInTheDocument());
    act(() => { fireEvent.click(screen.getByRole('button', { name: T.prCreate })); });
    expect(confirmSpy).toHaveBeenCalledWith(T.prConfirm('feat/x'));
    expect(a.gitCreatePr).not.toHaveBeenCalled();
  });

  it('확인하면 실행하고 성공 시 PR 링크(외부 열기)를 보여준다', async () => {
    const a = api();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: T.prCreate })).toBeInTheDocument());
    act(() => { fireEvent.click(screen.getByRole('button', { name: T.prCreate })); });
    await waitFor(() => expect(a.gitCreatePr).toHaveBeenCalledWith('C:/repo/proj'));
    const link = await screen.findByRole('link', { name: T.prOpen });
    expect(link).toHaveAttribute('href', 'https://github.com/o/r/pull/7');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('alreadyExisted면 "이미 PR이 있어요"로 링크를 보여준다', async () => {
    api({ gitCreatePr: vi.fn(async () => ({ ok: true as const, url: 'https://x/pull/1', alreadyExisted: true })) });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: T.prCreate })).toBeInTheDocument());
    act(() => { fireEvent.click(screen.getByRole('button', { name: T.prCreate })); });
    expect(await screen.findByText(T.prAlreadyExists)).toBeInTheDocument();
  });

  it.each([
    ['gh-missing', () => T.prErrGhMissing],
    ['gh-unauthenticated', () => T.prErrGhAuth],
    ['no-remote', () => T.prErrNoRemote],
    ['on-default-branch', () => T.prErrDefaultBranch],
    ['detached', () => T.prErrDetached],
    ['push-failed', () => T.prErrPushFailed],
    ['pr-failed', () => T.prErrPrFailed],
  ])('실패 reason=%s면 그에 맞는 안내를 보여준다', async (reason, expected) => {
    api({ gitCreatePr: vi.fn(async () => ({ ok: false as const, reason, message: 'raw' })) });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: T.prCreate })).toBeInTheDocument());
    act(() => { fireEvent.click(screen.getByRole('button', { name: T.prCreate })); });
    expect(await screen.findByText(expected())).toBeInTheDocument();
  });

  it('진행 중엔 버튼이 잠기고 로딩 문구가 보인다(중복 push 방지)', async () => {
    let resolve!: (v: unknown) => void;
    api({ gitCreatePr: vi.fn(() => new Promise((r) => { resolve = r; })) });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: T.prCreate })).toBeInTheDocument());
    act(() => { fireEvent.click(screen.getByRole('button', { name: T.prCreate })); });
    const busy = await screen.findByRole('button', { name: T.prCreating });
    expect(busy).toBeDisabled();
    await act(async () => { resolve({ ok: true, url: 'https://x/pull/2', alreadyExisted: false }); });
  });
});
