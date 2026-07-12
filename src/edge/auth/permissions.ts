// 행위별 권한(Phase 16b 스펙 §2.1). owner는 전권(role 단락). 무인증 경로는 호출자가 게이트를
// 아예 건너뛰므로 이 함수는 "계정이 있을 때"의 판정만 담당한다.

export const PERMISSIONS = ['wiki.approve', 'channels.manage'] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function can(account: { role: string; permissions?: string[] } | undefined, perm: Permission): boolean {
  if (!account) return false;
  return account.role === 'owner' || (account.permissions ?? []).includes(perm);
}

export function isPermission(v: unknown): v is Permission {
  return typeof v === 'string' && (PERMISSIONS as readonly string[]).includes(v);
}

export function sanitizePermissions(v: unknown): Permission[] {
  if (!Array.isArray(v)) return [];
  const out: Permission[] = [];
  for (const x of v) if (isPermission(x) && !out.includes(x)) out.push(x);
  return out;
}
