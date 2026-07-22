import { render, screen, fireEvent } from '@testing-library/react';
import { Channels } from './Channels';

const base = {
  channels: [{ id: 'a', name: 'ask1', respondMode: 'all', mode: 'chat' }],
  current: 'a', canManageChannels: true, onSelect: () => {}, onSetMode: () => {}, onCreate: () => {}, onDelete: () => {}, onSetRespondMode: () => {}, onManageMembers: () => {},
} as any;

// 배포 형태 분리(2026-07-19 설계 §2.2) — TEAM_CHAT은 preset(config.PRESET) 유무로 결정된다.
// Channels.tsx가 모듈 로드 시점에 '../config'를 정적 import하므로, 값을 바꾸려면 doMock+resetModules
// 후 동적 재import(connections.test.ts:28 패턴)해야 한다.
it('PRESET 없음(스탠드얼론) → team 탭 미렌더', async () => {
  vi.resetModules();
  vi.doMock('../config', () => ({ TEAM_CHAT: false, ko: false }));
  const { Channels: StandaloneChannels } = await import('./Channels');
  render(<StandaloneChannels {...base} mode="chat" />);
  expect(screen.getByText(/Ask|챗봇/)).toBeInTheDocument();
  expect(screen.getByText(/Code|코드/)).toBeInTheDocument();
  expect(screen.queryByText(/^(Team|채팅)$/)).toBeNull();
  vi.doUnmock('../config');
  vi.resetModules();
});

it('PRESET 있음 → team 탭 렌더', async () => {
  vi.resetModules();
  vi.doMock('../config', () => ({ TEAM_CHAT: true, ko: false }));
  const { Channels: PresetChannels } = await import('./Channels');
  render(<PresetChannels {...base} mode="chat" />);
  expect(screen.getByText(/Ask|챗봇/)).toBeInTheDocument();
  expect(screen.getByText(/Code|코드/)).toBeInTheDocument();
  expect(screen.getByText(/^(Team|채팅)$/)).toBeInTheDocument();
  vi.doUnmock('../config');
  vi.resetModules();
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

// Task 4 — 채널별 두뇌 드롭다운 + 배지
it('두뇌 드롭다운 렌더: 기본 + 등록 이름들', () => {
  const channels = [{ id: 'general', name: 'general', respondMode: 'all' as const, mode: 'chat' as const, creatorId: 'me' }];
  render(<Channels channels={channels} current="general" mode="chat" canManageChannels={false} myId="me"
    brainNames={['qwen', 'gemma']} onSetChannelBrain={() => {}}
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} onManageMembers={() => {}} />);
  fireEvent.click(screen.getByText('⋯'));
  expect(screen.getByText(/Default|기본/)).toBeInTheDocument();
  expect(screen.getByText('qwen')).toBeInTheDocument();
  expect(screen.getByText('gemma')).toBeInTheDocument();
});

// Task 4(리뷰 지적) — defaultBrain 전달 시 기본 항목이 "Default (name)"/"기본 (name)" 형태로 표시.
it('defaultBrain 전달 시 기본 항목에 현재 기본 두뇌 이름이 붙는다', () => {
  const channels = [{ id: 'general', name: 'general', respondMode: 'all' as const, mode: 'chat' as const, creatorId: 'me' }];
  render(<Channels channels={channels} current="general" mode="chat" canManageChannels={false} myId="me"
    brainNames={['qwen', 'gemma']} defaultBrain="claude" onSetChannelBrain={() => {}}
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} onManageMembers={() => {}} />);
  fireEvent.click(screen.getByText('⋯'));
  expect(screen.getByText(/Default \(claude\)|기본 \(claude\)/)).toBeInTheDocument();
});

// defaultBrain 미전달(빈 문자열)이면 기존처럼 이름 없는 "Default"/"기본"만.
it('defaultBrain 미전달 시 기본 항목은 이름 없이 표시(회귀)', () => {
  const channels = [{ id: 'general', name: 'general', respondMode: 'all' as const, mode: 'chat' as const, creatorId: 'me' }];
  render(<Channels channels={channels} current="general" mode="chat" canManageChannels={false} myId="me"
    brainNames={['qwen', 'gemma']} onSetChannelBrain={() => {}}
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} onManageMembers={() => {}} />);
  fireEvent.click(screen.getByText('⋯'));
  expect(screen.getByText(/^(Default|기본)$/)).toBeInTheDocument();
});

it('두뇌 항목 선택 시 setChannelBrain 콜백을 채널 id+이름으로 즉시 호출', () => {
  const onSetChannelBrain = vi.fn();
  const channels = [{ id: 'general', name: 'general', respondMode: 'all' as const, mode: 'chat' as const, creatorId: 'me' }];
  render(<Channels channels={channels} current="general" mode="chat" canManageChannels={false} myId="me"
    brainNames={['qwen']} onSetChannelBrain={onSetChannelBrain}
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} onManageMembers={() => {}} />);
  fireEvent.click(screen.getByText('⋯'));
  fireEvent.click(screen.getByText('qwen'));
  expect(onSetChannelBrain).toHaveBeenCalledWith('general', 'qwen');
});

