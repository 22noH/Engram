# 언어 리팩터 Plan 1 — 지시문 영어화 + 출력 언어 분리 (A·B·C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LLM에 주는 지시문(프롬프트·페르소나)을 영어로 바꾸고, 출력 언어를 코드에서 분리한다 — 대화형은 사용자 메시지 언어, 자율은 설정 언어.

**Architecture:** 순수 헬퍼 `language.ts`(언어 지시문·설정언어 해석)를 두고, 각 LLM 조립부가 분류에 맞는 지시 1줄을 코드에서 덧붙인다(JSON 계약 줄과 같은 방식). 설정 언어는 `chat.json.language`→OS 로케일→`en`으로 해석해 `ENGRAM_LANG` env·`?lang=` 쿼리로 전달. 두뇌 코어·ws 프레임·저장 계층 무변경.

**Tech Stack:** NestJS/TypeScript, jest(백엔드), vitest(renderer), Electron.

## Global Constraints

- **JSON 출력 계약·propose 마커·차트 블록은 변경 금지** — 파서와 묶임. 영어 지시로 바꿔도 JSON 키(`kind`/`team`/`repo`/`goal`/`cron`/`task`/`once`/`approved`/`extraTickets`/`verdict`/`claim`/`importance`/`sourceQuote`/`interject`/`text`/`tickets`/`area`/`instruction`/`acceptanceCriteria`)와 ```` ```engram:propose ````·```` ```chart ```` 토큰은 byte 동일.
- **저장 계층·ws 프레임(`shared/protocol.ts`)·두뇌 코어 무변경.** 언어는 env/쿼리로만 전달(프로토콜 필드 안 늘림).
- **코드가 직접 찍는 사용자 대면 한국어 문자열(상태·헤더·폴백)은 이 플랜에서 건드리지 않는다** — Plan 2(백엔드 i18n) 범위. 이 플랜은 **LLM 지시문(프롬프트)만** 영어화한다.
- **`throw new Error('…한국어…')` 같은 내부 예외 메시지는 손대지 않는다**(사용자 대면 아님).
- 언어 지시 표준 문구(정확히 이 문자열):
  - interactive: `Respond in the language of the user's latest message.`
  - autonomous: `Respond in {LANGUAGE}.` (`{LANGUAGE}` = 설정 언어 이름)
  - source: `Write the extracted facts in the same language as the source text.`
- 한글 잔존 검사 정규식: `/[가-힣]/`.
- 백엔드 단위테스트: `npx jest <spec 경로>`. renderer: `npm --prefix renderer test`.

---

## Task 1: `language.ts` — 언어 지시·설정언어 순수 헬퍼

**Files:**
- Create: `src/agent-layer/language.ts`
- Test: `src/agent-layer/language.spec.ts`

**Interfaces:**
- Produces:
  - `languageName(code: string): string`
  - `resolveLanguage(cfgLang?: string, osLocale?: string): string`
  - `configuredLang(env?: NodeJS.ProcessEnv): string`
  - `outputDirective(kind: 'interactive'|'autonomous'|'source'|'none', lang?: string): string`

- [ ] **Step 1: 실패 테스트 작성** — `src/agent-layer/language.spec.ts`

```ts
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
  });
  it('configuredLang reads ENGRAM_LANG, defaults en', () => {
    expect(configuredLang({ ENGRAM_LANG: 'ko' } as any)).toBe('ko');
    expect(configuredLang({} as any)).toBe('en');
  });
  it('outputDirective returns the standard strings', () => {
    expect(outputDirective('interactive')).toBe("Respond in the language of the user's latest message.");
    expect(outputDirective('autonomous', 'ko')).toBe('Respond in Korean.');
    expect(outputDirective('source')).toBe('Write the extracted facts in the same language as the source text.');
    expect(outputDirective('none')).toBe('');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/agent-layer/language.spec.ts`
Expected: FAIL (`Cannot find module './language'`)

- [ ] **Step 3: 구현** — `src/agent-layer/language.ts`

```ts
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
  const c = cfgLang?.trim();
  if (c) return c;
  const o = osLocale?.trim();
  if (o) return o.slice(0, 2).toLowerCase();
  return 'en';
}

// 백엔드가 보는 설정 언어(자율 출력·회의록 등). main.ts가 ENGRAM_LANG로 주입.
export function configuredLang(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.ENGRAM_LANG?.trim();
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
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/agent-layer/language.spec.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/agent-layer/language.ts src/agent-layer/language.spec.ts
git commit -m "feat(i18n): 언어 지시·설정언어 순수 헬퍼(language.ts)"
```

---

## Task 2: 설정 언어 배선 — chat.config + main.ts + renderer

**Files:**
- Modify: `src/edge/messenger/chat.config.ts` (ChatConfig에 `language?`)
- Modify: `src/desktop/main.ts` (childEnv.ENGRAM_LANG, loadFile search에 lang)
- Modify: `renderer/src/config.ts` (`?lang=` 우선, navigator 폴백)
- Test: `src/edge/messenger/chat.config.spec.ts` (기존 파일에 케이스 추가; 없으면 생성)
- Test: `renderer/src/config.test.ts` (없으면 생성)

