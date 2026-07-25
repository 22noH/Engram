// 사이트 게이트 — "이 주소로 가도 되는가"와 "AI가 이 조작을 물어봐야 하는가"의 **단일 판정원**.
// 메인 프로세스(src/desktop/main.ts의 will-navigate 차단)와 렌더러(독 브라우저 칸·AI 조작)가
// 같은 함수를 부른다. 판정을 양쪽에 복사하면 반드시 어긋나므로 여기 한 곳에만 둔다.
// 런타임 값이 있는 shared 모듈이라 tsconfig(루트: shared 포함 / renderer: include ../shared) 양쪽에서 컴파일된다.

/** 자동 확인 3단계(목업 승인) — 매번 묻기 / 내 컴퓨터에서만(기본) / 항상 자동. */
export type ConfirmMode = 'ask' | 'local' | 'auto';

export const DEFAULT_CONFIRM_MODE: ConfirmMode = 'local';

export function isConfirmMode(v: unknown): v is ConfirmMode {
  return v === 'ask' || v === 'local' || v === 'auto';
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/** 허용 목록 대조에 쓰는 키(호스트). URL이 아니면 null. */
export function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * "내 컴퓨터" 판정 — 확인 없이 통과시키는 기본 허용 집합.
 * file:/data:/about:(HTML 크게 보기가 쓴다)과 localhost·사설망이 여기 든다.
 * 빈 주소도 true(아직 아무것도 안 연 상태 — 막을 대상이 없다).
 */
export function isLocalNavUrl(url: string): boolean {
  if (!url) return true;
  if (/^(file|data|about|blob):/i.test(url)) return true;
  const h = hostOfUrl(url);
  if (!h) return false;
  return (
    LOCAL_HOSTS.has(h) ||
    h.endsWith('.localhost') ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/**
 * 이 주소로 **이동**해도 되는가. 내 컴퓨터/로컬 파일은 항상 통과, 그 밖의 호스트는 허용 목록에 있어야 한다.
 * 사용자가 페이지 안에서 링크를 눌러 나가는 이동(메인의 will-navigate)과 앱이 여는 주소가 같은 규칙을 쓴다.
 */
export function isNavAllowed(url: string, allowedSites: readonly string[]): boolean {
  if (isLocalNavUrl(url)) return true;
  const h = hostOfUrl(url);
  if (!h) return false;
  return allowedSites.some((s) => s.toLowerCase() === h);
}

/**
 * AI 조작 1건을 실행하기 전에 사람에게 물어봐야 하는가.
 *  - ask   : 언제나 물어본다
 *  - local : 내 컴퓨터는 알아서, 외부 사이트는 매번 물어본다(기본)
 *  - auto  : 묻지 않는다
 * ※ 허용 목록에 있는 사이트라도 external이면 물어본다 — 허용 목록은 "열어도 되는 사이트"이지
 *   "AI가 마음대로 눌러도 되는 사이트"가 아니다(되돌리기 어려운 동작 방지).
 */
export function needsConfirm(mode: ConfirmMode, url: string): boolean {
  if (mode === 'auto') return false;
  if (mode === 'ask') return true;
  return !isLocalNavUrl(url);
}

// ---- 로그인·결제 입력 하드 차단(설정으로 못 푼다) ----

/** 입력 대상 칸에서 읽어낸 힌트(렌더러가 페이지에서 뽑아 넘긴다). */
export interface FieldInfo {
  type?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  placeholder?: string;
  label?: string;
}

// 이름/라벨/플레이스홀더에서 잡는 위험 신호. 한국어 서비스도 대상이라 한글 키워드를 함께 본다.
const SECRET_WORD_RE =
  /(pass\s*wo?r?d|passwd|pwd|otp|one[-_\s]?time|mfa|2fa|verification\s*code|security\s*code|카드\s*번호|비밀\s*번호|암호|인증\s*번호|주민\s*등록)/i;
const CARD_WORD_RE =
  /(card[-_\s]?number|cardnum|ccnum|credit\s*card|cc[-_\s]?number|cvv|cvc|csc|expiry|exp[-_\s]?date|카드|결제|계좌\s*번호|ssn|social\s*security)/i;
const CARD_AUTOCOMPLETE_RE = /^(cc-(number|csc|exp|exp-month|exp-year|name|type)|one-time-code)$/i;
const PASSWORD_AUTOCOMPLETE_RE = /^(current-password|new-password)$/i;

/**
 * 이 칸에 AI가 입력해도 되는가. 안 되면 사용자에게 보여줄 사유(한 줄)를 돌려준다.
 * ★어떤 설정으로도 풀 수 없는 하드 규칙(스펙 §안전 모델) — 호출부가 우회 인자를 갖지 않는다.
 */
export function credentialBlockReason(f: FieldInfo): string | null {
  const type = (f.type ?? '').toLowerCase();
  if (type === 'password') return 'password-field';
  const auto = (f.autocomplete ?? '').trim().toLowerCase();
  if (PASSWORD_AUTOCOMPLETE_RE.test(auto)) return 'password-field';
  if (CARD_AUTOCOMPLETE_RE.test(auto)) return 'payment-field';
  const hay = [f.name, f.id, f.placeholder, f.label].filter(Boolean).join(' ');
  if (SECRET_WORD_RE.test(hay)) return 'password-field';
  if (CARD_WORD_RE.test(hay)) return 'payment-field';
  return null;
}

/** 차단 사유 → 사용자/두뇌에게 보여줄 문구 키. UI 문구는 렌더러 i18n이 이 키로 고른다. */
export const CREDENTIAL_BLOCK_MESSAGE: Record<string, string> = {
  'password-field': 'Blocked: Engram never types sign-in credentials. Please enter it yourself.',
  'payment-field': 'Blocked: Engram never types payment details. Please enter it yourself.',
};
