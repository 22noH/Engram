import { render, screen } from '@testing-library/react';
import { Thread } from './Thread';

const anchor = { id: 'a', authorId: 'owner', ts: '2026-07-06T00:00:00.000Z', text: '질문' };
it('답 1개는 인라인(reply)로, 2개 이상은 접힘 요약으로 렌더한다', () => {
  const one = render(<Thread anchor={anchor} replies={[{ id: 'r1', authorId: 'engram', ts: '2026-07-06T00:00:01.000Z', text: '답1' }]}
    draft="" collapsed={false} onDraft={() => {}} onReply={() => {}} onPick={() => {}} onToggle={() => {}} />);
  expect(one.container.querySelector('.msg.reply')).toBeTruthy();
  one.unmount();
  render(<Thread anchor={anchor}
    replies={[{ id: 'r1', authorId: 'engram', ts: '2026-07-06T00:00:01.000Z', text: '답1' }, { id: 'r2', authorId: 'engram', ts: '2026-07-06T00:00:02.000Z', text: '답2' }]}
    draft="" collapsed={false} onDraft={() => {}} onReply={() => {}} onPick={() => {}} onToggle={() => {}} />);
  expect(screen.getByText(/답글 2개|2 replies/)).toBeInTheDocument();
});

it('collapsed=true면 details가 접혀 렌더된다', () => {
  const { container } = render(<Thread anchor={anchor}
    replies={[{ id: 'r1', authorId: 'engram', ts: '2026-07-06T00:00:01.000Z', text: '답1' }, { id: 'r2', authorId: 'engram', ts: '2026-07-06T00:00:02.000Z', text: '답2' }]}
    draft="" collapsed={true} onDraft={() => {}} onReply={() => {}} onPick={() => {}} onToggle={() => {}} />);
  const det = container.querySelector('details.thread') as HTMLDetailsElement;
  expect(det.open).toBe(false);
});
