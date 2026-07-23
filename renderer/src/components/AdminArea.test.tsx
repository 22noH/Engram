import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AdminUserDto } from '../../../shared/protocol';
import { AdminArea } from './AdminArea';

const users = [
  { id: 'u1', loginId: 'kim', displayName: 'Kim', role: 'owner' as const, status: 'active' as const, createdAt: '2026-01-01', sso: false, permissions: [] },
  { id: 'u2', loginId: 'lee', displayName: 'Lee', role: 'member' as const, status: 'pending' as const, createdAt: '2026-01-02', sso: true, permissions: [] },
];
const noop = { onApprove: vi.fn(), onSuspend: vi.fn(), onRestore: vi.fn(), onResetPassword: vi.fn(), onForceLogout: vi.fn(), onSaveSettings: vi.fn(), onSetPermissions: vi.fn() };

// R2-2(Admin 재설계) — 액션은 이제 상당수가 행 ⋯ 팝오버 안에 있다(Channels.tsx #popmenu와 동일 이디엄).
// 팝오버 항목은 button이 아니라 div(기존 popmenu 관례) — 텍스트로 찾는다.
const openRowMenu = (rowName: string) => {
  const row = screen.getByText(rowName).closest('.memberRow') as HTMLElement;
  fireEvent.click(row.querySelector('.rowMenuBtn') as HTMLElement);
};

