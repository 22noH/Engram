import { render, screen, fireEvent } from '@testing-library/react';
import { Palette, filterCommands } from './Palette';

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
