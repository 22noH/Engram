import type { Account } from './account-store';
import type { Group } from './group-store';
import { sanitizePermissions, type Permission } from './permissions';

// 유효 권한/채널 해소기(서버 콘솔 S2 §2.2, Global Constraints: 더하기/합집합).
// 유효 권한 = 개인 permissions ∪ 소속 그룹들의 permissions. 그룹은 권한을 주기만 한다(뺄셈 없음).
// owner 전권 처리는 permissions.ts의 can()이 role 단락으로 계속 담당 — 여기서는 손대지 않는다
// (브리프: "owner=전권 별도 처리 유지"). 그룹 미사용(groups=[])이면 개인 권한 그대로(회귀 0).
export function effectivePermissions(acc: Account, groups: Group[]): Permission[] {
  const own = sanitizePermissions(acc.permissions ?? []);
  const fromGroups = groups
    .filter((g) => g.memberIds.includes(acc.id))
    .flatMap((g) => sanitizePermissions(g.permissions));
  return Array.from(new Set([...own, ...fromGroups]));
}

// 그 계정이 그룹 경유로 접근 가능한 채널 id 목록(비공개 채널 접근 판정용 — 채널 memberIds와 합집합해
// 쓴다, 호출부는 self.adapter의 canAccessChannel). 그룹 미사용이면 빈 배열(회귀 0).
export function groupChannelIdsFor(accountId: string, groups: Group[]): string[] {
  const ids = groups
    .filter((g) => g.memberIds.includes(accountId))
    .flatMap((g) => g.channelIds);
  return Array.from(new Set(ids));
}
