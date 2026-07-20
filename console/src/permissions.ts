import { T } from './i18n';

// src/edge/auth/permissions.ts의 PERMISSIONS 5종을 콘솔(별도 vite 번들)에서 쓰기 위한 미러.
// 콘솔은 서버 소스를 직접 import하지 않는 컨벤션(api.ts 관성)이라 상수만 복제한다 — 두 배열이
// 갈라지면 서버 쪽 sanitizePermissions가 걸러내므로(그 이상은 그냥 무시) 안전 측 실패다.
export const PERMISSIONS = ['wiki.edit', 'wiki.approve', 'channels.manage', 'wiki.unpublish', 'wiki.delete'] as const;
export type Permission = (typeof PERMISSIONS)[number];

const LABELS: Record<Permission, () => string> = {
  'wiki.edit': () => T.permWikiEdit,
  'wiki.approve': () => T.permWikiApprove,
  'channels.manage': () => T.permChannelsManage,
  'wiki.unpublish': () => T.permWikiUnpublish,
  'wiki.delete': () => T.permWikiDelete,
};

export function permissionLabel(p: string): string {
  const fn = LABELS[p as Permission];
  return fn ? fn() : p;
}
