import { describe, it, expect } from 'vitest';
import { allow } from './permissions';

describe('allow', () => {
  it('me 없으면(무인증 서버) true — 버튼 표시', () => {
    expect(allow(undefined, 'wiki.approve')).toBe(true);
  });
  it('owner는 전권', () => {
    expect(allow({ id: 'o', displayName: 'O', role: 'owner' }, 'wiki.approve')).toBe(true);
    expect(allow({ id: 'o', displayName: 'O', role: 'owner', permissions: [] }, 'channels.manage')).toBe(true);
  });
  it('member는 보유 권한만', () => {
    const m = { id: 'm', displayName: 'M', role: 'member' as const, permissions: ['wiki.approve'] };
    expect(allow(m, 'wiki.approve')).toBe(true);
    expect(allow(m, 'channels.manage')).toBe(false);
    expect(allow({ id: 'm', displayName: 'M', role: 'member' as const }, 'wiki.approve')).toBe(false);
  });
});
