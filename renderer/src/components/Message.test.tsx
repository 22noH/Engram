import { render } from '@testing-library/react';
import { Message } from './Message';

it('engram 번호목록은 클릭 대상이 아니라 그냥 텍스트다(선택은 actions 버튼)', () => {
  const { container } = render(
    <Message m={{ id: '1', authorId: 'engram', ts: '2026-07-06T00:00:00.000Z', text: '1. 하나\n2. 둘' }} />,
  );
  expect(container.querySelectorAll('ol > li').length).toBe(2); // 목록은 렌더됨
  expect(container.querySelectorAll('li.pick').length).toBe(0);  // 클릭 클래스 없음
});
