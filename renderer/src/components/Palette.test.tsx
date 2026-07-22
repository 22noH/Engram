import { render, screen, fireEvent } from '@testing-library/react';
import { Palette, filterCommands, MANAGE_ENGRAMS_INSERT, CLEAR_INSERT, COMPACT_INSERT } from './Palette';

it('필터에 맞는 명령을 보여주고 클릭 시 insert를 onPick 한다', () => {
  const picks: string[] = [];
  render(<Palette filter="team" selected={0} onPick={(v) => picks.push(v)} />);
  fireEvent.click(screen.getByText('team <p1,p2> <question>'));
  expect(picks[0]).toBe('team ');
});
it('selected 인덱스 항목에 .sel 강조를 준다', () => {
  const { container } = render(<Palette filter="" selected={1} onPick={() => {}} />);
  const items = container.querySelectorAll('#palette .item');
  expect(items[1].className).toContain('sel');
  expect(items[0].className).not.toContain('sel');
});
it('filterCommands가 label/insert 부분일치로 거른다', () => {
  expect(filterCommands('resume').map((c) => c.insert)).toEqual(['resume ']);
});
it('MANAGE_ENGRAMS_INSERT는 사용자가 실수로 타이핑 않을 출력 가능한 센티널이다(NUL 아님)', () => {
  expect(MANAGE_ENGRAMS_INSERT).toBe('@@manage-engrams');
  expect(MANAGE_ENGRAMS_INSERT).not.toContain('\0');
  expect(filterCommands('manage').map((c) => c.insert)).toEqual([MANAGE_ENGRAMS_INSERT]);
});

// Task 4(clear-compact) — 팔레트에 /clear·/compact가 노출되고 필터된다(목업 ①).
it('/clear·/compact가 라벨로 노출된다', () => {
  render(<Palette filter="" selected={0} onPick={() => {}} />);
  expect(screen.getByText('/clear')).toBeInTheDocument();
  expect(screen.getByText('/compact')).toBeInTheDocument();
});
it('filterCommands("clear")는 /clear만, filterCommands("compact")는 /compact만 남긴다', () => {
  expect(filterCommands('clear').map((c) => c.insert)).toEqual([CLEAR_INSERT]);
  expect(filterCommands('compact').map((c) => c.insert)).toEqual([COMPACT_INSERT]);
});
it('CLEAR_INSERT/COMPACT_INSERT는 사용자가 실수로 타이핑 않을 출력 가능한 센티널이다(NUL 아님)', () => {
  expect(CLEAR_INSERT).not.toContain('\0');
  expect(COMPACT_INSERT).not.toContain('\0');
  expect(CLEAR_INSERT).not.toBe(COMPACT_INSERT);
});
it('클릭 시 CLEAR_INSERT/COMPACT_INSERT를 그대로 onPick 한다(입력창에 채울 텍스트가 아니라 App이 가로챌 센티널)', () => {
  const picks: string[] = [];
  render(<Palette filter="clear" selected={0} onPick={(v) => picks.push(v)} />);
  fireEvent.click(screen.getByText('/clear'));
  expect(picks[0]).toBe(CLEAR_INSERT);
});
it('새로 추가된 명령(/clear·/compact)은 NEW 배지 클래스(.new)를 가진다', () => {
  const { container } = render(<Palette filter="clear" selected={0} onPick={() => {}} />);
  expect(container.querySelector('.item.new')).toBeTruthy();
});
