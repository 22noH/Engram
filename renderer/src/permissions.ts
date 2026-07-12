import type { UserDto } from '../../shared/protocol';

// UI 게이트용(스펙 §3.1). me가 없으면(=무인증 서버라 authOk가 온 적 없음) 제한 없음으로 버튼 표시.
// me가 있으면 owner 전권 또는 보유 권한으로 판정. 백엔드 순수 can(§2.1)과 달리 !me 단락을 둔다.
export function allow(me: UserDto | undefined, perm: string): boolean {
  if (!me) return true;
  return me.role === 'owner' || (me.permissions ?? []).includes(perm);
}
