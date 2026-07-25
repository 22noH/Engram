// 독 브라우저 칸 주소 해석(순수 로직) — 사용자가 주소창에 친 것/끌어다 놓은 파일을 실제 URL로.
// webview는 iframe과 달리 로컬 파일(file://)을 열 수 있다(스펙 §칸별 규칙) — 그래서 경로 입력을
// 정식 기능으로 받는다. 대신 그 밖의 스킴(javascript:, chrome: 등)은 전부 거부한다.

const SCHEME_RE = /^([a-z][a-z0-9+.\-]*):/i;
const WIN_ABS_RE = /^[A-Za-z]:[\\/]/;      // C:\... 또는 C:/...
const UNC_RE = /^\\\\[^\\]+\\/;             // \\server\share\...
const HOSTPORT_RE = /^[A-Za-z0-9._~-]+(:\d{1,5})?(\/.*)?$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/** 로컬 파일 경로 → file:// URL. 역슬래시·공백·한글을 안전하게 인코딩한다. */
export function pathToFileUrl(p: string): string {
  const raw = p.trim().replace(/\\/g, '/');
  if (UNC_RE.test(p.trim())) {
    // \\server\share\a b.html → file://server/share/a%20b.html
    const rest = raw.replace(/^\/\//, '');
    return 'file://' + rest.split('/').map(encodeURIComponent).join('/').replace(/%3A/gi, ':');
  }
  const encoded = raw.split('/').map((seg) => encodeURIComponent(seg)).join('/').replace(/%3A/gi, ':');
  return 'file:///' + encoded.replace(/^\/+/, '');
}

/**
 * 주소창 입력 → 실제로 열 URL. 못 알아들으면 null(호출부가 "주소를 확인하세요"를 띄운다).
 * - http(s)/file은 그대로, 그 밖의 스킴은 전부 거부(javascript: 같은 건 절대 열지 않는다)
 * - `C:\...`, `/usr/...`, `\\srv\share\...` → file://
 * - `localhost:5173`, `192.168.0.5:3000` → http://
 * - `example.com/x` → https://
 */
export function toNavUrl(input: string): string | null {
  const s = (input ?? '').trim();
  if (!s) return null;
  if (WIN_ABS_RE.test(s) || UNC_RE.test(s)) return pathToFileUrl(s);
  const m = SCHEME_RE.exec(s);
  // `localhost:5173`은 스킴처럼 생겼지만 실제로는 host:port다 — 콜론 뒤가 숫자면 스킴으로 보지 않는다.
  if (m && !/^\d/.test(s.slice(m[0].length))) {
    const scheme = m[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https' || scheme === 'file') return s;
    return null; // javascript:, data:, chrome:, about: … 주소창으로는 안 연다
  }
  if (s.startsWith('//')) return 'https:' + s;      // //example.com
  if (s.startsWith('/')) return pathToFileUrl(s);    // /home/me/a.html
  if (!HOSTPORT_RE.test(s)) return null;
  const host = s.split('/')[0].split(':')[0].toLowerCase();
  if (LOCAL_HOSTS.has(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return 'http://' + s;
  if (s.split('/')[0].includes(':')) return 'http://' + s; // 포트가 붙었으면 개발 서버로 본다
  if (!host.includes('.')) return null;                    // 'asdf' 같은 건 주소가 아니다
  return 'https://' + s;
}

/** 주소창에 보여줄 짧은 표기(스킴 제거, file은 경로만). 실패하면 원본 그대로. */
export function displayUrl(url: string): string {
  if (!url) return '';
  if (url.startsWith('data:')) return url.slice(0, 40) + '…';
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname.replace(/^\/(?=[A-Za-z]:)/, ''));
    return (u.host + u.pathname + u.search).replace(/\/$/, '') || u.host;
  } catch { return url; }
}

/** 탭 제목 기본값 — 파일이면 파일명, 아니면 host(+포트). */
export function urlTitle(url: string): string {
  if (!url) return '';
  if (url.startsWith('data:')) return 'HTML';
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? url);
    return u.host;
  } catch { return url; }
}

/** 앱과 분리된 파티션이라도 외부 사이트는 사용자 확인을 거친다 — 내 컴퓨터/로컬 파일은 예외. */
export function isLocalUrl(url: string): boolean {
  if (!url) return true;
  if (url.startsWith('file:') || url.startsWith('data:') || url.startsWith('about:')) return true;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return LOCAL_HOSTS.has(h) || h.endsWith('.localhost') || /^192\.168\./.test(h) || /^10\./.test(h)
      || /^127\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  } catch { return false; }
}

/** 허용 목록 대조에 쓰는 키(호스트). URL이 아니면 null. */
export function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase() || null; } catch { return null; }
}
