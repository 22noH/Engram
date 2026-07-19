import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { WikiArea } from './WikiArea';
import { T } from '../i18n';
import type { WikiPageMeta, WikiPageDto, ProposalDto } from '../../../shared/protocol';

const pages: WikiPageMeta[] = [
  { slug: 'alpha', title: 'Alpha', category: 'cat', status: 'published', updated: '2026-01-02T00:00:00Z' },
  { slug: 'beta', title: 'Beta', category: 'cat', status: 'draft', updated: '2026-01-02T00:00:00Z' },
];
const proposals: ProposalDto[] = [
  { id: 'p1', op: 'create', targetSlug: 's1', title: 'Prop One', category: 'cat', payload: 'proposed body', sources: ['src'], importance: 3, confidence: 0.8, reason: 'because' },
];
const noActions = { canUnpublish: false, canEdit: false, canDelete: false, onUnpublish: () => {}, onEdit: () => {}, onDelete: () => {}, searchResults: [], onSearch: () => {} };

describe('WikiArea', () => {
  it('페이지 목록 렌더 + 클릭 시 onOpenPage', () => {
    const opened: string[] = [];
    render(<WikiArea pages={pages} openPage={null} proposals={[]} canApprove={true} {...noActions} onOpenPage={(s) => opened.push(s)} onApprove={() => {}} onReject={() => {}} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Alpha'));
    expect(opened).toEqual(['alpha']);
  });

  it('검색창이 비면 전체 목록을 브라우즈한다', () => {
    render(<WikiArea pages={pages} openPage={null} proposals={[]} canApprove={true} {...noActions} onOpenPage={() => {}} onApprove={() => {}} onReject={() => {}} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('타이핑하면 디바운스(300ms) 후 onSearch(query) 호출', () => {
    vi.useFakeTimers();
    const searched: string[] = [];
    render(<WikiArea pages={pages} openPage={null} proposals={[]} canApprove={true} {...noActions} onOpenPage={() => {}} onApprove={() => {}} onReject={() => {}} onSearch={(q) => searched.push(q)} />);
    fireEvent.change(screen.getByPlaceholderText(/search|검색/i), { target: { value: 'coffee' } });
    expect(searched).toEqual([]); // 아직 디바운스 전
    act(() => { vi.advanceTimersByTime(300); });
    expect(searched).toEqual(['coffee']);
    vi.useRealTimers();
  });

  it('검색어 있으면 searchResults를 결과 행(제목+스니펫, score 미표시)으로 렌더', () => {
    const hits = [{ slug: 'x', title: 'Xanadu', snippet: 'matched snippet text', score: 0.9 }];
    const opened: string[] = [];
    render(<WikiArea pages={pages} openPage={null} proposals={[]} canApprove={true} {...noActions} searchResults={hits} onOpenPage={(s) => opened.push(s)} onApprove={() => {}} onReject={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/search|검색/i), { target: { value: 'coffee' } });
    expect(screen.getByText('Xanadu')).toBeInTheDocument();
    expect(screen.getByText('matched snippet text')).toBeInTheDocument();
    expect(screen.queryByText('0.9')).toBeNull(); // score 미표시
    expect(screen.queryByText('Alpha')).toBeNull(); // 브라우즈 목록 아님
    fireEvent.click(screen.getByText('Xanadu'));
    expect(opened).toEqual(['x']);
  });

  it('세그먼트 배지가 승인 대기 건수를 보여준다', () => {
    render(<WikiArea pages={pages} openPage={null} proposals={proposals} canApprove={true} {...noActions} onOpenPage={() => {}} onApprove={() => {}} onReject={() => {}} />);
    expect(screen.getByText(String(proposals.length))).toBeInTheDocument();
  });

  it('대기 제안이 없으면 세그먼트 배지를 표시하지 않는다', () => {
    render(<WikiArea pages={pages} openPage={null} proposals={[]} canApprove={true} {...noActions} onOpenPage={() => {}} onApprove={() => {}} onReject={() => {}} />);
    expect(screen.queryByText('0')).toBeNull();
  });

  it('목록 항목은 제목과 상태 필을 별도 요소로 렌더한다', () => {
    render(<WikiArea pages={pages} openPage={null} proposals={[]} canApprove={true} {...noActions} onOpenPage={() => {}} onApprove={() => {}} onReject={() => {}} />);
    const title = screen.getByText('Alpha');
    const pill = screen.getByText(T.wikiStatusPublished);
    expect(title).toBeInTheDocument();
    expect(pill).toBeInTheDocument();
    expect(title).not.toBe(pill);
  });

  it('검색어 있고 결과 없으면 "결과 없음"', () => {
    render(<WikiArea pages={pages} openPage={null} proposals={[]} canApprove={true} {...noActions} searchResults={[]} onOpenPage={() => {}} onApprove={() => {}} onReject={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/search|검색/i), { target: { value: 'zzz' } });
    expect(screen.getByText(/no results|결과 없음/i)).toBeInTheDocument();
  });

  it('승인함 탭: 제안 카드 렌더 + 승인/거부 콜백', () => {
    const approved: string[] = []; const rejected: string[] = [];
    render(<WikiArea pages={[]} openPage={null} proposals={proposals} canApprove={true} {...noActions} onOpenPage={() => {}} onApprove={(id) => approved.push(id)} onReject={(id) => rejected.push(id)} />);
    // 승인함 하위탭으로 전환
    fireEvent.click(screen.getByText(/inbox|승인함/i));
    expect(screen.getByText('because')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /approve|승인/i }));
    expect(approved).toEqual(['p1']);
    fireEvent.click(screen.getByRole('button', { name: /reject|거부/i }));
    expect(rejected).toEqual(['p1']);
  });

  it('canApprove=false면 승인/거부 버튼 미표시(승인함은 읽기전용)', () => {
    render(<WikiArea pages={[]} openPage={null} proposals={proposals} canApprove={false} {...noActions}
      onOpenPage={() => {}} onApprove={() => {}} onReject={() => {}} />);
    fireEvent.click(screen.getByText(/inbox|승인함/i));
    expect(screen.queryByRole('button', { name: /approve|승인/i })).toBeNull();
  });

  it('canApprove=true면 승인 버튼 표시', () => {
    render(<WikiArea pages={[]} openPage={null} proposals={proposals} canApprove={true} {...noActions}
      onOpenPage={() => {}} onApprove={() => {}} onReject={() => {}} />);
    fireEvent.click(screen.getByText(/inbox|승인함/i));
    expect(screen.getByRole('button', { name: /approve|승인/i })).toBeTruthy();
  });

  const pubPage: WikiPageDto = { slug: 'alpha', title: 'Alpha', category: 'cat', status: 'published', updated: '2026-01-02T00:00:00Z', body: 'hello body' };
  const draftPage: WikiPageDto = { ...pubPage, slug: 'beta', title: 'Beta', status: 'draft', body: 'draft body' };
  const noop = () => {};
  function renderDoc(over: Partial<ComponentProps<typeof WikiArea>>) {
    return render(
      <WikiArea
        pages={pages} openPage={pubPage} proposals={[]} canApprove={false}
        canUnpublish={false} canEdit={false} canDelete={false}
        onOpenPage={noop} onApprove={noop} onReject={noop}
        onUnpublish={noop} onEdit={noop} onDelete={noop}
        searchResults={[]} onSearch={noop}
        {...over}
      />,
    );
  }

  it('canEdit면 Edit 버튼→인라인 편집기→저장 시 onEdit(slug, body)', () => {
    const edits: { s: string; b: string }[] = [];
    renderDoc({ canEdit: true, onEdit: (s, b) => edits.push({ s, b }) });
    fireEvent.click(screen.getByRole('button', { name: /edit|수정/i }));
    const ta = screen.getByDisplayValue('hello body'); // 편집기 textarea(필터 input과 구분)
    fireEvent.change(ta, { target: { value: 'new text' } });
    fireEvent.click(screen.getByRole('button', { name: /save|저장/i }));
    expect(edits).toEqual([{ s: 'alpha', b: 'new text' }]);
  });

  it('편집기 취소 시 onEdit 미호출·편집기 닫힘', () => {
    const edits: unknown[] = [];
    renderDoc({ canEdit: true, onEdit: () => edits.push(1) });
    fireEvent.click(screen.getByRole('button', { name: /edit|수정/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel|취소/i }));
    expect(edits).toEqual([]);
    expect(screen.queryByDisplayValue('hello body')).toBeNull();
  });

  it('canUnpublish면 Unpublish 버튼→onUnpublish(slug)', () => {
    const un: string[] = [];
    renderDoc({ canUnpublish: true, onUnpublish: (s) => un.push(s) });
    fireEvent.click(screen.getByRole('button', { name: /unpublish|내리기/i }));
    expect(un).toEqual(['alpha']);
  });

  it('canDelete면 Delete 버튼→confirm 수락 시 onDelete(slug)', () => {
    const dels: string[] = [];
    const orig = window.confirm; window.confirm = () => true;
    renderDoc({ canDelete: true, onDelete: (s) => dels.push(s) });
    fireEvent.click(screen.getByRole('button', { name: /^delete$|^삭제$/i }));
    expect(dels).toEqual(['alpha']);
    window.confirm = orig;
  });

  it('confirm 거절 시 onDelete 미호출', () => {
    const dels: string[] = [];
    const orig = window.confirm; window.confirm = () => false;
    renderDoc({ canDelete: true, onDelete: (s) => dels.push(s) });
    fireEvent.click(screen.getByRole('button', { name: /^delete$|^삭제$/i }));
    expect(dels).toEqual([]);
    window.confirm = orig;
  });

  it('권한 없으면 행위 버튼 미표시', () => {
    renderDoc({});
    expect(screen.queryByRole('button', { name: /edit|수정/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /unpublish|내리기/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^delete$|^삭제$/i })).toBeNull();
  });

  it('draft 페이지는 권한 있어도 행위 버튼 미표시(게시 페이지만 대상)', () => {
    renderDoc({ openPage: draftPage, canEdit: true, canUnpublish: true, canDelete: true });
    expect(screen.queryByRole('button', { name: /edit|수정/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /unpublish|내리기/i })).toBeNull();
  });
});
