import { render, screen, fireEvent } from '@testing-library/react';
import { Thread, avatarInitial, avatarColor, threadParticipants } from './Thread';

const anchor = { id: 'a', authorId: 'owner', ts: '2026-07-06T00:00:00.000Z', text: '질문' };
const r = (id: string, authorId: string, sec: number, text: string, authorName?: string) =>
  ({ id, authorId, ts: `2026-07-06T00:00:0${sec}.000Z`, text, authorName });
const two = [r('r1', 'engram', 1, '답1'), r('r2', 'u2', 2, '답2', '지민')];

const base = {
  draft: '', collapsed: false,
  onDraft: () => {}, onReply: () => {}, onToggle: () => {},
};

// ── 순수 함수(아바타·참여자) ────────────────────────────────────────────────
describe('아바타 순수 함수', () => {
  it('avatarInitial: 한글은 첫 음절, 영문은 대문자 첫 글자, 빈 이름은 ?', () => {
    expect(avatarInitial('지민')).toBe('지');
    expect(avatarInitial('engram')).toBe('E');
    expect(avatarInitial('  나  ')).toBe('나');
    expect(avatarInitial('')).toBe('?');
    expect(avatarInitial('   ')).toBe('?');
  });

  it('avatarColor: 같은 이름은 항상 같은 색, 테마 토큰 형태, 이름마다 갈린다', () => {
    expect(avatarColor('지민')).toBe(avatarColor('지민'));
    expect(avatarColor('Engram')).toMatch(/^var\(--av-[1-6]\)$/);
    const colors = new Set(['지민', 'Engram', '나', 'alice', 'bob', 'carol', 'dave', 'erin'].map(avatarColor));
    expect(colors.size).toBeGreaterThan(1);
  });

  it('threadParticipants: 답글 작성자 고유 인원을 등장 순서대로', () => {
    const names = threadParticipants(
      [r('r1', 'engram', 1, 'a'), r('r2', 'u2', 2, 'b', '지민'), r('r3', 'engram', 3, 'c'), r('r4', 'me', 4, 'd')],
      'me',
    );
    expect(names).toEqual(['Engram', '지민', expect.stringMatching(/나|me/)]);
  });
});

