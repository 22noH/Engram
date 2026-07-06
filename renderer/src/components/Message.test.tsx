import { render } from '@testing-library/react';
import { Message } from './Message';

it('engram 번호목록 클릭 시 onPick(번호)를 호출한다', () => {
  const picks: string[] = [];
  const { container } = render(
    <Message m={{ id: '1', authorId: 'engram', ts: '2026-07-06T00:00:00.000Z', text: '1. 하나\n2. 둘' }} onPick={(t) => picks.push(t)} />,
  );
  const items = container.querySelectorAll('ol > li.pick');
  expect(items).toHaveLength(2);
  (items[1] as HTMLElement).click();
  expect(picks).toEqual(['2']);
});