**Interfaces:**
- Consumes: `resolveLanguage` (Task 1).
- Produces: `ChatConfig.language?: string`; 백엔드 `process.env.ENGRAM_LANG`; renderer `LANG`.

- [ ] **Step 1: chat.config 실패 테스트** — `src/edge/messenger/chat.config.spec.ts`에 추가(파일 없으면 아래로 생성)

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadChatConfig } from './chat.config';

it('loadChatConfig reads optional language field', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ language: 'ko' }));
  expect(loadChatConfig(dir, {} as any).language).toBe('ko');
  expect(loadChatConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg2-')), {} as any).language).toBeUndefined();
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/edge/messenger/chat.config.spec.ts`
Expected: FAIL (`language` 없음 / 타입 에러)

- [ ] **Step 3: chat.config 구현** — `src/edge/messenger/chat.config.ts`

`ChatConfig` 인터페이스에 필드 추가:
```ts
export interface ChatConfig {
  enabled: boolean;
  port: number;
  bind: string;
  language?: string; // BCP-47 코드(예 'ko'/'en'). 미설정=OS 로케일 폴백(main.ts).
}
```
`loadChatConfig` return 직전에 language 추출 후 반환에 포함:
```ts
  const language = typeof raw.language === 'string' && raw.language.trim() ? raw.language.trim() : undefined;
  return { enabled: raw.enabled !== false, port, bind, language };
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/edge/messenger/chat.config.spec.ts`
Expected: PASS

- [ ] **Step 5: main.ts 배선(수동, 단위테스트 없음 — Electron)** — `src/desktop/main.ts`

상단 import 추가:
```ts
import { resolveLanguage } from '../agent-layer/language';
```
자식 spawn(`utilityProcess.fork`, 현재 45행)에서 env에 ENGRAM_LANG 주입 — 기존 `{ env: childEnv, … }`를:
```ts
  const lang = resolveLanguage(loadChatConfig(configDir).language, app.getLocale());
  child = utilityProcess.fork(entry, [], { env: { ...childEnv, ENGRAM_LANG: lang }, stdio: 'ignore', serviceName: 'engram-core' });
```
렌더러 로드(현재 164행 `loadFile(rendererIndex, { search: \`port=${cfg.port}\` })`)를:
```ts
      const lang = resolveLanguage(cfg.language, app.getLocale());
      if (chatWin) void chatWin.loadFile(rendererIndex, { search: `port=${cfg.port}&lang=${lang}` });
```

- [ ] **Step 6: renderer 실패 테스트** — `renderer/src/config.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';

describe('config LANG', () => {
  it('reads ?lang= first, falls back to navigator', async () => {
    vi.stubGlobal('location', { search: '?port=47800&lang=ko' } as any);
    const mod = await import('./config?1');
    expect(mod.LANG).toBe('ko');
  });
});
```

- [ ] **Step 7: 실패 확인**

Run: `npm --prefix renderer test`
Expected: FAIL (`LANG` export 없음)

- [ ] **Step 8: renderer 구현** — `renderer/src/config.ts` 끝에 추가

```ts
// 설정 언어: Electron이 ?lang= 주입(main.ts). 없으면 navigator 폴백('ko'|기타→2자).
const langParam = new URLSearchParams(window.location.search).get('lang');
export const LANG = (langParam && langParam.trim()) || navigator.language.slice(0, 2).toLowerCase();
```
(기존 `ko` export는 유지 — 이미 UI가 씀. `LANG`은 신규 소스.)

- [ ] **Step 9: 통과 확인 + 커밋**

Run: `npm --prefix renderer test` → PASS. `npx jest src/edge/messenger/chat.config.spec.ts` → PASS.
```bash
git add src/edge/messenger/chat.config.ts src/edge/messenger/chat.config.spec.ts src/desktop/main.ts renderer/src/config.ts renderer/src/config.test.ts
git commit -m "feat(i18n): 설정 언어 배선(chat.json.language→ENGRAM_LANG env·?lang= 쿼리)"
```

---

## Task 3: Insight 자율 출력 언어 고정 제거

**Files:**
- Modify: `src/agent-layer/insight-reporter.ts` (INSIGHT_DEFAULT 영어화 + 자율 지시)
- Modify: `prompts/insight.md` (영어, 상수와 동일 내용)
- Test: `src/agent-layer/insight-reporter.spec.ts` (기존에 추가; 없으면 생성)

**Interfaces:**
- Consumes: `outputDirective`, `configuredLang` (Task 1).

- [ ] **Step 1: 실패 테스트** — buildPrompt가 한글 없고 자율 지시 포함

```ts
import { InsightReporter } from './insight-reporter';

it('insight prompt: no Korean, appends configured-language directive', () => {
  const r = new InsightReporter({} as any, {} as any, {} as any, { log(){}, warn(){}, error(){} } as any);
  process.env.ENGRAM_LANG = 'ko';
  const p = (r as any).buildPrompt(
    { queryCount: 1, topTerms: [], topPages: [] },
    [{ question: 'q', answer: 'a', ts: '' }],
  ) as string;
  expect(/[가-힣]/.test(p)).toBe(false);            // 지시문·메트릭 라벨 전부 영어
  expect(p).toContain('Respond in Korean.');         // 자율=설정 언어
  delete process.env.ENGRAM_LANG;
});
```

- [ ] **Step 2: 실패 확인** — `npx jest src/agent-layer/insight-reporter.spec.ts` → FAIL

- [ ] **Step 3: 구현** — `INSIGHT_DEFAULT` 교체 + buildPrompt 영어화·자율 지시

```ts
import { outputDirective, configuredLang } from './language';

const INSIGHT_DEFAULT =
  "You analyze the user's daily usage. Based on the metrics and conversations, " +
  'summarize in 3-5 sentences what they focused on today, how their attention shifted, ' +
  'and any unresolved questions. Write only what the records show, as prose paragraphs rather than a list.';
```
`buildPrompt` 반환 배열을 영어 라벨 + 자율 지시로:
```ts
    return [
      loadPrompt('insight', INSIGHT_DEFAULT),
      outputDirective('autonomous', configuredLang()),
      '',
      `# Metrics`,
      `Queries ${metrics.queryCount} · frequent terms: ${metrics.topTerms.map((t) => t.term).join(', ') || '(none)'} · frequent pages: ${metrics.topPages.map((p) => p.slug).join(', ') || '(none)'}`,
      '',
      `# Today's conversations`,
      qa,
    ].join('\n');
```

- [ ] **Step 4: prompts/insight.md 영어화** — 파일 전체를 INSIGHT_DEFAULT와 같은 영어 문장으로 교체:
```
You analyze the user's daily usage. Based on the metrics and conversations, summarize in 3-5 sentences what they focused on today, how their attention shifted, and any unresolved questions. Write only what the records show, as prose paragraphs rather than a list.
```

- [ ] **Step 5: 통과 확인 + 커밋**

Run: `npx jest src/agent-layer/insight-reporter.spec.ts` → PASS
```bash
git add src/agent-layer/insight-reporter.ts prompts/insight.md src/agent-layer/insight-reporter.spec.ts
git commit -m "fix(i18n): insight 한국어 하드코딩 제거 → 설정 언어 지시"
```

---

## Task 4: 읽기·협업 대화형 프롬프트 영어화 + 대화형 지시

**Files:**
- Modify: `src/agent-layer/reader-agent.ts` (buildPrompt)
- Modify: `src/agent-layer/synthesizer.ts` (synthesize 프롬프트)
- Modify: `src/agent-layer/specialist-agent.ts` (contribute 프롬프트)
- Test: 각 `*.spec.ts`에 프롬프트 조립 테스트 추가

**Interfaces:**
- Consumes: `outputDirective` (Task 1).
- **주의**: reader의 `NO_HITS_HEADER`·에러 문자열, synthesizer의 빈/실패 폴백 문자열은 **건드리지 않는다**(Plan 2). 이 태스크는 **buildPrompt/프롬프트 배열만**.

- [ ] **Step 1: 실패 테스트(reader)** — buildPrompt 한글 없음 + 대화형 지시 + chart 토큰 보존

```ts
import { ReaderAgent } from './reader-agent';
it('reader prompt: english + interactive directive + chart contract', () => {
  const r = new ReaderAgent({} as any, {} as any, { error(){} } as any);
  const p = (r as any).buildPrompt('question?', [], '', []) as string;
  expect(/[가-힣]/.test(p)).toBe(false);
  expect(p).toContain("Respond in the language of the user's latest message.");
  expect(p).toContain('```chart');            // 차트 계약 토큰 보존
});
```
(synthesizer·specialist도 같은 패턴: 각 프롬프트를 만들어 no-Hangul + 대화형 지시 포함 검증. specialist는 `registry.get`가 필요하니 fake registry `{ get: () => ({ prompt: 'PERSONA', brain: 'claude' }) }`·fake rag `{ search: async () => [] }` 주입.)

- [ ] **Step 2: 실패 확인** — `npx jest src/agent-layer/reader-agent.spec.ts src/agent-layer/synthesizer.spec.ts src/agent-layer/specialist-agent.spec.ts` → FAIL

- [ ] **Step 3: reader buildPrompt 영어화** — `src/agent-layer/reader-agent.ts` buildPrompt 반환 배열 교체(정확한 영어):

```ts
import { outputDirective } from './language';
// ...
    const recentBlock = recent.length
      ? `# Prior conversation (continuity reference — not evidence; evidence is the wiki below)\n${recent
          .map((r) => `User: ${clip(r.question)}\nEngram: ${clip(r.answer)}`)
          .join('\n')}\n\n`
      : '';
    const insightBlock = ctx
      ? `# User context for reference (not evidence — evidence is the wiki below)\n${ctx}\n\n`
      : '';
    return [
      'Answer the question using the searched wiki content below as the primary basis.',
      'Mark the evidence you use with [n]. If the search content cannot answer it, state that this is general knowledge outside the wiki.',
      'If there is prior conversation, continue its flow (interpret short replies and pronouns against the prior conversation).',
      'If there are numbers/time series, include a chart block (the UI renders it as a graph): ```chart {"type":"bar|line|pie","title":"title","labels":["A","B"],"values":[1,2],"unit":"%"} ``` (bar/line = trend/compare, pie = share).',
      'Per-item comparisons also work as a markdown table (| header | ... |) — for changes attach arrows like ▲2.3% (up) / ▼1.1% (down) and the UI colors them green/red. Use - [ ] / - [x] checkboxes for to-do lists.',
      outputDirective('interactive'),
      '',
      recentBlock + insightBlock + `# Searched wiki\n${context || '(none)'}`,
      '',
      `# Question\n${question}`,
    ].join('\n');
```

- [ ] **Step 4: synthesizer 영어화** — `src/agent-layer/synthesizer.ts` prompt 배열(폴백 문자열 `전문가 기여가 없어…`·`종합 실패…`는 그대로):

```ts
import { outputDirective } from './language';
// ...
    const body = entries.map(([who, txt]) => `## ${who}\n${txt}`).join('\n\n');
    const prompt = [
      'Below are opinions several experts each wrote on the same question. Synthesize them into one coherent answer.',
      'Where they conflict, surface the trade-offs; merge duplicates.',
      outputDirective('interactive'),
      `\n# Question\n${question}`,
      `\n# Expert opinions\n${body}`,
    ].join('\n');
```

- [ ] **Step 5: specialist 영어화** — `src/agent-layer/specialist-agent.ts` contribute prompt(에러 `throw`는 그대로):

```ts
import { outputDirective } from './language';
// ...
    const prompt = [
      persona.prompt,
      `\n# Shared wiki (evidence)\n${ctx || '(none)'}`,
      `\n# Question to address\n${question}`,
      "\nContribute only from your role's perspective. Do not talk to other experts; write only your own analysis.",
      outputDirective('interactive'),
    ].join('\n');
```

- [ ] **Step 6: 통과 확인 + 커밋**

Run: `npx jest src/agent-layer/reader-agent.spec.ts src/agent-layer/synthesizer.spec.ts src/agent-layer/specialist-agent.spec.ts` → PASS
```bash
git add src/agent-layer/reader-agent.ts src/agent-layer/synthesizer.ts src/agent-layer/specialist-agent.ts src/agent-layer/reader-agent.spec.ts src/agent-layer/synthesizer.spec.ts src/agent-layer/specialist-agent.spec.ts
git commit -m "feat(i18n): 읽기·협업 프롬프트 영어화 + 대화형 언어 지시"
```

---

## Task 5: 코딩 대화형 프롬프트 영어화 + 대화형 지시

**Files:**
- Modify: `src/agent-layer/code-chat.ts` (CODE_CHAT_DEFAULT + buildCodeChatPrompt)
- Modify: `src/agent-layer/coding-specialist.ts` (CODING_RULES_DEFAULT)
- Modify: `src/agent-layer/reviewer-agent.ts` (REVIEW_DEFAULT)
- Test: `src/agent-layer/code-chat.spec.ts` 등에 추가

**Interfaces:**
- Consumes: `outputDirective` (Task 1).
- **propose 마커·JSON 계약 보존**: `buildCodeChatPrompt`의 ```` ```engram:propose ````·`extractPropose` 로직 불변, reviewer의 `{"approved": boolean, "extraTickets": …}` 불변.

- [ ] **Step 1: 실패 테스트(code-chat)**

```ts
import { buildCodeChatPrompt, CODE_CHAT_DEFAULT } from './code-chat';
it('code-chat prompt: english + interactive + propose contract intact', () => {
  const p = buildCodeChatPrompt(CODE_CHAT_DEFAULT, { repoPath: 'C:/x', userText: 'hi' });
  expect(/[가-힣]/.test(p)).toBe(false);
  expect(p).toContain("Respond in the language of the user's latest message.");
  expect(p).toContain('```engram:propose');   // 계약 보존
});
```
(reviewer도: `new ReviewerAgent({complete:async()=>({})} as any)` 후 `(agent as any)`가 아닌, review()가 부르는 prompt를 검증하려면 프롬프트 조립을 그대로 두고 `REVIEW_DEFAULT` no-Hangul + JSON 계약 문자열 존재를 별도 단위로 확인. 간단히 `REVIEW_DEFAULT`·`CODING_RULES_DEFAULT` 상수를 export해 no-Hangul 단언.)

- [ ] **Step 2: 실패 확인** — 해당 spec 실행 → FAIL

- [ ] **Step 3: code-chat 영어화** — `src/agent-layer/code-chat.ts`

```ts
export const CODE_CHAT_DEFAULT = [
  'You are Engram. You help the user by talking about this repo ({path}).',
  'When needed, read files (read-only) to investigate, then answer concisely.',
  'For questions, explanations, or discussion, just answer. Attach the proposal block only when asked to change or create code.',
].join('\n');
```
`buildCodeChatPrompt` 내부 배열의 한국어 라벨을 영어로 + 대화형 지시 추가(마커 블록은 그대로):
```ts
import { outputDirective } from './language';
// ...
  return [
    instruction.split('{path}').join(ctx.repoPath),
    ctx.taskStatus ? `\n# Current task status in this thread\n${ctx.taskStatus}` : '',
    ctx.recent ? `\n# Recent conversation\n${ctx.recent}` : '',
    `\n# User message\n${ctx.userText}`,
    outputDirective('interactive'),
    '\nOnly when asked to change or create code, append exactly the block below at the very end of your answer (never for questions/explanations/discussion):',
    '```engram:propose',
    '{"goal":"<one-line goal>"}',
    '```',
  ].filter(Boolean).join('\n');