// ── Team(스레드 O) ─────────────────────────────────────────────────────────
describe('Team 채널(threaded)', () => {
  it('답글 2개 이상이면 스레드 헤더(아바타·답글 수·마지막 시각·셰브론)와 답글 입력칸을 그린다', () => {
    const { container } = render(<Thread {...base} threaded anchor={anchor} replies={two} />);
    const th = container.querySelector('.thread');
    expect(th).toBeTruthy();
    expect(container.querySelector('.thread .th-head')).toBeTruthy();
    expect(container.querySelectorAll('.thread .th-head .avs .av').length).toBe(2);
    expect(screen.getByText(/답글 2개|2 replies/)).toBeInTheDocument();
    expect(screen.getByText(/마지막|last/)).toBeInTheDocument();
    expect(screen.getByText(/접기|Collapse/)).toBeInTheDocument();
    // 답글 입력칸은 입력창 + 보내기 버튼 형태
    expect(container.querySelector('.treply input')).toBeTruthy();
    expect(container.querySelector('.treply .th-send')).toBeTruthy();
    // 목업에 없는 🧵 이모지는 제거됐다
    expect(container.textContent).not.toContain('🧵');
    // 옛 <details> 껍데기도 사라졌다
    expect(container.querySelector('details')).toBeNull();
  });

  it('답글 본문은 세로 연결선 안에 작은 아바타 + Message로 그린다', () => {
    const { container } = render(<Thread {...base} threaded anchor={anchor} replies={two} />);
    expect(container.querySelectorAll('.thread .th-msg').length).toBe(2);
    expect(container.querySelectorAll('.thread .th-msg .th-av').length).toBe(2);
    expect(screen.getByText('답1')).toBeInTheDocument();
    expect(screen.getByText('답2')).toBeInTheDocument();
  });

  it('답글 1개는 스레드 껍데기 없이 인라인(.msg.reply)', () => {
    const { container } = render(<Thread {...base} threaded anchor={anchor} replies={[two[0]]} />);
    expect(container.querySelector('.msg.reply')).toBeTruthy();
    expect(container.querySelector('.thread')).toBeNull();
    expect(container.querySelector('.treply')).toBeNull();
  });

  it('collapsed=true면 헤더 줄만 남고 답글·입력칸은 사라진다', () => {
    const { container } = render(<Thread {...base} threaded collapsed anchor={anchor} replies={two} />);
    expect(container.querySelector('.thread .th-head')).toBeTruthy();
    expect(container.querySelectorAll('.thread .th-msg').length).toBe(0);
    expect(container.querySelector('.treply')).toBeNull();
    expect(screen.getByText(/펼치기|Expand/)).toBeInTheDocument();
  });

  it('헤더를 누르면 접힘 상태가 토글된다', () => {
    const calls: boolean[] = [];
    const { container, rerender } = render(
      <Thread {...base} threaded anchor={anchor} replies={two} onToggle={(c) => calls.push(c)} />,
    );
    fireEvent.click(container.querySelector('.thread .th-head')!);
    expect(calls).toEqual([true]);
    rerender(<Thread {...base} threaded collapsed anchor={anchor} replies={two} onToggle={(c) => calls.push(c)} />);
    fireEvent.click(container.querySelector('.thread .th-head')!);
    expect(calls).toEqual([true, false]);
  });

  it('답글 입력: Enter와 보내기 버튼으로 전송, 빈 값은 전송하지 않는다', () => {
    const sent: string[] = [];
    const { container, rerender } = render(
      <Thread {...base} threaded anchor={anchor} replies={two} draft="ok" onReply={(t) => sent.push(t)} />,
    );
    fireEvent.keyDown(container.querySelector('.treply input')!, { key: 'Enter' });
    expect(sent).toEqual(['ok']);
    fireEvent.click(container.querySelector('.treply .th-send')!);
    expect(sent).toEqual(['ok', 'ok']);
    rerender(<Thread {...base} threaded anchor={anchor} replies={two} draft="   " onReply={(t) => sent.push(t)} />);
    fireEvent.keyDown(container.querySelector('.treply input')!, { key: 'Enter' });
    fireEvent.click(container.querySelector('.treply .th-send')!);
    expect(sent).toEqual(['ok', 'ok']);
  });
});

// ── Chat·Code(스레드 X — 평탄화) ────────────────────────────────────────────
describe('Chat·Code 채널(threaded=false)', () => {
  it('답글 2개여도 스레드 껍데기 없이 앵커→답글 순서로 평평하게 그린다', () => {
    const { container } = render(<Thread {...base} threaded={false} anchor={anchor} replies={two} />);
    expect(container.querySelector('.thread')).toBeNull();
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelector('.msg.reply')).toBeNull();
    expect(container.querySelectorAll('.msg').length).toBe(3);
    const texts = [...container.querySelectorAll('.msg .body')].map((e) => e.textContent?.trim());
    expect(texts).toEqual(['질문', '답1', '답2']);
  });

  it('답글 입구(답글 입력칸)를 노출하지 않는다', () => {
    const { container } = render(<Thread {...base} threaded={false} anchor={anchor} replies={two} />);
    expect(container.querySelector('.treply')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
  });

  it('답글 1개도 인라인 들여쓰기 없이 평평하게', () => {
    const { container } = render(<Thread {...base} threaded={false} anchor={anchor} replies={[two[0]]} />);
    expect(container.querySelector('.msg.reply')).toBeNull();
    expect(container.querySelectorAll('.msg').length).toBe(2);
  });

  it('답글이 없으면 메시지 하나만(기존과 동일)', () => {
    const { container } = render(<Thread {...base} threaded={false} anchor={anchor} replies={[]} />);
    expect(container.querySelectorAll('.msg').length).toBe(1);
  });
});
