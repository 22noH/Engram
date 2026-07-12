import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WikiArea } from './WikiArea';
import type { WikiPageMeta, ProposalDto } from '../../../shared/protocol';

const pages: WikiPageMeta[] = [
  { slug: 'alpha', title: 'Alpha', category: 'cat', status: 'published', updated: '2026-01-02T00:00:00Z' },
  { slug: 'beta', title: 'Beta', category: 'cat', status: 'draft', updated: '2026-01-02T00:00:00Z' },
];
const proposals: ProposalDto[] = [
  { id: 'p1', op: 'create', targetSlug: 's1', title: 'Prop One', category: 'cat', payload: 'proposed body', sources: ['src'], importance: 3, confidence: 0.8, reason: 'because' },
];

describe('WikiArea', () => {
  it('페이지 목록 렌더 + 클릭 시 onOpenPage', () => {
    const opened: string[] = [];
    render(<WikiArea pages={pages} openPage={null} proposals={[]} canApprove={true} onOpenPage={(s) => opened.push(s)} onApprove={() => {}} onReject={() => {}} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Alpha'));
    expect(opened).toEqual(['alpha']);
  });

  it('필터가 제목으로 목록을 좁힌다', () => {
    render(<WikiArea pages={pages} openPage={null} proposals={[]} canApprove={true} onOpenPage={() => {}} onApprove={() => {}} onReject={() => {}} />);
    const filter = screen.getByPlaceholderText(/filter|필터/i);
    fireEvent.change(filter, { target: { value: 'alph' } });
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
  });

  it('승인함 탭: 제안 카드 렌더 + 승인/거부 콜백', () => {
    const approved: string[] = []; const rejected: string[] = [];
    render(<WikiArea pages={[]} openPage={null} proposals={proposals} canApprove={true} onOpenPage={() => {}} onApprove={(id) => approved.push(id)} onReject={(id) => rejected.push(id)} />);
    // 승인함 하위탭으로 전환
    fireEvent.click(screen.getByText(/inbox|승인함/i));
    expect(screen.getByText('because')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /approve|승인/i }));
    expect(approved).toEqual(['p1']);
    fireEvent.click(screen.getByRole('button', { name: /reject|거부/i }));
    expect(rejected).toEqual(['p1']);
  });

  it('canApprove=false면 승인/거부 버튼 미표시(승인함은 읽기전용)', () => {
    render(<WikiArea pages={[]} openPage={null} proposals={proposals} canApprove={false}
      onOpenPage={() => {}} onApprove={() => {}} onReject={() => {}} />);
    fireEvent.click(screen.getByText(/inbox|승인함/i));
    expect(screen.queryByRole('button', { name: /approve|승인/i })).toBeNull();
  });

  it('canApprove=true면 승인 버튼 표시', () => {
    render(<WikiArea pages={[]} openPage={null} proposals={proposals} canApprove={true}
      onOpenPage={() => {}} onApprove={() => {}} onReject={() => {}} />);
    fireEvent.click(screen.getByText(/inbox|승인함/i));
    expect(screen.getByRole('button', { name: /approve|승인/i })).toBeTruthy();
  });
});
