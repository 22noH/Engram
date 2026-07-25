import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, fireEvent, act } from '@testing-library/react';
import { ProgressCard } from './ProgressCard';
import type { ProgressRunGroup } from '../progress-run';
import type { Message as Msg } from '../../../shared/protocol';
import { T } from '../i18n';

// 진행 카드 — 한 실행이 접힌 한 줄이고, 누르면 단계 목록이 펼쳐진다. 끝나면 머리글이 완료로
// 바뀌며 자동으로 접힌다(목업 승인).

const at = (secAgo: number): string => new Date(Date.now() - secAgo * 1000).toISOString();
const step = (text: string, secAgo: number, kind?: 'retry' | 'fail', id = text): Msg => ({
  id, authorId: 'engram', text, ts: at(secAgo), progress: true,
  progressRun: { id: 'r1', title: '자율 코딩', ...(kind ? { kind } : {}) },
} as Msg);

const group = (steps: Msg[]): ProgressRunGroup => ({ kind: 'run', id: 'r1', title: '자율 코딩', steps });

const running = group([
  step('· 분해 완료 — 작업 2개', 300),
  step('· ✗ 실패: backend — 다시 시도합니다 [사용량 한도]', 200, 'retry'),
  step('· 완성조건 리뷰 중', 41),
]);

describe('진행 카드 — 접힘 기본', () => {
  it('접힌 채로 시작하고 제목·현재 단계·경과·단계 수를 한 줄에 보여준다', () => {
    const { container } = render(<ProgressCard run={running} running />);
    expect(container.querySelector('.pcSteps')).toBeNull();          // 접힘이 기본
    const head = container.querySelector('.pcHead')!;
    expect(head.textContent).toContain('자율 코딩');
    expect(head.textContent).toContain('완성조건 리뷰 중');           // 지금 하는 단계
    expect(head.textContent).toContain(T.progressElapsed(300));       // 첫 단계부터의 경과
    expect(head.textContent).toContain(T.progressCardSteps(2, 3));    // 끝난 단계 2 / 전체 3
  });

  it('클릭하면 단계 목록이 펼쳐지고 다시 누르면 접힌다', () => {
    const { container } = render(<ProgressCard run={running} running />);
    fireEvent.click(container.querySelector('.pcHead')!);
    expect(container.querySelectorAll('.pcStep')).toHaveLength(3);
    fireEvent.click(container.querySelector('.pcHead')!);
    expect(container.querySelector('.pcSteps')).toBeNull();
  });

  it('키보드로도 열린다 + 펼침 상태를 aria로 알린다(접근성)', () => {
    const { container } = render(<ProgressCard run={running} running />);
    const head = container.querySelector('.pcHead')!;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(head, { key: 'Enter' });
    expect(head.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('진행 카드 — 단계 마커', () => {
  const marks = (c: HTMLElement): string[] => [...c.querySelectorAll('.pcMk')].map((e) => e.textContent ?? '');

  it('끝난 단계는 ✓, 지금 도는 단계는 ◌, 재시도는 ↻', () => {
    const { container } = render(<ProgressCard run={running} running />);
    fireEvent.click(container.querySelector('.pcHead')!);
    expect(marks(container)).toEqual(['✓', '↻', '◌']);
  });

  it('실패 단계는 ✗로 남는다(사유는 그 줄에 그대로 보인다)', () => {
    const g = group([step('· 게이트 빨강 [tsc 실패]', 50, 'fail'), step('· 다시', 10)]);
    const { container } = render(<ProgressCard run={g} running />);
    fireEvent.click(container.querySelector('.pcHead')!);
    expect(marks(container)[0]).toBe('✗');
    expect(container.textContent).toContain('tsc 실패');
  });

  it('앞머리 점(· )은 마커가 대신하므로 문구에서 빠진다', () => {
    const { container } = render(<ProgressCard run={running} running />);
    fireEvent.click(container.querySelector('.pcHead')!);
    expect(container.querySelector('.pcTx')!.textContent).toBe('분해 완료 — 작업 2개');
  });
});

describe('진행 카드 — 끝났을 때', () => {
  it('머리글이 "완료 — n단계 · 총 시간"으로 바뀐다', () => {
    const done = group([step('· 시작', 312), step('· 끝', 0)]);
    const { container } = render(<ProgressCard run={done} running={false} />);
    const head = container.querySelector('.pcHead')!;
    expect(head.textContent).toContain(T.progressCardDone('자율 코딩'));
    expect(head.textContent).toContain(T.progressCardDoneMeta(2, T.progressElapsed(312)));
    expect(container.querySelector('.progressCard')?.className).toContain('done');
  });

  it('끝난 카드는 모든 단계가 ✓다(더 이상 도는 단계가 없다)', () => {
    const done = group([step('· 시작', 10), step('· 끝', 0)]);
    const { container } = render(<ProgressCard run={done} running={false} />);
    fireEvent.click(container.querySelector('.pcHead')!);
    expect([...container.querySelectorAll('.pcMk')].map((e) => e.textContent)).toEqual(['✓', '✓']);
  });

  it('펼쳐 보던 중에 실행이 끝나면 자동으로 접힌다', () => {
    const { container, rerender } = render(<ProgressCard run={running} running />);
    fireEvent.click(container.querySelector('.pcHead')!);
    expect(container.querySelector('.pcSteps')).not.toBeNull();
    rerender(<ProgressCard run={running} running={false} />);
    expect(container.querySelector('.pcSteps')).toBeNull();
  });
});

it('reduced-motion이면 카드 제목의 흐르는 애니메이션도 꺼진다(theme.css)', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/theme.css'), 'utf8');
  const block = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/)![0];
  // 끄는 규칙의 선택자는 켜는 규칙과 글자 그대로 같아야 한다 — 미디어쿼리는 우선순위를 안 올려준다.
  const rule = css.match(/([^{}]+)\{[^{}]*animation:progressShimmer[^{}]*\}(?![\s\S]*?\{[^{}]*animation:progressShimmer)/)!;
  const selector = rule[1].trim().split('\n').pop()!.trim(); // 앞에 붙은 주석은 빼고 선택자만
  expect(selector).toContain('progressCard');
  expect(block).toContain(selector);
  expect(block).toContain('animation:none');
});

describe('진행 카드 — 경과 시간', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('진행 중이면 1초마다 갱신된다', () => {
    vi.useFakeTimers();
    const g = group([step('· 시작', 10)]);
    const { container } = render(<ProgressCard run={g} running />);
    expect(container.querySelector('.pcMeta')!.textContent).toContain(T.progressElapsed(10));
    act(() => { vi.advanceTimersByTime(3000); });
    expect(container.querySelector('.pcMeta')!.textContent).toContain(T.progressElapsed(13));
  });

  it('끝난 카드의 시간은 멈춰 있다(마지막 단계까지의 총 시간)', () => {
    vi.useFakeTimers();
    const g = group([step('· 시작', 100), step('· 끝', 40)]);
    const { container } = render(<ProgressCard run={g} running={false} />);
    const before = container.querySelector('.pcMeta')!.textContent;
    act(() => { vi.advanceTimersByTime(5000); });
    expect(container.querySelector('.pcMeta')!.textContent).toBe(before);
  });
});