```

- [ ] **Step 4: coding-specialist 영어화** — `CODING_RULES_DEFAULT` 교체("같은 언어" 줄 제거) + work() prompt에 대화형 지시 추가

```ts
import { outputDirective } from './language';

const CODING_RULES_DEFAULT = [
  'Rules:',
  '- Edit the code in the target directory directly. Do only the piece you were given.',
  '- Do not run tests or builds — Engram runs the verification gate itself.',
  '- Do not discuss file existence, git state, CI, or process at length. Just change the code.',
  '- Do not talk to other agents/pieces.',
  '- Report in one or two concise lines.',
].join('\n');
```
work()의 prompt 배열에 `# 작업 영역`/`# 할 일`/`# 직전 게이트 실패` 라벨 영어화 + 마지막에 `outputDirective('interactive')` 추가:
```ts
      persona.prompt,
      `\n# Work area\n${ticket.area}`,
      `\n# Task\n${ticket.instruction}`,
      failNote, // failNote 라벨도 영어: `\n# Previous gate failure (fix it)\n${ticket.gate.output}`
      `\n${loadPrompt('coding-rules', CODING_RULES_DEFAULT)}`,
      outputDirective('interactive'),
```
(failNote 정의의 `\n# 직전 게이트 실패(고쳐라)\n` → `\n# Previous gate failure (fix it)\n`.)

