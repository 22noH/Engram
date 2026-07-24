import { t } from './i18n';

// 두뇌 실패 사유 표면화(라이브 사고: Claude CLI가 350ms 만에 "Not logged in · Please run /login"으로
// 죽었는데 사용자는 뭉뚱그린 실패 문구만 봤다). BrainResult.raw(brain 어댑터가 채운 원본 에러 텍스트)를
// 훑어 알려진 실패유형이면 실행 가능한 안내로, 아니면 기존 일반 문구 + 원문 에러 한 줄(새니타이즈)로.
// 순수 함수 — i18n.t()만 부르고 부작용 없음. 호출부(orchestrator.ts·reader-agent.ts)가 r.raw를 그대로 넘긴다.
const CTRL_CHARS = /[\x00-\x1f\x7f]+/g; // 개행 포함 제어문자 → 공백(로그 주입·프롬프트 구조 오염 방지)
const RAW_SNIPPET_CAP = 120;

const NOT_LOGGED_IN = /not logged in|authentication_failed|\/login/i;
const RATE_LIMIT = /usage limit|rate limit|\b429\b/i;
const CLI_NOT_FOUND = /enoent|spawn-error/i;
const INVALID_API_KEY = /\b401\b|invalid x-api-key|invalid api key/i;

// 내부 경로·비밀값 유출 방지 + 프롬프트/UI 주입 방지: 제어문자(개행 포함)를 공백으로, 120자로 캡.
function sanitize(raw: string): string {
  return raw.replace(CTRL_CHARS, ' ').trim().slice(0, RAW_SNIPPET_CAP);
}

// raw를 알려진 실패유형에 매핑해 실행 가능한 로케일 문구를 돌려준다. 미지 raw(또는 raw 없음)면
// 기존 일반 문구에 짧은 원문 에러 한 줄을 코드스팬으로 감싸 덧붙인다(프롬프트 인젝션 방지).
export function brainErrorHint(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  if (NOT_LOGGED_IN.test(text)) return t('brainErrorNotLoggedIn');
  if (RATE_LIMIT.test(text)) return t('brainErrorRateLimit');
  if (CLI_NOT_FOUND.test(text)) return t('brainErrorCliNotFound');
  if (INVALID_API_KEY.test(text)) return t('brainErrorInvalidApiKey');
  const snippet = sanitize(text);
  return t('answerGenFailedBrainError', snippet ? `\`${snippet}\`` : undefined);
}
