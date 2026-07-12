import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChannelMembers } from './ChannelMembers';

const roster = [{ id: 'a', displayName: 'Alice' }, { id: 'b', displayName: 'Bob' }, { id: 'c', displayName: 'Cara' }];

describe('ChannelMembers', () => {
  it('현재 멤버는 체크됨, 토글 시 onSetMembers', () => {
    const onSetMembers = vi.fn();
    render(<ChannelMembers roster={roster} memberIds={['b']} creatorId="a" visibility="private"
      onSetMembers={onSetMembers} onSetVisibility={() => {}} onClose={() => {}} />);
    const cara = screen.getByLabelText('Cara') as HTMLInputElement;
    expect(cara.checked).toBe(false);
    fireEvent.click(cara);
    expect(onSetMembers).toHaveBeenCalledWith(expect.arrayContaining(['b', 'c']));
  });

  it('주인(creatorId) 행은 체크·비활성(항상 멤버)', () => {
    render(<ChannelMembers roster={roster} memberIds={[]} creatorId="a" visibility="private"
      onSetMembers={() => {}} onSetVisibility={() => {}} onClose={() => {}} />);
    const alice = screen.getByLabelText('Alice') as HTMLInputElement;
    expect(alice.checked).toBe(true);
    expect(alice.disabled).toBe(true);
  });

  it('공개↔비공개 토글 시 onSetVisibility', () => {
    const onSetVisibility = vi.fn();
    render(<ChannelMembers roster={roster} memberIds={[]} creatorId="a" visibility="public"
      onSetMembers={() => {}} onSetVisibility={onSetVisibility} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /make private|비공개로/i }));
    expect(onSetVisibility).toHaveBeenCalledWith('private');
  });
});
