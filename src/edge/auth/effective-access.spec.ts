import { effectivePermissions, groupChannelIdsFor } from './effective-access';
import type { Account } from './account-store';
import type { Group } from './group-store';

function acc(over: Partial<Account> = {}): Account {
  return { id: 'u1', loginId: 'u1', displayName: 'U1', role: 'member', status: 'active', createdAt: 'x', ...over };
}
function grp(over: Partial<Group> = {}): Group {
  return { id: 'g1', name: 'g', memberIds: [], permissions: [], channelIds: [], createdAt: 'x', ...over };
}

describe('effectivePermissions', () => {
  it('그룹 없는 계정 = 개인 권한 그대로(회귀 규약)', () => {
    const a = acc({ permissions: ['wiki.edit'] });
    expect(effectivePermissions(a, []).sort()).toEqual(['wiki.edit']);
  });

  it('개인 권한 없고 그룹 소속만 있으면 그룹 권한이 유효 권한', () => {
    const a = acc({ permissions: [] });
    const g = grp({ memberIds: ['u1'], permissions: ['wiki.approve'] });
    expect(effectivePermissions(a, [g])).toEqual(['wiki.approve']);
  });

  it('개인 ∪ 그룹 합집합(더하기, 사용자 확정) — 중복 제거', () => {
    const a = acc({ permissions: ['wiki.edit'] });
    const g1 = grp({ id: 'g1', memberIds: ['u1'], permissions: ['wiki.approve', 'wiki.edit'] });
    const g2 = grp({ id: 'g2', memberIds: ['u1'], permissions: ['wiki.delete'] });
    const result = effectivePermissions(a, [g1, g2]).sort();
    expect(result).toEqual(['wiki.approve', 'wiki.delete', 'wiki.edit']);
  });

  it('소속 아닌 그룹의 권한은 섞이지 않는다', () => {
    const a = acc({ permissions: [] });
    const g = grp({ memberIds: ['other-user'], permissions: ['wiki.approve'] });
    expect(effectivePermissions(a, [g])).toEqual([]);
  });

  it('그룹 permissions에 불허 토큰이 섞여도 소독된다', () => {
    const a = acc({ permissions: [] });
    const g = grp({ memberIds: ['u1'], permissions: ['wiki.approve', 'bogus'] });
    expect(effectivePermissions(a, [g])).toEqual(['wiki.approve']);
  });

  it('owner 전권은 이 함수가 아니라 can()의 role 단락 몫 — 여기선 그냥 개인/그룹 합집합만', () => {
    const a = acc({ role: 'owner', permissions: [] });
    expect(effectivePermissions(a, [])).toEqual([]);
  });
});

describe('groupChannelIdsFor', () => {
  it('그룹 없으면 빈 배열(회귀 규약)', () => {
    expect(groupChannelIdsFor('u1', [])).toEqual([]);
  });

  it('소속 그룹들의 채널 id 합집합(중복 제거)', () => {
    const g1 = grp({ id: 'g1', memberIds: ['u1'], channelIds: ['c1', 'c2'] });
    const g2 = grp({ id: 'g2', memberIds: ['u1'], channelIds: ['c2', 'c3'] });
    expect(groupChannelIdsFor('u1', [g1, g2]).sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('소속 아닌 그룹의 채널은 포함되지 않는다', () => {
    const g = grp({ memberIds: ['other'], channelIds: ['c1'] });
    expect(groupChannelIdsFor('u1', [g])).toEqual([]);
  });
});