describe('AdminArea', () => {
  it('pending 사용자는 상단 하이라이트 카드로 뜨고, 승인/거부(=정지) 클릭 시 콜백', () => {
    render(<AdminArea users={users} settings={{}} {...noop} />);
    expect(screen.getByText('Lee')).toBeTruthy();
    expect(screen.getByText(/waiting for approval/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(noop.onApprove).toHaveBeenCalledWith('u2');
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));
    expect(noop.onSuspend).toHaveBeenCalledWith('u2');
  });
  it('active member 행 ⋯ 메뉴에 suspend·forceLogout, owner 행엔 suspend 항목 없음', () => {
    const activeUsers = [users[0], { ...users[1], status: 'active' as const }];
    render(<AdminArea users={activeUsers} settings={{}} {...noop} />);
    // 비owner(Lee) 행: suspend 항목 있음.
    openRowMenu('Lee');
    fireEvent.click(screen.getByText(/^suspend$/i));
    expect(noop.onSuspend).toHaveBeenCalledWith('u2');
    // owner(Kim) 행: suspend 항목 없음(제외), forceLogout은 있음.
    openRowMenu('Kim');
    expect(screen.queryByText(/^suspend$/i)).toBeNull();
    expect(screen.getByText(/force logout/i)).toBeTruthy();
  });
  it('설정 폼: 서버 이름·OIDC 저장', () => {
    render(<AdminArea users={users} settings={{ serverName: 'Old' }} {...noop} />);
    fireEvent.change(screen.getByPlaceholderText(/server name/i), { target: { value: 'Team' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(noop.onSaveSettings).toHaveBeenCalledWith(expect.objectContaining({ serverName: 'Team' }));
  });
  it('active member 행의 + 칩으로 권한 팝오버를 열면 체크박스가 뜨고, 토글 시 onSetPermissions', () => {
    const onSetPermissions = vi.fn();
    const users2 = [
      { id: 'o', loginId: 'boss', displayName: 'Boss', role: 'owner' as const, status: 'active' as const, createdAt: '2026-01-01', sso: false, permissions: [] },
      { id: 'm', loginId: 'kim', displayName: 'Kim', role: 'member' as const, status: 'active' as const, createdAt: '2026-01-02', sso: false, permissions: ['wiki.approve'] },
    ];
    render(<AdminArea users={users2} settings={{}} onSetPermissions={onSetPermissions}
      onApprove={()=>{}} onSuspend={()=>{}} onRestore={()=>{}} onResetPassword={()=>{}} onForceLogout={()=>{}} onSaveSettings={()=>{}} />);
    // Kim 행: wiki.approve 이미 부여 → 칩으로 보임. + 칩 클릭으로 팝오버 열기.
    expect(screen.getByText(/approve wiki/i)).toBeTruthy();
    fireEvent.click(screen.getByTitle(/add permission/i));
    const boxes = screen.getAllByRole('checkbox');
    const channelsBox = boxes.find((b) => b.getAttribute('data-perm') === 'channels.manage')!;
    fireEvent.click(channelsBox);
    expect(onSetPermissions).toHaveBeenCalledWith('m', expect.arrayContaining(['wiki.approve', 'channels.manage']));
  });
  it('owner 행은 "all" 표시·체크박스 없음(+ 칩도 없음)', () => {
    const users3 = [{ id: 'o', loginId: 'boss', displayName: 'Boss', role: 'owner' as const, status: 'active' as const, createdAt: '2026-01-01', sso: false, permissions: [] }];
    render(<AdminArea users={users3} settings={{}} onSetPermissions={()=>{}}
      onApprove={()=>{}} onSuspend={()=>{}} onRestore={()=>{}} onResetPassword={()=>{}} onForceLogout={()=>{}} onSaveSettings={()=>{}} />);
    expect(screen.queryByTitle(/add permission/i)).toBeNull();
    expect(screen.queryAllByRole('checkbox').length).toBe(0);
  });
  it('active 멤버 행의 권한 팝오버에 위키 파괴 3키 체크박스가 렌더된다', () => {
    const users: AdminUserDto[] = [
      { id: 'm1', displayName: 'Mem', role: 'member', loginId: 'mem', status: 'active', createdAt: '2026-01-01', sso: false, permissions: [] },
    ];
    render(
      <AdminArea users={users} settings={null}
        onApprove={() => {}} onSuspend={() => {}} onRestore={() => {}}
        onResetPassword={() => {}} onForceLogout={() => {}} onSaveSettings={() => {}}
        onSetPermissions={() => {}} />,
    );
    fireEvent.click(screen.getByTitle(/add permission/i));
    expect(document.querySelector('input[data-perm="wiki.unpublish"]')).toBeTruthy();
    expect(document.querySelector('input[data-perm="wiki.edit"]')).toBeTruthy();
    expect(document.querySelector('input[data-perm="wiki.delete"]')).toBeTruthy();
  });

  it('wiki.delete 체크 시 onSetPermissions에 키가 추가된다', () => {
    const calls: { id: string; perms: string[] }[] = [];
    const users: AdminUserDto[] = [
      { id: 'm1', displayName: 'Mem', role: 'member', loginId: 'mem', status: 'active', createdAt: '2026-01-01', sso: false, permissions: [] },
    ];
    render(
      <AdminArea users={users} settings={null}
        onApprove={() => {}} onSuspend={() => {}} onRestore={() => {}}
        onResetPassword={() => {}} onForceLogout={() => {}} onSaveSettings={() => {}}
        onSetPermissions={(id, perms) => calls.push({ id, perms })} />,
    );
    fireEvent.click(screen.getByTitle(/add permission/i));
    const box = document.querySelector('input[data-perm="wiki.delete"]') as HTMLInputElement;
    fireEvent.click(box);
    expect(calls).toEqual([{ id: 'm1', perms: ['wiki.delete'] }]);
  });

  // R2-2 신규 케이스 — suspended 멤버 복구, resetPassword(⋯ 메뉴로 이동), pending resetPassword 도달성.
  it('suspended member 행 ⋯ 메뉴의 restore 클릭 시 onRestore', () => {
    const suspended = [{ id: 's1', loginId: 'kim', displayName: 'Sus', role: 'member' as const, status: 'suspended' as const, createdAt: '2026-01-01', sso: false, permissions: [] }];
    render(<AdminArea users={suspended} settings={{}} {...noop} />);
    openRowMenu('Sus');
    fireEvent.click(screen.getByText(/^restore$/i));
    expect(noop.onRestore).toHaveBeenCalledWith('s1');
  });
  it('resetPassword: 비SSO active 멤버 ⋯ 메뉴에서 prompt 값으로 콜백', () => {
    const onResetPassword = vi.fn();
    vi.spyOn(window, 'prompt').mockReturnValue('newpw');
    const u = [{ id: 'p1', loginId: 'kim', displayName: 'Pw', role: 'member' as const, status: 'active' as const, createdAt: '2026-01-01', sso: false, permissions: [] }];
    render(<AdminArea users={u} settings={{}} {...noop} onResetPassword={onResetPassword} />);
    openRowMenu('Pw');
    fireEvent.click(screen.getByText(/reset password/i));
    expect(onResetPassword).toHaveBeenCalledWith('p1', 'newpw');
  });
  it('resetPassword: 비SSO pending 사용자도 ⋯로 도달 가능(기능 패리티 — 원본은 status 무관이었음)', () => {
    const onResetPassword = vi.fn();
    vi.spyOn(window, 'prompt').mockReturnValue('newpw');
    const u = [{ id: 'q1', loginId: 'kim', displayName: 'Pend', role: 'member' as const, status: 'pending' as const, createdAt: '2026-01-01', sso: false, permissions: [] }];
    render(<AdminArea users={u} settings={{}} {...noop} onResetPassword={onResetPassword} />);
    const card = screen.getByText('Pend').closest('.pendingCard') as HTMLElement;
    fireEvent.click(card.querySelector('.moreBtn') as HTMLElement);
    fireEvent.click(screen.getByText(/reset password/i));
    expect(onResetPassword).toHaveBeenCalledWith('q1', 'newpw');
  });
});
