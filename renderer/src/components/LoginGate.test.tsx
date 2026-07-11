import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LoginGate } from './LoginGate';

const base = { connName: 'Local', onLogin: vi.fn(), onRegister: vi.fn(), onSetup: vi.fn(), onSso: vi.fn() };

describe('LoginGate', () => {
  it('미설정 서버 → setup 폼(코드·아이디·비밀번호), 제출 시 onSetup', () => {
    const onSetup = vi.fn();
    render(<LoginGate {...base} onSetup={onSetup} status={{ configured: false, oidc: false }} setupCode="abc" />);
    fireEvent.change(screen.getByPlaceholderText(/id/i), { target: { value: 'boss' } });
    fireEvent.change(screen.getByPlaceholderText(/password/i), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(onSetup).toHaveBeenCalledWith('abc', 'boss', 'pw'); // setupCode 자동 주입
  });

  it('설정된 서버 → 로그인 폼, oidc면 SSO 버튼', () => {
    render(<LoginGate {...base} status={{ configured: true, oidc: true, serverName: 'Team' }} />);
    expect(screen.getByText('Team')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/id/i), { target: { value: 'kim' } });
    fireEvent.change(screen.getByPlaceholderText(/password/i), { target: { value: 'pw' } });
    // SSO 버튼도 "sign in"을 포함하므로("Sign in with SSO") 정확 일치로 로그인 버튼만 골라낸다.
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(base.onLogin).toHaveBeenCalledWith('kim', 'pw');
    fireEvent.click(screen.getByRole('button', { name: /sso/i }));
    expect(base.onSso).toHaveBeenCalled();
  });

  it('가입 전환 → onRegister / error=pending 안내 노출', () => {
    const onRegister = vi.fn();
    const r = render(<LoginGate {...base} onRegister={onRegister} status={{ configured: true, oidc: false }} />);
    fireEvent.click(screen.getByText(/register/i));
    fireEvent.change(screen.getByPlaceholderText(/id/i), { target: { value: 'lee' } });
    fireEvent.change(screen.getByPlaceholderText(/password/i), { target: { value: 'pw' } });
    fireEvent.change(screen.getByPlaceholderText(/display name/i), { target: { value: 'Lee' } });
    fireEvent.click(screen.getByRole('button', { name: /request/i }));
    expect(onRegister).toHaveBeenCalledWith('lee', 'pw', 'Lee');
    r.rerender(<LoginGate {...base} status={{ configured: true, oidc: false }} error="pending" />);
    expect(screen.getByText(/waiting for approval/i)).toBeTruthy();
  });
});