- [ ] **Step 5: reviewer 영어화** — `REVIEW_DEFAULT` 교체(JSON 계약 줄은 review()가 이미 코드에서 영어로 덧붙임 — 그 줄 불변). review()는 판정 JSON만 내므로 **대화형 지시 없음**(출력이 사용자 산문 아님):

```ts
const REVIEW_DEFAULT = [
  'You are a code reviewer. Judge only whether the "acceptance criteria" below are met.',
  'The hard gate (tests, build, typecheck) has already passed under Engram — the code is objectively verified.',
  'If all acceptance criteria appear met, approved=true, extraTickets=[]. (A green gate usually means they are met.)',
  'Only when an acceptance criterion is not met, emit one ticket per unmet criterion.',
  'Never put suggestions outside the acceptance criteria — CI, workflows, tooling, adding tests, refactors, process, docs, "regression gates" — into extraTickets. Look only at the acceptance-criteria list below.',
].join('\n');
```
review() 프롬프트의 `# 완성조건`/`# 착지된 변경 요약` 라벨도 영어(`# Acceptance criteria`/`# Summary of landed changes`), 마지막 JSON 계약 줄(`반드시 이 JSON만 출력: {"approved": boolean, …}`)은 `Output only this JSON: {"approved": boolean, "extraTickets": [{"area": "...", "instruction": "..."}]}`로.

