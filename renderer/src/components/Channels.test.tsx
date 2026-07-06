import { render, screen } from '@testing-library/react';
import { Channels } from './Channels';

const base = {
  channels: [{ id: 'a', name: 'ask1', respondMode: 'all', mode: 'chat' }],
  current: 'a', onSelect: () => {}, onSetMode: () => {}, onCreate: () => {}, onDelete: () => {}, onSetRespondMode: () => {},
} as any;

it('Ask·Code 탭 렌더, Team은 flag off면 안 보인다', () => {
  render(<Channels {...base} mode="chat" />);
  expect(screen.getByText(/Ask|챗봇/)).toBeInTheDocument();
  expect(screen.getByText(/Code|코드/)).toBeInTheDocument();
  expect(screen.queryByText(/Team|^채팅$/)).toBeNull(); // TEAM_CHAT=false
});
