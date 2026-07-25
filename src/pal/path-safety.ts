import * as path from 'path';

// 경로 안전 판정 공용부. agent-layer/permission-fence.ts에 있던 두 조각(시스템 폴더 목록 +
// 포함 검사)을 그대로 옮겨온 것 — 설정 경로 검증(edge/settings-registry.ts)도 같은 판정을 써야
// 하는데, knowledge-core/edge가 agent-layer를 역의존할 수는 없어 pal(플랫폼 추상화)로 내렸다.
// ★로직 복사 금지: 판정은 여기 한 곳에만 있고, PermissionFence도 이 함수들을 호출한다.

// Windows 대소문자 무감지 + .. 정규화 후 접두사 비교. target이 base 자신이거나 그 하위면 true.
export function isWithin(targetPath: string, basePath: string): boolean {
  const norm = (p: string): string => path.normalize(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const t = norm(targetPath);
  const b = norm(basePath);
  return t === b || t.startsWith(b + '/');
}

// 시스템 디렉터리(설정 무관 항상 거부하는 백스톱). env에서 실제 경로를 해소하고
// (다른 드라이브·로캘 대비) 하드코딩 폴백을 더한다. isWithin이 슬래시/대소문자를 정규화하므로
// 백슬래시 값도 그대로 넣어도 된다.
export function systemDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    env.SystemRoot, env.windir, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.ProgramData,
    'C:/Windows', 'C:/Program Files', 'C:/Program Files (x86)', 'C:/ProgramData',
    // POSIX 계열 — 데스크톱 앱이 mac/linux에서도 돌기 때문에 같이 막는다(사용자 홈의
    // ~/Library는 여기 걸리지 않는다 — isWithin은 접두사 비교라 /Library와 다르다).
    '/etc', '/bin', '/sbin', '/usr/bin', '/usr/sbin', '/boot', '/System', '/Library',
  ].filter((d): d is string => !!d);
}

// 파일시스템 루트인가(C:\ · / 등). 감시 폴더로는 너무 넓다.
export function isFilesystemRoot(p: string): boolean {
  const resolved = path.resolve(p);
  return path.dirname(resolved) === resolved;
}
