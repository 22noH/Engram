import { brainErrorHint } from './brain-error-hints';

describe('brainErrorHint', () => {
  afterEach(() => { delete process.env.ENGRAM_LANG; });

  describe('CLI 미로그인', () => {
    it('실사고 원문(Not logged in · Please run /login)을 매핑한다', () => {
      expect(brainErrorHint('Not logged in · Please run /login')).toBe(
        'Claude CLI needs to log in — open a terminal, run `claude`, then `/login`, and try again.',
      );
    });
    it('authentication_failed 에러코드만 있어도 매핑한다', () => {
      expect(brainErrorHint('authentication_failed')).toContain('needs to log in');
    });
    it('/login 문자열만 있어도 매핑한다', () => {
      expect(brainErrorHint('please run /login first')).toContain('needs to log in');
    });
    it('ko 로케일', () => {
      process.env.ENGRAM_LANG = 'ko';
      expect(brainErrorHint('Not logged in · Please run /login')).toBe(
        'Claude CLI 로그인이 필요해요 — 터미널에서 `claude`를 열고 `/login`으로 로그인한 뒤 다시 시도해 주세요.',
      );
    });
  });

  describe('사용량/한도', () => {
    it('usage limit', () => {
      expect(brainErrorHint('usage limit reached for this account')).toBe('Usage limit reached — please try again in a bit.');
    });
    it('rate limit', () => {
      expect(brainErrorHint('rate limit exceeded')).toBe('Usage limit reached — please try again in a bit.');
    });
    it('HTTP 429', () => {
      expect(brainErrorHint('Error: HTTP 429: {"error":{"message":"rate_limit_exceeded"}}')).toBe('Usage limit reached — please try again in a bit.');
    });
    it('ko 로케일', () => {
      process.env.ENGRAM_LANG = 'ko';
      expect(brainErrorHint('rate limit')).toBe('사용량 한도에 걸렸어요 — 잠시 후 다시 시도해 주세요.');
    });
  });

  describe('CLI 미설치(ENOENT)', () => {
    it('spawn-error: ENOENT', () => {
      expect(brainErrorHint('spawn-error: ENOENT')).toBe("Can't find the Claude CLI — check the install in Settings → Model.");
    });
    it('ENOENT 단독', () => {
      expect(brainErrorHint('spawn claude ENOENT')).toContain("Can't find the Claude CLI");
    });
    it('ko 로케일', () => {
      process.env.ENGRAM_LANG = 'ko';
      expect(brainErrorHint('spawn-error: ENOENT')).toBe('Claude CLI를 찾을 수 없어요 — 설정 → 모델에서 설치 여부를 확인해 주세요.');
    });
  });

  describe('잘못된 API 키', () => {
    it('HTTP 401', () => {
      expect(brainErrorHint('Error: HTTP 401: {"error":{"message":"invalid x-api-key"}}')).toBe('Invalid API key — please check it in Settings.');
    });
    it('invalid api key 문구만', () => {
      expect(brainErrorHint('invalid api key provided')).toBe('Invalid API key — please check it in Settings.');
    });
    it('ko 로케일', () => {
      process.env.ENGRAM_LANG = 'ko';
      expect(brainErrorHint('HTTP 401: invalid x-api-key')).toBe('API 키가 올바르지 않아요 — 설정에서 API 키를 확인해 주세요.');
    });
  });

  describe('미지(unknown) 폴백', () => {
    it('raw 없음(undefined) — 기존 문구와 바이트 동일', () => {
      expect(brainErrorHint(undefined)).toBe('Answer generation failed: model call error');
    });
    it('raw가 빈 문자열이어도 스니펫을 안 붙인다', () => {
      expect(brainErrorHint('')).toBe('Answer generation failed: model call error');
    });
    it('매칭 안 되는 raw는 기존 문구 뒤에 코드스팬 원문 한 줄을 덧붙인다', () => {
      const out = brainErrorHint('ECONNRESET: socket hang up');
      expect(out).toBe('Answer generation failed: model call error\n`ECONNRESET: socket hang up`');
    });
    it('ko 로케일', () => {
      process.env.ENGRAM_LANG = 'ko';
      const out = brainErrorHint('ECONNRESET: socket hang up');
      expect(out).toBe('답변 생성 실패: 모델 호출 오류\n`ECONNRESET: socket hang up`');
    });
  });

  describe('새니타이즈(프롬프트 인젝션·길이 방어)', () => {
    it('제어문자·개행을 공백으로 치환한다(스니펫 부분만 검사 — 문구 자체 개행 1개는 구분자)', () => {
      const raw = 'line1\nline2\ttab\x00null';
      const out = brainErrorHint(raw);
      const snippetMatch = out.match(/`(.*)`/s);
      expect(snippetMatch).not.toBeNull();
      expect(snippetMatch![1]).not.toMatch(/[\x00-\x1f\x7f]/);
      expect(snippetMatch![1]).toBe('line1 line2 tab null');
    });
    it('120자로 캡한다', () => {
      const raw = 'x'.repeat(500);
      const out = brainErrorHint(raw);
      const snippetMatch = out.match(/`(.*)`/s);
      expect(snippetMatch).not.toBeNull();
      expect(snippetMatch![1].length).toBeLessThanOrEqual(120);
    });
    it('숫자가 아닌 raw(non-string)도 안전하게 문자열화한다', () => {
      expect(() => brainErrorHint({ some: 'object' })).not.toThrow();
      expect(() => brainErrorHint(42)).not.toThrow();
    });
  });
});
