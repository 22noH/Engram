import { render, screen, fireEvent } from '@testing-library/react';
import { mentionCandidates, MentionAutocomplete } from './MentionAutocomplete';

describe('mentionCandidates (pure)', () => {
  it('returns names matching a trailing @token', () => {
    expect(mentionCandidates('hello @wo', ['Work', 'Home'])).toEqual(['Work']);
  });
  it('matches case-insensitively', () => {
    expect(mentionCandidates('@HO', ['Work', 'Home'])).toEqual(['Home']);
  });
  it('returns every name for a bare @', () => {
    expect(mentionCandidates('@', ['Work', 'Home'])).toEqual(['Work', 'Home']);
  });
  it('returns nothing when there is no trailing @ token', () => {
    expect(mentionCandidates('hello world', ['Work', 'Home'])).toEqual([]);
  });
  it('ignores an @ that is not at the end of the text', () => {
    expect(mentionCandidates('@work hi', ['Work', 'Home'])).toEqual([]);
  });
});

it('renders candidates and calls onPick with the picked name', () => {
  const onPick = vi.fn();
  render(<MentionAutocomplete text="hi @wo" names={['Work', 'Home']} selected={0} onPick={onPick} />);
  fireEvent.click(screen.getByText('@Work'));
  expect(onPick).toHaveBeenCalledWith('Work');
});

it('renders nothing when there is no trailing @ token', () => {
  const { container } = render(<MentionAutocomplete text="hello" names={['Work', 'Home']} selected={0} onPick={() => {}} />);
  expect(container).toBeEmptyDOMElement();
});
