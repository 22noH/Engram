import { languageName, resolveLanguage, configuredLang, outputDirective } from './language';

describe('language helpers', () => {
  it('languageName maps known codes, falls back to the code', () => {
    expect(languageName('en')).toBe('English');
    expect(languageName('ko')).toBe('Korean');
    expect(languageName('xx')).toBe('xx');
  });
  it('resolveLanguage: cfg > osLocale(2자) > en', () => {
    expect(resolveLanguage('ko', 'en-US')).toBe('ko');
    expect(resolveLanguage(' ', 'ko-KR')).toBe('ko');
    expect(resolveLanguage(undefined, undefined)).toBe('en');
    expect(resolveLanguage('ko-KR', undefined)).toBe('ko');
    expect(resolveLanguage('EN', undefined)).toBe('en');
  });
  it('configuredLang reads ENGRAM_LANG, defaults en', () => {
    expect(configuredLang({ ENGRAM_LANG: 'ko' } as any)).toBe('ko');
    expect(configuredLang({} as any)).toBe('en');
    expect(configuredLang({ ENGRAM_LANG: 'KO' } as any)).toBe('ko');
  });
  it('outputDirective returns the standard strings', () => {
    expect(outputDirective('interactive')).toBe("Respond in the language of the user's latest message.");
    expect(outputDirective('autonomous', 'ko')).toBe('Respond in Korean.');
    expect(outputDirective('source')).toBe('Write the extracted facts in the same language as the source text.');
    expect(outputDirective('none')).toBe('');
  });
});
