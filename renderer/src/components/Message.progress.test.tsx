import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, act } from '@testing-library/react';
import { Message } from './Message';
import { T } from '../i18n';

// 진행 중 애니메이션(B안 — 글자가 흐름). 진행 메시지는 서버가 붙인 additive 필드(m.progress)로만
// 식별한다(텍스트 패턴 매칭 금지). 애니메이션은 "마지막 진행 메시지(activeProgressId 일치)"에만
// 돌고, 끝난 단계는 완료 표시(초록 점 + 흐린 글자)로 남는다.

const prog = (over: Record<string, unknown> = {}) => ({
  id: 'p1', authorId: 'engram', text: '· 코딩 중: backend', ts: new Date().toISOString(), progress: true, ...over,
}) as any;

it('진행 메시지는 progress 클래스와 단계 점을 렌더한다', () => {
  const { container } = render(<Message m={prog()} />);
  expect(container.querySelector('.msg')?.className).toContain('progress');
  expect(container.querySelector('.pdot')).not.toBeNull();
});

it('마지막 진행 메시지(activeProgressId 일치)만 running, 나머지는 done', () => {
  const running = render(<Message m={prog()} activeProgressId="p1" />);
  expect(running.container.querySelector('.msg')?.className).toContain('running');
  expect(running.container.querySelector('.msg')?.className).not.toContain('done');

  const done = render(<Message m={prog({ id: 'p0' })} activeProgressId="p1" />);
  expect(done.container.querySelector('.msg')?.className).toContain('done');
  expect(done.container.querySelector('.msg')?.className).not.toContain('running');
});

it('작업 중이 아니면(activeProgressId 없음) 아무 것도 안 돈다 — 답이 오거나 중지하면 즉시 정지', () => {
  const { container } = render(<Message m={prog()} />);
  expect(container.querySelector('.msg')?.className).not.toContain('running');
});

it('진행 표시가 없는 기존 메시지는 클래스도 점도 안 붙는다(회귀 0)', () => {
  const { container } = render(
    <Message m={{ id: 'm1', authorId: 'engram', text: '보통 답', ts: new Date().toISOString() }} activeProgressId="m1" />,
  );
  expect(container.querySelector('.msg')?.className).not.toContain('progress');
  expect(container.querySelector('.pdot')).toBeNull();
});

describe('경과 시간 — 침묵의 길이를 설명한다', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('진행 중이고 3초를 넘으면 경과 초가 붙는다', () => {
    const { container } = render(<Message m={prog({ ts: new Date(Date.now() - 41_000).toISOString() })} activeProgressId="p1" />);
    expect(container.textContent).toContain(T.progressElapsed(41));
  });

  it('3초 이하면 안 붙는다(짧은 단계마다 숫자가 깜빡이지 않게)', () => {
    const { container } = render(<Message m={prog({ ts: new Date(Date.now() - 2_000).toISOString() })} activeProgressId="p1" />);
    expect(container.querySelector('.pElapsed')).toBeNull();
  });

  it('1초마다 갱신된다', () => {
    vi.useFakeTimers();
    const { container } = render(<Message m={prog({ ts: new Date(Date.now() - 3_000).toISOString() })} activeProgressId="p1" />);
    expect(container.querySelector('.pElapsed')).toBeNull(); // 아직 3초 — 미표시
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(container.textContent).toContain(T.progressElapsed(5));
  });

  it('끝난 단계(done)엔 경과 시간이 안 붙는다', () => {
    const { container } = render(<Message m={prog({ id: 'p0', ts: new Date(Date.now() - 41_000).toISOString() })} activeProgressId="p1" />);
    expect(container.querySelector('.pElapsed')).toBeNull();
  });
});

it('reduced-motion이면 shimmer 애니메이션을 끄고 정적 표시로 돌린다(theme.css)', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/theme.css'), 'utf8');
  const block = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/);
  expect(block).not.toBeNull();
  // 끄는 규칙은 shimmer를 켜는 규칙과 "같은 선택자"여야 한다 — 미디어쿼리는 우선순위를 올려주지 않아
  // 선택자가 더 약하면 애니메이션이 그대로 돈다(설정을 무시하는 셈).
  const shimmerRule = css.match(/([^{}]+)\{[^{}]*animation:progressShimmer[^{}]*\}/);
  expect(shimmerRule).not.toBeNull();
  expect(block![0]).toContain(shimmerRule![1].trim());
  expect(block![0]).toContain('animation:none');
  // 색은 Quiet Library 토큰만(하드코딩 금지) — 정적 표시로 돌아갈 때도 마찬가지.
  expect(block![0]).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
});
