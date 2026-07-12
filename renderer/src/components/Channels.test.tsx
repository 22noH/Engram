import { render, screen } from '@testing-library/react';
import { Channels } from './Channels';

const base = {
  channels: [{ id: 'a', name: 'ask1', respondMode: 'all', mode: 'chat' }],
  current: 'a', canManageChannels: true, onSelect: () => {}, onSetMode: () => {}, onCreate: () => {}, onDelete: () => {}, onSetRespondMode: () => {}, onManageMembers: () => {},
} as any;

it('Ask·Code·Team 탭 모두 렌더된다(Phase 14: TEAM_CHAT=true)', () => {
  render(<Channels {...base} mode="chat" />);
  expect(screen.getByText(/Ask|챗봇/)).toBeInTheDocument();
  expect(screen.getByText(/Code|코드/)).toBeInTheDocument();
  expect(screen.getByText(/Team|^채팅$/)).toBeInTheDocument();
});

it('남의 채널이고 canManageChannels=false면 ⋯메뉴 숨김', () => {
  const channels = [{ id: 'general', name: 'general', respondMode: 'all' as const, mode: 'chat' as const, creatorId: 'someone-else' }];
  render(<Channels channels={channels} current="general" mode="chat" canManageChannels={false} myId="me"
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} onManageMembers={() => {}} />);
  expect(screen.queryByText('⋯')).toBeNull();
});

it('내 채널이면 권한 없어도 ⋯메뉴 표시', () => {
  const channels = [{ id: 'general', name: 'general', respondMode: 'all' as const, mode: 'chat' as const, creatorId: 'me' }];
  render(<Channels channels={channels} current="general" mode="chat" canManageChannels={false} myId="me"
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} onManageMembers={() => {}} />);
  expect(screen.getByText('⋯')).toBeTruthy();
});

it('canManageChannels=true면 남 채널도 ⋯메뉴 표시', () => {
  const channels = [{ id: 'general', name: 'general', respondMode: 'all' as const, mode: 'chat' as const, creatorId: 'other' }];
  render(<Channels channels={channels} current="general" mode="chat" canManageChannels={true} myId="me"
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} onManageMembers={() => {}} />);
  expect(screen.getByText('⋯')).toBeTruthy();
});

it('visibility=private 채널은 자물쇠 마커 표시', () => {
  const channels = [{ id: 'secret', name: 'secret', respondMode: 'all' as const, mode: 'chat' as const, visibility: 'private' as const }];
  render(<Channels channels={channels} current="secret" mode="chat" canManageChannels={false} myId="me"
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} onManageMembers={() => {}} />);
  expect(screen.getByTitle(/private|비공개/i)).toBeTruthy();
});

it('비공개 채널은 canManageChannels=true여도 주인이 아니면 ⋯메뉴 숨김', () => {
  const channels = [{ id: 'secret', name: 'secret', respondMode: 'all' as const, mode: 'chat' as const, visibility: 'private' as const, creatorId: 'other' }];
  render(<Channels channels={channels} current="secret" mode="chat" canManageChannels={true} myId="me"
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} onManageMembers={() => {}} />);
  expect(screen.queryByText('⋯')).toBeNull();
});

it('비공개 채널은 주인(creatorId===myId)에게만 ⋯메뉴 표시', () => {
  const channels = [{ id: 'secret', name: 'secret', respondMode: 'all' as const, mode: 'chat' as const, visibility: 'private' as const, creatorId: 'me' }];
  render(<Channels channels={channels} current="secret" mode="chat" canManageChannels={false} myId="me"
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} onManageMembers={() => {}} />);
  expect(screen.getByText('⋯')).toBeTruthy();
});

it('공개 채널은 자물쇠 없음', () => {
  const channels = [{ id: 'general', name: 'general', respondMode: 'all' as const, mode: 'chat' as const }];
  render(<Channels channels={channels} current="general" mode="chat" canManageChannels={false} myId="me"
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} onManageMembers={() => {}} />);
  expect(screen.queryByTitle(/private|비공개/i)).toBeNull();
});