- [ ] **Step 6: 통과 확인 + 커밋**

Run: 관련 spec 전부 → PASS
```bash
git add src/agent-layer/code-chat.ts src/agent-layer/coding-specialist.ts src/agent-layer/reviewer-agent.ts src/agent-layer/*.spec.ts
git commit -m "feat(i18n): 코딩 프롬프트 영어화 + 대화형 지시(계약 불변)"
```

---

## Task 6: 분류·자율·수집 프롬프트 영어화 (orchestrator + ingester)

**Files:**
- Modify: `src/agent-layer/orchestrator.ts` (DECOMPOSE_DEFAULT·AMBIENT_DEFAULT·TRIAGE_DEFAULT + observe/classify/decompose 프롬프트 라벨·JSON 계약, ambient에 자율 지시)
- Modify: `src/agent-layer/ingester-agent.ts` (extractFacts + judgeFact)
- Test: `src/agent-layer/orchestrator.spec.ts`·`ingester-agent.spec.ts`에 추가

**Interfaces:**
- Consumes: `outputDirective`, `configuredLang` (Task 1).
- **JSON 계약 키 불변**. classify/decompose/judge = JSON(대화형 지시 없음). ambient = 자율(💡 텍스트가 사용자에게 감). ingester extract = source 지시.

- [ ] **Step 1: 실패 테스트** — 상수 no-Hangul + ambient 자율 지시 + extract source 지시 + JSON 계약 존재

