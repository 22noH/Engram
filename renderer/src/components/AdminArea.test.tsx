import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AdminUserDto } from '../../../shared/protocol';
import { AdminArea } from './AdminArea';

const users = [
  { id: 'u1', loginId: 'kim', displayName: 'Kim', role: 'owner' as const, status: 'active' as const, createdAt: '2026-01-01', sso: false, permissions: [] },
  { id: 'u2', loginId: 'lee', displayName: 'Lee', role: 'member' as const, status: 'pending' as const, createdAt: '2026-01-02', sso: true, permissions: [] },
];
const noop = { onApprove: vi.fn(), onSuspend: vi.fn(), onRestore: vi.fn(), onResetPassword: vi.fn(), onForceLogout: vi.fn(), onSaveSettings: vi.fn(), onSetPermissions: vi.fn() };

describe('AdminArea', () => {
  it('pending 사용자에 승인/거부(=정지) 버튼, 클릭 시 콜백', () => {
    render(<AdminArea users={users} settings={{}} {...noop} />);
    expect(screen.getByText('Lee')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(noop.onApprove).toHaveBeenCalledWith('u2');
  });
  it('active member에 suspend/forceLogout, owner 행엔 suspend 버튼 없음', () => {
    const activeUsers = [users[0], { ...users[1], status: 'active' as const }];
    render(<AdminArea users={activeUsers} settings={{}} {...noop} />);
    fireEvent.click(screen.getByRole('button', { name: /suspend/i }));
    expect(noop.onSuspend).toHaveBeenCalledWith('u2');
    expect(screen.getAllByRole('button', { name: /suspend/i }).length).toBe(1); // owner 제외
  });
  it('설정 폼: 서버 이름·OIDC 저장', () => {
    render(<AdminArea users={users} settings={{ serverName: 'Old' }} {...noop} />);
    fireEvent.change(screen.getByPlaceholderText(/server name/i), { target: { value: 'Team' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(noop.onSaveSettings).toHaveBeenCalledWith(expect.objectContaining({ serverName: 'Team' }));
  });
  it('active member 행에 권한 체크박스 2개, 토글 시 onSetPermissions', () => {
    const onSetPermissions = vi.fn();
    const users2 = [
      { id: 'o', loginId: 'boss', displayName: 'Boss', role: 'owner' as const, status: 'active' as const, createdAt: '2026-01-01', sso: false, permissions: [] },
      { id: 'm', loginId: 'kim', displayName: 'Kim', role: 'member' as const, status: 'active' as const, createdAt: '2026-01-02', sso: false, permissions: ['wiki.approve'] },
    ];
    render(<AdminArea users={users2} settings={{}} onSetPermissions={onSetPermissions}
      onApprove={()=>{}} onSuspend={()=>{}} onRestore={()=>{}} onResetPassword={()=>{}} onForceLogout={()=>{}} onSaveSettings={()=>{}} />);
    // Kim 행: wiki.approve 체크됨, channels.manage 미체크. channels.manage 체크박스 클릭 → 둘 다 포함해 호출.
    const boxes = screen.getAllByRole('checkbox');
    const channelsBox = boxes.find((b) => b.getAttribute('data-perm') === 'channels.manage')!;
    fireEvent.click(channelsBox);
    expect(onSetPermissions).toHaveBeenCalledWith('m', expect.arrayContaining(['wiki.approve', 'channels.manage']));
  });
  it('owner 행은 "all" 표시·체크박스 없음(disabled)', () => {
    const users3 = [{ id: 'o', loginId: 'boss', displayName: 'Boss', role: 'owner' as const, status: 'active' as const, createdAt: '2026-01-01', sso: false, permissions: [] }];
    render(<AdminArea users={users3} settings={{}} onSetPermissions={()=>{}}
      onApprove={()=>{}} onSuspend={()=>{}} onRestore={()=>{}} onResetPassword={()=>{}} onForceLogout={()=>{}} onSaveSettings={()=>{}} />);
    expect(screen.queryAllByRole('checkbox').length).toBe(0);
  });
  it('active 멤버 행에 위키 파괴 3키 체크박스가 렌더된다', () => {
    const users: AdminUserDto[] = [
      { id: 'm1', displayName: 'Mem', role: 'member', loginId: 'mem', status: 'active', createdAt: '2026-01-01', sso: false, permissions: [] },
    ];
    render(
      <AdminArea users={users} settings={null}
        onApprove={() => {}} onSuspend={() => {}} onRestore={() => {}}
        onResetPassword={() => {}} onForceLogout={() => {}} onSaveSettings={() => {}}
        onSetPermissions={() => {}} />,
    );
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
    const box = document.querySelector('input[data-perm="wiki.delete"]') as HTMLInputElement;
    fireEvent.click(box);
    expect(calls).toEqual([{ id: 'm1', perms: ['wiki.delete'] }]);
  });
});
