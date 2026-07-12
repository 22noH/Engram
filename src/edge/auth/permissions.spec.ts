import { can, isPermission, sanitizePermissions, PERMISSIONS } from './permissions';

describe('permissions', () => {
  it('키 목록은 정확히 두 개', () => {
    expect([...PERMISSIONS]).toEqual(['wiki.approve', 'channels.manage']);
  });

  it('can: owner는 권한 배열 무관 전권', () => {
    expect(can({ role: 'owner' }, 'wiki.approve')).toBe(true);
    expect(can({ role: 'owner', permissions: [] }, 'channels.manage')).toBe(true);
  });

  it('can: member는 보유 권한만 true', () => {
    expect(can({ role: 'member', permissions: ['wiki.approve'] }, 'wiki.approve')).toBe(true);
    expect(can({ role: 'member', permissions: ['wiki.approve'] }, 'channels.manage')).toBe(false);
    expect(can({ role: 'member' }, 'wiki.approve')).toBe(false); // permissions 없음
  });

  it('can: 계정 undefined면 false', () => {
    expect(can(undefined, 'wiki.approve')).toBe(false);
  });

  it('isPermission: 유효 키만 true', () => {
    expect(isPermission('wiki.approve')).toBe(true);
    expect(isPermission('channels.manage')).toBe(true);
    expect(isPermission('wiki.delete')).toBe(false);
    expect(isPermission(42)).toBe(false);
  });

  it('sanitizePermissions: 유효 키만·중복 제거·비배열은 빈 배열', () => {
    expect(sanitizePermissions(['wiki.approve', 'bogus', 'channels.manage', 'wiki.approve']))
      .toEqual(['wiki.approve', 'channels.manage']);
    expect(sanitizePermissions('nope')).toEqual([]);
    expect(sanitizePermissions(null)).toEqual([]);
  });
});
