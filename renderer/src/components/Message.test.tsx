import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Message } from './Message';

it('engram 번호목록은 클릭 대상이 아니라 그냥 텍스트다(선택은 actions 버튼)', () => {
  const { container } = render(
    <Message m={{ id: '1', authorId: 'engram', ts: '2026-07-06T00:00:00.000Z', text: '1. 하나\n2. 둘' }} />,
  );
  expect(container.querySelectorAll('ol > li').length).toBe(2); // 목록은 렌더됨
  expect(container.querySelectorAll('li.pick').length).toBe(0);  // 클릭 클래스 없음
});

const msg = (authorId: string, id = '1') => ({ id, authorId, text: 'hi', ts: new Date(0).toISOString() });

describe('Message 작성자 렌더', () => {
  it('team(myName): 내 이름은 me, 남은 이름 + other 스타일', () => {
    const mine = render(<Message m={msg('alice')} myName="alice" />);
    expect(mine.container.querySelector('.msg')?.className).toContain('me');
    expect(mine.container.querySelector('.who')?.textContent).toMatch(/^(나|me) · /);

    const other = render(<Message m={msg('bob', '2')} myName="alice" />);
    expect(other.container.querySelector('.msg')?.className).toContain('other');
    expect(other.container.querySelector('.who')?.textContent).toMatch(/^bob · /);
  });

  it('engram은 항상 Engram', () => {
    const r = render(<Message m={msg('engram', '3')} myName="alice" />);
    expect(r.container.querySelector('.who')?.textContent).toMatch(/^Engram · /);
    expect(r.container.querySelector('.msg')?.className).not.toContain('me');
    expect(r.container.querySelector('.msg')?.className).not.toContain('other');
  });

  it('myName 미지정(Ask/Code): 비-engram은 me(기존 동작)', () => {
    const r = render(<Message m={msg('owner', '4')} />);
    expect(r.container.querySelector('.msg')?.className).toContain('me');
  });
});
