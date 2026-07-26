import { render, screen, fireEvent } from '@testing-library/react';
import { WikiSaveCard } from './WikiSaveCard';
import type { WikiSaveAsk } from '../../../shared/protocol';

// 저장 확인 카드(목업 B 승인 2026-07-26) — 이 카드가 "무엇을 저장하는지"를 보여주는 게 존재 이유다.
// 제목·대상(새 페이지/이어붙이기)·본문 미리보기가 실제로 렌더되는지, 답이 정확히 한 번 나가는지 고정한다.
const base: WikiSaveAsk = { id: 'save-1', title: '릴리스 드래프트 경합', preview: '본문 앞부분…', bytes: 4300 };

describe('WikiSaveCard', () => {
  it('새 페이지: 제목·미리보기·크기를 보여주고 새 페이지임을 표시한다', () => {
    render(<WikiSaveCard ask={base} onAnswer={() => {}} />);
    expect(screen.getByText('릴리스 드래프트 경합')).toBeTruthy();
    expect(screen.getByText('본문 앞부분…')).toBeTruthy();
    expect(document.querySelector('.wsBadge')?.textContent).toMatch(/new page|새 페이지/i);
    expect(document.body.textContent).toContain('4.2 KB');
  });

  it('이어붙이기: 대상 슬러그를 보여준다(어디에 붙는지 모르고 승인하면 안 된다)', () => {
    render(<WikiSaveCard ask={{ ...base, targetSlug: 'engram-make-latest-ux' }} onAnswer={() => {}} />);
    expect(document.querySelector('.wsBadge')?.textContent).toMatch(/append|이어붙이기/i);
    expect(document.body.textContent).toContain('engram-make-latest-ux');
  });

  it('저장/취소가 각각 id와 함께 정확히 한 번 올라간다', () => {
    const calls: Array<[string, string]> = [];
    const { unmount } = render(<WikiSaveCard ask={base} onAnswer={(id, d) => calls.push([id, d])} />);
    fireEvent.click(screen.getByRole('button', { name: /^save$|^저장$/i }));
    expect(calls).toEqual([['save-1', 'save']]);
    unmount();

    calls.length = 0;
    render(<WikiSaveCard ask={base} onAnswer={(id, d) => calls.push([id, d])} />);
    fireEvent.click(screen.getByRole('button', { name: /^cancel$|^취소$/i }));
    expect(calls).toEqual([['save-1', 'cancel']]);
  });
});