```ts
// orchestrator.spec.ts: 상수를 export하거나, observe/classify/decompose가 부르는 프롬프트를
// fake brain으로 캡처해 검증. 최소: DECOMPOSE_DEFAULT/AMBIENT_DEFAULT/TRIAGE_DEFAULT export 후:
import { DECOMPOSE_DEFAULT, AMBIENT_DEFAULT, TRIAGE_DEFAULT } from './orchestrator';
it('classification defaults are English', () => {
  for (const s of [DECOMPOSE_DEFAULT, AMBIENT_DEFAULT, TRIAGE_DEFAULT]) expect(/[가-힣]/.test(s)).toBe(false);
});
```
```ts
// ingester-agent.spec.ts
import { IngesterAgent } from './ingester-agent';
it('extractFacts prompt: english + source directive + json contract', async () => {
  let captured = '';
  const brain = { complete: async (p: string) => { captured = p; return { text: '[]', costUsd: 0 }; } };
  const ing = new IngesterAgent({} as any, {} as any, brain as any, brain as any, {} as any, {} as any, { error(){} } as any, {} as any);
  await ing.extractFacts('conv');
  expect(/[가-힣]/.test(captured)).toBe(false);
  expect(captured).toContain('Write the extracted facts in the same language as the source text.');
  expect(captured).toContain('"claim"');   // JSON 계약 보존
});
```

- [ ] **Step 2: 실패 확인** → FAIL

- [ ] **Step 3: orchestrator 상수 영어화(+ export)** — `DECOMPOSE_DEFAULT`/`AMBIENT_DEFAULT`/`TRIAGE_DEFAULT`를 `export const`로 바꾸고 영어로:

```ts
export const DECOMPOSE_DEFAULT = [
  'Split the goal below into work pieces.',
  '**Split as little as possible.** If the goal is small or touches one area (one or two files), keep it as a single task.',
  'Only split into multiple pieces when the parts are truly independent (different, non-overlapping files/areas) — over-splitting makes agents collide on the same file.',
].join('\n');

export const AMBIENT_DEFAULT = [
  'You are given a chat message and wiki excerpts. Interject only when the wiki information is genuinely helpful to this conversation.',
  'If unsure, do not interject — interject=false is the default.',
  'When you do interject, give just the point in one or two sentences and cite the wiki page (slug) you relied on.',
].join('\n');

export const TRIAGE_DEFAULT = [
  'Decide whether the user message is (1) a simple question/chat → "chat", or (2) work that needs several experts together → "collaborate".',
  'For collaborate, pick from the expert list below only the people this work truly needs and put their names in team (empty array if none).',
  '(3) If it asks to write, fix, or implement code in a specific repo → "code": put the repo reference (name/alias/path) in repo and the task in goal.',
  '(4) If it asks to do something at a set time/interval → "schedule": put a 5-field cron in cron (e.g. every day at 9 = 0 9 * * *), the task in task, and once=true if it runs a single time.',
  'When unsure, choose chat.',
].join('\n');
```

- [ ] **Step 4: orchestrator 프롬프트 라벨·계약 영어화** — 각 조립부(정확히 이 라벨만; JSON 계약 키 불변):
  - observe() (약 591행대): 라벨 `# 대화 메시지`→`# Chat message`, `# 위키 발췌`→`# Wiki excerpts`; 자율 지시 추가 `outputDirective('autonomous', configuredLang())`; JSON 계약 `\n반드시 이 JSON만: {"interject":true|false,"text":"한두 문장"}` → `\nOutput only this JSON: {"interject":true|false,"text":"one or two sentences"}`.
  - classify() (약 616행대): `# 사용 가능한 전문가`→`# Available experts`, `# 코딩 가능한 레포(alias)`→`# Code repos (alias)`, `# 사용자 메시지`→`# User message`; JSON 계약 `\n반드시 이 JSON만: {"kind":"chat"|"collaborate"|"code"|"schedule","team":["이름",...],"repo":"레포참조","goal":"할 일","cron":"0 9 * * *","task":"할 일","once":false}` → 값 힌트만 영어: `{"kind":"chat"|"collaborate"|"code"|"schedule","team":["name",...],"repo":"repo ref","goal":"the task","cron":"0 9 * * *","task":"the task","once":false}`.
  - decompose() (약 681행대): `# 목표`→`# Goal`; JSON 계약 `{"tickets":[{"area":"디렉터리/영역","instruction":"할 일"}]}` → `{"tickets":[{"area":"directory/area","instruction":"the task"}]}`.
  - proposeProject() (약 710행대): `'아래 목표에 대한 완성조건(검증 가능한 항목)을 추정하라.'`→`'Estimate the acceptance criteria (verifiable items) for the goal below.'`, `# 목표`/`# 타깃 경로`→`# Goal`/`# Target path`, JSON 계약 `{"acceptanceCriteria":["..."]}` 불변.

  이 조립부들의 **사용자 대면 게시 문자열(예: `이 채널에선 …`, `팀 구성: …`)은 건드리지 않는다**(Plan 2). 오직 **두뇌로 가는 프롬프트 문자열만** 영어화.

