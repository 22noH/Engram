import { t } from './i18n';

describe('t()', () => {
  afterEach(() => { delete process.env.ENGRAM_LANG; });
  it('defaults to English when ENGRAM_LANG unset', () => {
    expect(t('cancelled')).toBe('Cancelled.');
  });
  it('returns Korean when ENGRAM_LANG=ko', () => {
    process.env.ENGRAM_LANG = 'ko';
    expect(t('cancelled')).toBe('취소했어요.');
  });
  it('falls back to English for an unsupported language', () => {
    process.env.ENGRAM_LANG = 'ja';
    expect(t('cancelled')).toBe('Cancelled.');
  });
  it('interpolates args', () => {
    expect(t('teamFormed', 'A·B')).toBe('Team: A·B — looking into it');
    process.env.ENGRAM_LANG = 'ko';
    expect(t('teamFormed', 'A·B')).toBe('팀 구성: A·B — 알아볼게요');
  });
  it('scheduleCreated once suffix', () => {
    expect(t('scheduleCreated', 3, '0 9 * * *', true)).toBe('Okay, scheduled 📅 (schedule #3, 0 9 * * *) — once');
    expect(t('scheduleCreated', 3, '0 9 * * *', false)).toBe('Okay, scheduled 📅 (schedule #3, 0 9 * * *)');
  });
  it('unknown key throws (dev guard)', () => {
    expect(() => t('___nope___')).toThrow();
  });
});
