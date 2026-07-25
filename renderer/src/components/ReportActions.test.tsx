import { render, fireEvent, waitFor } from '@testing-library/react';
import { Message } from './Message';
import { T } from '../i18n';

// 완료 보고서 — 본문은 두뇌가 쓴 마크다운 그대로 렌더되고, 아래에 액션 줄이 붙는다.
// 두 버튼 모두 "이미 있는 기능"을 부른다: 변경점=코드 독 Diff 칸, PR=engram:git-create-pr(확인 필수).

const report = (over: Record<string, unknown> = {}) => ({
  id: 'r1', authorId: 'engram', ts: new Date().toISOString(),
  text: '# 자동 리뷰 붙이기\n**남은 것 · 판단 필요**\n- 없음',
  completionReport: true, ...over,
}) as any;

afterEach(() => { delete (window as any).engramDesktop; vi.restoreAllMocks(); });

it('보고서 메시지엔 [변경점 보기]·[PR 생성] 줄이 붙는다', () => {
  (window as any).engramDesktop = { gitCreatePr: vi.fn(), gitBranchStatus: vi.fn(async () => ({ ok: true, branch: 'engram/x', detached: false, added: 1, removed: 0, files: 1 })) };
  const { container, getByText } = render(<Message m={report()} onShowDiff={() => {}} reportRepoPath="C:/proj" />);
  expect(container.querySelector('.reportActions')).not.toBeNull();
  expect(getByText(T.reportViewDiff)).toBeInTheDocument();
  expect(getByText(T.prCreate)).toBeInTheDocument();
});

it('[변경점 보기]는 독 Diff 칸을 여는 핸들러를 그대로 부른다', () => {
  const onShowDiff = vi.fn();
  const { getByText } = render(<Message m={report()} onShowDiff={onShowDiff} />);
  fireEvent.click(getByText(T.reportViewDiff));
  expect(onShowDiff).toHaveBeenCalledTimes(1);
});

it('[PR 생성]은 확인을 거쳐야만 실행된다(취소하면 아무 일도 안 난다)', async () => {
  const gitCreatePr = vi.fn(async () => ({ ok: true as const, url: 'https://x/pull/1', alreadyExisted: false }));
  (window as any).engramDesktop = { gitCreatePr, gitBranchStatus: vi.fn(async () => ({ ok: true, branch: 'engram/x', detached: false, added: 1, removed: 0, files: 1 })) };
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const { getByText } = render(<Message m={report()} reportRepoPath="C:/proj" />);

  fireEvent.click(getByText(T.prCreate));
  await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
  expect(gitCreatePr).not.toHaveBeenCalled();

  confirmSpy.mockReturnValue(true);
  fireEvent.click(getByText(T.prCreate));
  await waitFor(() => expect(gitCreatePr).toHaveBeenCalledWith('C:/proj'));
});

it('보고서 표식이 없는 메시지엔 액션 줄이 아예 없다(회귀 0)', () => {
  (window as any).engramDesktop = { gitCreatePr: vi.fn() };
  const { container } = render(<Message m={report({ completionReport: undefined })} onShowDiff={() => {}} reportRepoPath="C:/proj" />);
  expect(container.querySelector('.reportActions')).toBeNull();
});

it('데스크톱이 아니면(기능 없음) 줄을 안 그린다 — 눌러도 아무것도 없는 버튼을 만들지 않는다', () => {
  const { container } = render(<Message m={report()} reportRepoPath="C:/proj" />);
  expect(container.querySelector('.reportActions')).toBeNull();
});
