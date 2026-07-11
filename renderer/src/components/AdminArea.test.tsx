import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AdminArea } from './AdminArea';

const users = [
  { id: 'u1', loginId: 'kim', displayName: 'Kim', role: 'owner' as const, status: 'active' as const, createdAt: '2026-01-01', sso: false },
  { id: 'u2', loginId: 'lee', displayName: 'Lee', role: 'member' as const, status: 'pending' as const, createdAt: '2026-01-02', sso: true },
];
const noop = { onApprove: vi.fn(), onSuspend: vi.fn(), onRestore: vi.fn(), onResetPassword: vi.fn(), onForceLogout: vi.fn(), onSaveSettings: vi.fn() };

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
});