- [ ] **Step 5: ingester 영어화** — `src/agent-layer/ingester-agent.ts`

extractFacts:
```ts
import { outputDirective } from './language';
// ...
    const prompt = [
      'Extract from the conversation below only the facts worth recording in the wiki.',
      'For each fact, attach an importance (1-5) and a source quote (sourceQuote) from the conversation.',
      'Output only a JSON array: [{"claim": string, "importance": number, "sourceQuote": string}]',
      outputDirective('source'),
      '', `# Conversation\n${convText}`,
    ].join('\n');
```
judgeFact(JSON, 지시 없음):
```ts
    const prompt = [
      'Verify the candidate fact below (you are the verifier, not the writer).',
      'Judge by comparing with the existing wiki:',
      '- create: new topic → new page',
      '- append: strengthen an existing page (targetSlug = existing slug)',
      '- supersede: contradicts existing → replace it (targetSlug = existing slug, list conflictSlugs; no overwriting)',
      '- reject: insufficient evidence, hallucination, or no value',
      'Output only a JSON object: {"verdict","targetSlug","title","category","confidence","reason","conflictSlugs"}',
      '', `# Candidate fact\n${fact.claim}\nsource: ${fact.sourceQuote}`,
      '', `# Related existing wiki\n${ctx || '(none)'}`,
    ].join('\n');