it('"기본" 선택 시 null(해제)을 전송', () => {
  const onSetChannelBrain = vi.fn();
  const channels = [{ id: 'general', name: 'general', respondMode: 'all' as const, mode: 'chat' as const, creatorId: 'me', brain: 'qwen' }];
  render(<Channels channels={channels} current="general" mode="chat" canManageChannels={false} myId="me"
    brainNames={['qwen']} onSetChannelBrain={onSetChannelBrain}
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} onManageMembers={() => {}} />);
  fireEvent.click(screen.getByText('⋯'));
  fireEvent.click(screen.getByText(/Default|기본/));
  expect(onSetChannelBrain).toHaveBeenCalledWith('general', null);
});

it('비기본 두뇌를 쓰는 채널은 목록에 두뇌 이름 배지 표시', () => {
  const channels = [{ id: 'general', name: 'general', respondMode: 'all' as const, mode: 'chat' as const, brain: 'qwen' }];
  render(<Channels channels={channels} current="general" mode="chat" canManageChannels={false} myId="me"
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} onManageMembers={() => {}} />);
  expect(screen.getByText('qwen')).toBeInTheDocument();
});

it('기본 두뇌(brain 미설정) 채널은 배지 없음 — 회귀: 기존 화면과 동일', () => {
  const channels = [{ id: 'general', name: 'general', respondMode: 'all' as const, mode: 'chat' as const }];
  const { container } = render(<Channels channels={channels} current="general" mode="chat" canManageChannels={false} myId="me"
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} onManageMembers={() => {}} />);
  expect(container.querySelector('.brainBadge')).toBeNull();
});

// Task 4(clear-compact) — ⋯메뉴 정리 항목 2개(목업 ②: 요약해서 정리·대화 기록 삭제).
it('⋯메뉴에 "요약해서 정리"·"대화 기록 삭제" 항목이 있고 클릭 시 각 콜백을 채널 id로 호출한다', () => {
  const onCompact = vi.fn();
  const onClearHistory = vi.fn();
  const channels = [{ id: 'general', name: 'general', respondMode: 'all' as const, mode: 'chat' as const, creatorId: 'me' }];
  render(<Channels channels={channels} current="general" mode="chat" canManageChannels={false} myId="me"
    onCompact={onCompact} onClearHistory={onClearHistory}
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} onManageMembers={() => {}} />);
  fireEvent.click(screen.getByText('⋯'));
  fireEvent.click(screen.getByText(/요약해서 정리|Summarize/));
  expect(onCompact).toHaveBeenCalledWith('general');
  fireEvent.click(screen.getByText('⋯'));
  fireEvent.click(screen.getByText(/대화 기록 삭제|Delete history/));
  expect(onClearHistory).toHaveBeenCalledWith('general');
});

// "대화 기록 삭제"는 기존 "채널 삭제"처럼 danger — 클릭해도 확인창(window.confirm) 없이 바로 콜백(즉시 삭제, 목업 ③).
it('"대화 기록 삭제" 클릭은 window.confirm 없이 즉시 콜백을 호출한다', () => {
  const confirmSpy = vi.spyOn(window, 'confirm');
  const onClearHistory = vi.fn();
  const channels = [{ id: 'general', name: 'general', respondMode: 'all' as const, mode: 'chat' as const, creatorId: 'me' }];
  render(<Channels channels={channels} current="general" mode="chat" canManageChannels={false} myId="me"
    onClearHistory={onClearHistory}
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} onManageMembers={() => {}} />);
  fireEvent.click(screen.getByText('⋯'));
  fireEvent.click(screen.getByText(/대화 기록 삭제|Delete history/));
  expect(confirmSpy).not.toHaveBeenCalled();
  expect(onClearHistory).toHaveBeenCalledWith('general');
  confirmSpy.mockRestore();
});

// 미전달(기존 테스트 자리)이면 클릭이 no-op — 렌더 자체는 유지(onSetChannelBrain과 같은 결).
it('onClearHistory/onCompact 미전달이어도 ⋯메뉴는 정상 렌더되고 클릭이 크래시 나지 않는다', () => {
  const channels = [{ id: 'general', name: 'general', respondMode: 'all' as const, mode: 'chat' as const, creatorId: 'me' }];
  render(<Channels channels={channels} current="general" mode="chat" canManageChannels={false} myId="me"
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} onManageMembers={() => {}} />);
  fireEvent.click(screen.getByText('⋯'));
  expect(() => fireEvent.click(screen.getByText(/요약해서 정리|Summarize/))).not.toThrow();
});

it('권한 없으면 두뇌 드롭다운도 미표시(⋯ 자체가 숨음)', () => {
  const channels = [{ id: 'general', name: 'general', respondMode: 'all' as const, mode: 'chat' as const, creatorId: 'other' }];
  render(<Channels channels={channels} current="general" mode="chat" canManageChannels={false} myId="me"
    brainNames={['gemma']} onSetChannelBrain={() => {}}
    onSelect={() => {}} onSetMode={() => {}} onCreate={() => {}} onDelete={() => {}} onSetRespondMode={() => {}} onManageMembers={() => {}} />);
  expect(screen.queryByText('⋯')).toBeNull();
  expect(screen.queryByText('gemma')).toBeNull();
});
