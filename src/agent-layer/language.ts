// LLM 지시문 언어 규칙(언어 리팩터). 순수 헬퍼 — env만 읽음, fs·두뇌 접근 0.
// 대화형=사용자 메시지 언어, 자율=설정 언어(ENGRAM_LANG), ingester=원본 언어.

const LANG_NAMES: Record<string, string> = {
  en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese',
  es: 'Spanish', fr: 'French', de: 'German',
};

// 언어 코드 → 영어 이름(자율 지시에 삽입). 미지 코드는 코드 그대로(모델이 해석).
export function languageName(code: string): string {
  return LANG_NAMES[(code ?? '').toLowerCase()] ?? code ?? 'English';
}

// 설정 언어 해석: chat.json.language → OS 로케일(2자) → en.
export function resolveLanguage(cfgLang?: string, osLocale?: string): string {
  const pick = (s?: string): string => { const v = s?.trim(); return v ? v.toLowerCase().split('-')[0] : ''; };
  return pick(cfgLang) || pick(osLocale) || 'en';
}

// 백엔드가 보는 설정 언어(자율 출력·회의록 등). main.ts가 ENGRAM_LANG로 주입.
export function configuredLang(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.ENGRAM_LANG?.trim().toLowerCase();
  return v || 'en';
}

export type DirectiveKind = 'interactive' | 'autonomous' | 'source' | 'none';

// 프롬프트 끝에 코드가 덧붙이는 출력 언어 지시(.md 편집으로 안 깨지게).
export function outputDirective(kind: DirectiveKind, lang?: string): string {
  switch (kind) {
    case 'interactive': return "Respond in the language of the user's latest message.";
    case 'autonomous': return `Respond in ${languageName(lang ?? configuredLang())}.`;
    case 'source': return 'Write the extracted facts in the same language as the source text.';
    default: return '';
  }
}
