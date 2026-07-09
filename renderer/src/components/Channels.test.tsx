import { render, screen } from '@testing-library/react';
import { Channels } from './Channels';

const base = {
  channels: [{ id: 'a', name: 'ask1', respondMode: 'all', mode: 'chat' }],
  current: 'a', onSelect: () => {}, onSetMode: () => {}, onCreate: () => {}, onDelete: () => {}, onSetRespondMode: () => {},
} as any;

it('Ask·Code·Team 탭 모두 렌더된다(Phase 14: TEAM_CHAT=true)', () => {
  render(<Channels {...base} mode="chat" />);
  expect(screen.getByText(/Ask|챗봇/)).toBeInTheDocument();
  expect(screen.getByText(/Code|코드/)).toBeInTheDocument();
  expect(screen.getByText(/Team|^채팅$/)).toBeInTheDocument();
});
