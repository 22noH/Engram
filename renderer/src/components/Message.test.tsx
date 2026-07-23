import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Message } from './Message';

it('engram 번호목록은 클릭 대상이 아니라 그냥 텍스트다(선택은 actions 버튼)', () => {
  const { container } = render(
    <Message m={{ id: '1', authorId: 'engram', ts: '2026-07-06T00:00:00.000Z', text: '1. 하나\n2. 둘' }} />,
  );
  expect(container.querySelectorAll('ol > li').length).toBe(2); // 목록은 렌더됨
  expect(container.querySelectorAll('li.pick').length).toBe(0);  // 클릭 클래스 없음
});

const msg = (authorId: string, id = '1') => ({ id, authorId, text: 'hi', ts: new Date(0).toISOString() });

// 최종 리뷰 픽스(방어): question과 actions가 동시에 실린 메시지(현재 프로듀서 없음)도 카드만 그린다.
it('question+actions 동시 메시지는 카드만 렌더, 액션 버튼은 숨김(방어)', () => {
  const q = { questions: [{ q: '어느 쪽?', options: [{ label: 'A' }, { label: 'B' }] }] };
  const acts = [{ label: '승인', send: '승인' }];
  const { container } = render(
    <Message m={{ id: '1', authorId: 'engram', ts: new Date(0).toISOString(), text: '', question: q, actions: acts } as any} onSend={() => {}} />,
  );
  expect(container.querySelector('.actions')).toBeNull();
  expect(container.textContent).toContain('어느 쪽?');
});

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

  it('authorName 우선 렌더, myId 비교로 나/남 구분', () => {
    const m = { id: '1', authorId: 'uid-2', authorName: 'Lee', text: 'hi', ts: new Date().toISOString() };
    render(<Message m={m} myName="uid-1" />);
    expect(screen.getByText(/Lee/)).toBeTruthy(); // 남 → 이름 표시
  });
});