```

- [ ] **Step 6: 통과 확인 + 커밋**

Run: `npx jest src/agent-layer/orchestrator.spec.ts src/agent-layer/ingester-agent.spec.ts` → PASS
```bash
git add src/agent-layer/orchestrator.ts src/agent-layer/ingester-agent.ts src/agent-layer/orchestrator.spec.ts src/agent-layer/ingester-agent.spec.ts
git commit -m "feat(i18n): 분류·ambient·수집 프롬프트 영어화(ambient 자율·ingester 원본 지시, 계약 불변)"
```

---

## Task 7: `prompts/*.md` 영어화 (상수와 동기)

**Files:**
- Modify: `prompts/triage.md`, `prompts/decompose.md`, `prompts/ambient.md`, `prompts/coding-rules.md`, `prompts/review.md`, `prompts/code-chat.md`, `prompts/insight.md`
- Test: `src/agent-layer/prompt-md-english.spec.ts` (신규)

**Interfaces:**
- `loadPrompt(name, fallback)`가 `.md`를 우선하므로, 각 `.md`는 대응 `*_DEFAULT` 상수와 **같은 영어 내용**이어야 한다(안 바꾸면 한국어 .md가 영어 상수를 덮어 여전히 한국어).
- (insight.md는 Task 3에서 이미 처리 — 여기선 확인만.)

- [ ] **Step 1: 실패 테스트** — 모든 prompts/*.md에 한글 없음

```ts
import * as fs from 'fs';
import * as path from 'path';
it('all prompts/*.md are English', () => {
  const dir = path.join(__dirname, '..', '..', 'prompts');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    expect(/[가-힣]/.test(txt)).toBe(false);
  }
});
```

- [ ] **Step 2: 실패 확인** → FAIL (triage/decompose/ambient/coding-rules/review/code-chat 한글)

- [ ] **Step 3: 각 .md를 대응 상수의 영어 본문으로 교체**
  - `prompts/triage.md` = TRIAGE_DEFAULT 영어 5줄(Task 6).
  - `prompts/decompose.md` = DECOMPOSE_DEFAULT 영어 3줄.
  - `prompts/ambient.md` = AMBIENT_DEFAULT 영어 3줄.
  - `prompts/coding-rules.md` = CODING_RULES_DEFAULT 영어 6줄(Task 5).
  - `prompts/review.md` = REVIEW_DEFAULT 영어 5줄(Task 5).
  - `prompts/code-chat.md` = CODE_CHAT_DEFAULT 영어 3줄(Task 5).
  - (JSON 계약 줄은 .md에 없음 — 코드가 덧붙임. .md엔 순수 지시만.)

- [ ] **Step 4: 통과 확인 + 커밋**

Run: `npx jest src/agent-layer/prompt-md-english.spec.ts` → PASS
```bash
git add prompts/ src/agent-layer/prompt-md-english.spec.ts
git commit -m "feat(i18n): prompts/*.md 영어화(상수와 동기)"
```

---

## Task 8: `personas/*.md` 영어화

**Files:**
- Modify: `personas/manager.md`, `academy.md`, `brand.md`, `career.md`, `infra.md`, `recon.md`, `record.md`, `trend.md`
- Test: `src/agent-layer/persona-english.spec.ts` (신규) — PersonaRegistry로 로드해 본문 영어·이름 보존

**Interfaces:**
- frontmatter 키(name/brain/invocation/board/tools) 유지. `name`(고유명사)은 그대로. `role` 값과 본문은 영어로.

- [ ] **Step 1: 실패 테스트**

```ts
import { PersonaRegistry } from './persona-registry';
it('all personas: english prompt, names preserved', () => {
  const reg = new PersonaRegistry(); // 기존 생성 방식 따를 것(생성자/로드 경로 확인)
  const names = ['Manager','Academy','Brand','Career','Infra','Recon','Record','Trend'];
  for (const n of names) {
    const p = reg.get(n);
    expect(p).toBeTruthy();
    expect(/[가-힣]/.test(p!.prompt)).toBe(false);
  }
});
```
(PersonaRegistry 생성/로드 시그니처는 기존 테스트 참고해 맞출 것.)

- [ ] **Step 2: 실패 확인** → FAIL

- [ ] **Step 3: 각 페르소나 본문·role 영어화**(frontmatter name/brain/invocation/board/tools 그대로):
  - **Manager** — role: `Overall coordination and decision facilitation` · body: `You are Manager. As the user's chief of staff, you set overall direction and coordinate decisions. When asked, you frame the key issues, identify the expertise needed, and present a balanced conclusion. Instead of unfounded assertions, you make trade-offs explicit.`
  - **Academy** — role: `Learning, research, knowledge curation` · body: `You are Academy. You learn and organize new technologies, papers, and industry trends. You explain complex concepts concisely and find the links that integrate new ideas into existing knowledge. You lead knowledge governance and building reusable assets.`
  - **Brand** — role: `Marketing, positioning, communication` · body: `You are Brand. You manage external perception and market positioning. You advise strategy around message consistency, user experience, and storytelling. You translate technical results into business value and support decisions from the customer's point of view.`
  - **Career** — role: `Career, growth, network development` · body: `You are Career. You handle the team's growth, career development, and external network expansion. You identify individual strengths and weaknesses and propose learning opportunities and deeper expertise. You advise toward long-term competitiveness and team cohesion.`
  - **Infra** — role: `Systems, infrastructure, operations` · body: `You are Infra. You are responsible for the stability and scalability of systems and infrastructure. You point out operational constraints and technical risks first, and propose automation opportunities and stronger monitoring. You guide decisions around performance and reliability.`
  - **Recon** — role: `Research, information gathering, deep analysis` · body: `You are Recon. You research competitors, technology trends, and user insights in depth. You find trustworthy sources, judge their reliability, and surface hidden insights. You provide the facts decisions need through web search and analysis.`
  - **Record** — role: `Minutes, record-keeping, audit` · body: `You are Record. You accurately record and archive every decision and collaboration. You make the context and rationale of decisions clear and enable later oversight and retrospection. You raise the accessibility and traceability of information to support organizational learning and transparency.`
  - **Trend** — role: `Market, trend, news monitoring` · body: `You are Trend. You monitor market changes and industry news in real time and identify strategic opportunities and threats early. You organize the major trends and analyze their business implications to support proactive decisions. You stay current through web search and information gathering.`

- [ ] **Step 4: 통과 확인 + 전체 스윕 + 커밋**

Run: `npx jest src/agent-layer/persona-english.spec.ts` → PASS
Run(전체 회귀): `npx jest` → 전부 PASS, `npm --prefix renderer test` → PASS
```bash
git add personas/ src/agent-layer/persona-english.spec.ts
git commit -m "feat(i18n): personas/*.md 영어화(name 보존)"
```

---

## Self-Review (작성자 체크 완료)

- **Spec 커버리지(A·B·C)**: A(지시문 영어화)=Task 3~8. B(출력 언어 규칙)=Task 3(자율)·4·5(대화형)·6(ambient 자율·ingester source). C(설정 언어 배선)=Task 1·2. **D(백엔드 하드코딩 문자열 i18n)는 Plan 2**(이 플랜 범위 밖 — Global Constraints에 명시).
- **Placeholder**: 각 태스크에 실제 영어 문안·테스트 코드·커맨드 포함. 번역 대량분(.md·페르소나)은 본문 문안을 직접 명시.
- **타입 일관성**: `outputDirective`/`configuredLang`/`resolveLanguage` 시그니처가 Task 1 정의와 소비처(2~6) 일치. `ChatConfig.language?`가 Task 2에서 정의되고 main.ts에서 소비.
- **주의 승계**: reader `NO_HITS_HEADER`·synthesizer 폴백·orchestrator 게시 문자열은 이 플랜에서 **미변경**(Plan 2). 같은 파일을 두 플랜이 다른 줄로 만짐 — 충돌 없음.
