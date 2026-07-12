import { can, isPermission, sanitizePermissions, PERMISSIONS } from './permissions';

describe('permissions', () => {
  it('키 목록은 정확히 다섯 개', () => {
    expect([...PERMISSIONS]).toEqual(['wiki.approve', 'channels.manage', 'wiki.unpublish', 'wiki.edit', 'wiki.delete']);
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
    expect(isPermission('wiki.delete')).toBe(true);
    expect(isPermission('wiki.edit')).toBe(true);
    expect(isPermission('wiki.unpublish')).toBe(true);
    expect(isPermission('bogus')).toBe(false);
    expect(isPermission(42)).toBe(false);
  });

  it('sanitizePermissions: 유효 키만·중복 제거·비배열은 빈 배열', () => {
    expect(sanitizePermissions(['wiki.approve', 'bogus', 'channels.manage', 'wiki.approve']))
      .toEqual(['wiki.approve', 'channels.manage']);
    expect(sanitizePermissions('nope')).toEqual([]);
    expect(sanitizePermissions(null)).toEqual([]);
  });
});

describe('파괴적 위키 권한 키(파괴적 행위)', () => {
  it('PERMISSIONS에 위키 파괴 3키가 포함된다', () => {
    expect(PERMISSIONS).toContain('wiki.unpublish');
    expect(PERMISSIONS).toContain('wiki.edit');
    expect(PERMISSIONS).toContain('wiki.delete');
  });
  it('owner는 신규 키 전부 통과', () => {
    const owner = { role: 'owner' };
    expect(can(owner, 'wiki.delete')).toBe(true);
    expect(can(owner, 'wiki.edit')).toBe(true);
    expect(can(owner, 'wiki.unpublish')).toBe(true);
  });
  it('member는 부여된 키만 통과', () => {
    const member = { role: 'member', permissions: ['wiki.edit'] };
    expect(can(member, 'wiki.edit')).toBe(true);
    expect(can(member, 'wiki.delete')).toBe(false);
  });
  it('sanitizePermissions가 신규 키를 수용한다', () => {
    expect(sanitizePermissions(['wiki.delete', 'bogus', 'wiki.unpublish']))
      .toEqual(['wiki.delete', 'wiki.unpublish']);
  });
});
