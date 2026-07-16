# Phase 8a — engram 자체 하네스 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모델 API를 직접 호출하는 두뇌 provider 2종(`anthropic-api`·`openai-api`) + 자체 웹검색/웹fetch 미니 도구루프 — claude CLI 없이 단발호출이 돌게 한다.

**Architecture:** 기존 포트 `BrainProvider.complete(prompt, onChunk?, opts?)` 무변경. `createBrain`에 case 2개 추가. 두 provider는 공용 모듈(`tool-loop.ts` 반복 로직, `web-tools.ts` 도구, `sse.ts` 스트림 파서)을 쓰고 와이어 형식 변환만 각자 소유. 데스크톱 설정창은 Anthropic 키 입력을 신설하고 Ollama 흐름을 claude-cli 껍데기에서 `openai-api` 프로필로 교체.

**Tech Stack:** TypeScript/NestJS, Node 전역 `fetch`/`Response`(Node 22+, 외부 HTTP 라이브러리 없음), Jest(HTTP 전부 모킹 — 실 네트워크 금지), Electron 설정창(기존 IPC 패턴).

## Global Constraints

- **never-throw 계약**: `complete()`는 어떤 실패(HTTP·타임아웃·JSON 오염·키 미설정)에도 throw 대신 `{ text, costUsd, isError: true, raw }` 반환(기존 ClaudeCliBrain과 동일 — 상주 불사).
- **기본 provider는 claude-cli 유지**: brains.json 기본 파일(DEFAULT_FILE)·DEFAULTS 무변경. engram-api는 opt-in.
- **기존 CLI provider 3종 무변경**: claude-cli/gemini-cli/codex-cli 경로 회귀 제로.
- **코딩 호출 방어**: `opts.cwd`가 오면 즉시 isError(`raw`에 "coding requires a CLI-harness brain until Phase 8b" 포함). `opts.extraArgs`는 무시(에러 아님).
- 도구루프 상한 `MAX_TOOL_ITERATIONS = 8` — 도달 시 **isError=false**(부분 답변도 답변), `raw: 'tool-loop-limit'`.
- 검색 기본 = DuckDuckGo(키 불필요). 프로필 `searchProvider`('brave'|'tavily')+`searchApiKey` 지정 시 전환. Anthropic 서버측 web_search 안 씀.
- web_fetch: http/https만, 루프백·사설·링크로컬 호스트 거부(SSRF), 텍스트 상한 `FETCH_CHAR_LIMIT = 50_000` chars.
- API 키는 brains.json 평문(Discord 토큰 관례). 타임아웃은 도구루프 **전체**에 하나(`opts.timeoutMs ?? profile.timeoutMs`).
- costUsd = (입력토큰×`inputUsdPerMTok` + 출력토큰×`outputUsdPerMTok`)/1e6, 단가 기본 0.
- 테스트: `npx jest <경로>` FOREGROUND(워치/백그라운드 금지 — 이 머신서 hang). 실 네트워크 절대 금지(fetch 주입/모킹·HTML 픽스처).
- 기존 스위트 전부 통과가 회귀 기준. UI 문구 영어 기본+ko. 커밋 메시지 한국어, Co-Authored-By 제외.

---

### Task 1: BrainProfile 확장 + ALLOWED + env 오버라이드

**Files:**
- Modify: `src/brain/brain.config.ts`
- Test: `src/brain/brain.config.spec.ts`

**Interfaces:**
- Consumes: 없음.
- Produces: `BrainProfile`에 옵셔널 필드 `apiKey?`, `baseUrl?`, `maxTokens?`, `inputUsdPerMTok?`, `outputUsdPerMTok?`, `searchProvider?: 'duckduckgo' | 'brave' | 'tavily'`, `searchApiKey?` 추가. `ALLOWED`에 `'anthropic-api'`, `'openai-api'`. env `ENGRAM_BRAIN_API_KEY`/`ENGRAM_BRAIN_BASE_URL` 오버라이드. Task 2~7이 이 필드들을 소비.

- [ ] **Step 1: 실패 테스트 추가**

`src/brain/brain.config.spec.ts` 끝에 append(파일 상단에 이미 `loadActiveBrain` 등 import·tmp 디렉토리 패턴이 있음 — 그 관례를 따라 tmp configDir에 brains.json을 써서 검증):

```ts
describe('Phase 8a — engram-api 프로필', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cfg8a-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('anthropic-api provider가 허용되고 신규 필드가 병합된다', () => {
    fs.writeFileSync(path.join(tmp, 'brains.json'), JSON.stringify({
      default: 'api',
      brains: { api: { provider: 'anthropic-api', apiKey: 'sk-x', maxTokens: 9000, inputUsdPerMTok: 5, outputUsdPerMTok: 25 } },
    }));
    const p = loadActiveBrain(tmp, {});
    expect(p.provider).toBe('anthropic-api');
    expect(p.apiKey).toBe('sk-x');
    expect(p.maxTokens).toBe(9000);
    expect(p.inputUsdPerMTok).toBe(5);
  });

  it('openai-api provider가 허용되고 baseUrl·searchProvider가 병합된다', () => {
    fs.writeFileSync(path.join(tmp, 'brains.json'), JSON.stringify({
      default: 'ollama',
      brains: { ollama: { provider: 'openai-api', baseUrl: 'http://localhost:11434/v1', model: 'llama3.3', searchProvider: 'brave', searchApiKey: 'bk' } },
    }));
    const p = loadActiveBrain(tmp, {});
    expect(p.provider).toBe('openai-api');
    expect(p.baseUrl).toBe('http://localhost:11434/v1');
    expect(p.searchProvider).toBe('brave');
  });

  it('ENGRAM_BRAIN_API_KEY·ENGRAM_BRAIN_BASE_URL env가 프로필을 덮어쓴다', () => {
    fs.writeFileSync(path.join(tmp, 'brains.json'), JSON.stringify({
      default: 'api', brains: { api: { provider: 'anthropic-api', apiKey: 'file-key' } },
    }));
    const p = loadActiveBrain(tmp, { ENGRAM_BRAIN_API_KEY: 'env-key', ENGRAM_BRAIN_BASE_URL: 'http://alt' } as NodeJS.ProcessEnv);
    expect(p.apiKey).toBe('env-key');
    expect(p.baseUrl).toBe('http://alt');
  });
});
```

(`fs`/`os`/`path` import가 파일 상단에 없으면 추가.)

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/brain/brain.config.spec.ts`
Expected: FAIL — `지원하지 않는 provider: anthropic-api`.

- [ ] **Step 3: 구현**

`src/brain/brain.config.ts`의 `BrainProfile` 인터페이스에 필드 추가(전부 옵셔널 — DEFAULTS 무변경 하위호환):

```ts
export interface BrainProfile {
  provider: string;
  cli: string;
  model: string;
  concurrency: number;
  timeoutMs: number;
  extraArgs: string[];
  env?: Record<string, string>;
  // Phase 8a — engram 자체 하네스(API 직접 호출) 프로필 필드
  apiKey?: string;             // anthropic-api 필수, openai-api 옵셔널(Ollama 불필요)
  baseUrl?: string;            // openai-api 필수, anthropic-api는 기본 https://api.anthropic.com
  maxTokens?: number;          // 기본 16000
  inputUsdPerMTok?: number;    // costUsd 계산용(기본 0 — 가격표 하드코딩 안 함)
  outputUsdPerMTok?: number;
  searchProvider?: 'duckduckgo' | 'brave' | 'tavily'; // web_search 소스(기본 duckduckgo)
  searchApiKey?: string;       // brave/tavily용
}
```

`resolve()`에서 `ALLOWED` 확장 + env 오버라이드 2줄 추가(`profile.concurrency = …` 줄 다음):

```ts
  if (env.ENGRAM_BRAIN_API_KEY) profile.apiKey = env.ENGRAM_BRAIN_API_KEY;
  if (env.ENGRAM_BRAIN_BASE_URL) profile.baseUrl = env.ENGRAM_BRAIN_BASE_URL;
  const ALLOWED = ['claude-cli', 'gemini-cli', 'codex-cli', 'anthropic-api', 'openai-api'];
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/brain/brain.config.spec.ts`
Expected: PASS(신규 3 + 기존 전부)

- [ ] **Step 5: 커밋**

```bash
git add src/brain/brain.config.ts src/brain/brain.config.spec.ts
git commit -m "feat(phase8a): BrainProfile API 필드 확장 + anthropic-api/openai-api 허용 + env 오버라이드"
```

---

### Task 2: web-tools — 도구 스키마 + web_fetch + web_search(DDG/Brave/Tavily)

**Files:**
- Create: `src/brain/web-tools.ts`
- Create: `src/brain/__fixtures__/ddg-sample.html`
- Test: `src/brain/web-tools.spec.ts`

**Interfaces:**
- Consumes: `BrainProfile`(Task 1의 `searchProvider`/`searchApiKey`).
- Produces(Task 4·5가 소비):
  - `WEB_TOOL_DEFS: Array<{ name: string; description: string; parameters: Record<string, unknown> }>` — 중립 스키마(`web_search`(query)·`web_fetch`(url)).
  - `executeWebTool(name: string, input: unknown, opts?: SearchOpts, fetchFn?: typeof fetch): Promise<string>` — **never-throw**(실패는 에러 텍스트 반환).
  - `SearchOpts = Pick<BrainProfile, 'searchProvider' | 'searchApiKey'>`.
  - 내부 export(테스트용): `isBlockedUrl(raw): boolean`, `stripHtml(html): string`, `parseDdgHtml(html, limit?): Array<{title,url,snippet}>`, `webFetch(url, fetchFn?)`, `webSearch(query, opts?, fetchFn?)`.

- [ ] **Step 1: DDG 픽스처 생성**

`src/brain/__fixtures__/ddg-sample.html` (실제 html.duckduckgo.com 결과 마크업 형태):

```html
<div class="results">
  <div class="result results_links">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fespresso&amp;rut=abc">Espresso <b>Guide</b></a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fespresso">Pull a <b>shot</b> at 9 bars for 25-30s.</a>
  </div>
  <div class="result results_links">
    <a rel="nofollow" class="result__a" href="https://direct.example.org/page">Direct Link</a>
    <a class="result__snippet" href="https://direct.example.org/page">No redirect wrapper here.</a>
  </div>
</div>
```

- [ ] **Step 2: 실패 테스트 작성**

`src/brain/web-tools.spec.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { isBlockedUrl, stripHtml, parseDdgHtml, webFetch, webSearch, executeWebTool, WEB_TOOL_DEFS } from './web-tools';

const ddgHtml = fs.readFileSync(path.join(__dirname, '__fixtures__', 'ddg-sample.html'), 'utf8');
const okFetch = (body: string, ct = 'text/html') =>
  (async () => new Response(body, { status: 200, headers: { 'content-type': ct } })) as unknown as typeof fetch;

describe('WEB_TOOL_DEFS', () => {
  it('web_search·web_fetch 두 도구가 정의된다', () => {
    expect(WEB_TOOL_DEFS.map((d) => d.name)).toEqual(['web_search', 'web_fetch']);
  });
});

describe('isBlockedUrl (SSRF 가드)', () => {
  it.each(['http://localhost/x', 'http://127.0.0.1/x', 'http://10.0.0.5/x', 'http://192.168.1.1/x', 'http://172.16.0.1/x', 'http://169.254.1.1/x', 'ftp://example.com', 'not-a-url'])('%s 차단', (u) => {
    expect(isBlockedUrl(u)).toBe(true);
  });
  it('공개 https는 허용', () => {
    expect(isBlockedUrl('https://example.com/a')).toBe(false);
  });
});

describe('stripHtml', () => {
  it('script/style 제거·태그 제거·엔티티 해제·공백 정리', () => {
    expect(stripHtml('<style>a{}</style><script>x()</script><p>A &amp; <b>B</b></p>')).toBe('A & B');
  });
});

describe('parseDdgHtml', () => {
  it('제목·URL(uddg 디코딩)·스니펫을 뽑는다', () => {
    const r = parseDdgHtml(ddgHtml);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ title: 'Espresso Guide', url: 'https://example.com/espresso', snippet: 'Pull a shot at 9 bars for 25-30s.' });
    expect(r[1].url).toBe('https://direct.example.org/page'); // 래퍼 없는 직접 링크
  });
});

describe('webFetch', () => {
  it('HTML을 텍스트로 추출한다', async () => {
    expect(await webFetch('https://example.com/a', okFetch('<html><body><h1>Hello</h1> world</body></html>'))).toBe('Hello world');
  });
  it('상한 초과는 절단 표시', async () => {
    const out = await webFetch('https://example.com/big', okFetch('x'.repeat(60_000), 'text/plain'));
    expect(out.length).toBeLessThan(51_000);
    expect(out).toContain('(truncated)');
  });
  it('차단 URL은 에러 텍스트(throw 아님)', async () => {
    expect(await webFetch('http://127.0.0.1/secret')).toContain('blocked');
  });
  it('HTTP 실패는 에러 텍스트', async () => {
    const f = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    expect(await webFetch('https://example.com/a', f)).toContain('HTTP 500');
  });
});

describe('webSearch', () => {
  it('기본 DDG: 결과를 번호 목록 텍스트로', async () => {
    const out = await webSearch('espresso', {}, okFetch(ddgHtml));
    expect(out).toContain('1. Espresso Guide');
    expect(out).toContain('https://example.com/espresso');
  });
  it('DDG 파싱 실패는 키 설정 안내를 담은 에러 텍스트', async () => {
    const out = await webSearch('q', {}, okFetch('<html>layout changed</html>'));
    expect(out).toContain('search error');
    expect(out).toContain('searchProvider');
  });
  it('brave 지정 시 Brave API 사용', async () => {
    const f = (async (url: string) => {
      expect(String(url)).toContain('api.search.brave.com');
      return new Response(JSON.stringify({ web: { results: [{ title: 'T', url: 'https://e.com', description: 'D' }] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await webSearch('q', { searchProvider: 'brave', searchApiKey: 'bk' }, f);
    expect(out).toContain('1. T');
  });
  it('tavily 지정 시 Tavily API 사용', async () => {
    const f = (async () => new Response(JSON.stringify({ results: [{ title: 'T2', url: 'https://e2.com', content: 'C' }] }), { status: 200 })) as unknown as typeof fetch;
    const out = await webSearch('q', { searchProvider: 'tavily', searchApiKey: 'tk' }, f);
    expect(out).toContain('1. T2');
  });
});

describe('executeWebTool', () => {
  it('web_fetch 라우팅', async () => {
    expect(await executeWebTool('web_fetch', { url: 'https://example.com/a' }, {}, okFetch('<p>hi</p>'))).toBe('hi');
  });
  it('인자 오염·미지 도구는 에러 텍스트(never-throw)', async () => {
    expect(await executeWebTool('web_search', { q: 1 })).toContain('tool error');
    expect(await executeWebTool('nope', {})).toContain('unknown tool');
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx jest src/brain/web-tools.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 4: 구현**

`src/brain/web-tools.ts`:

```ts
import { BrainProfile } from './brain.config';

// 하네스 공용 웹 도구(스펙 §3.2) — provider 중립 스키마 + 실행기.
// 실행 실패는 throw 대신 에러 텍스트 반환(도구 결과로 되먹여 모델이 다른 방법을 시도하게, §3.1).

export interface WebToolDef { name: string; description: string; parameters: Record<string, unknown> }
export type SearchOpts = Pick<BrainProfile, 'searchProvider' | 'searchApiKey'>;

export const WEB_TOOL_DEFS: WebToolDef[] = [
  {
    name: 'web_search',
    description: 'Search the web. Returns top results as numbered title/URL/snippet. Use for current events or facts you are unsure about.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] },
  },
  {
    name: 'web_fetch',
    description: 'Fetch an http(s) URL and return its text content (HTML stripped, truncated). Use to read a page found via web_search.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL to fetch' } }, required: ['url'] },
  },
];

const FETCH_CHAR_LIMIT = 50_000;
const SEARCH_LIMIT = 5;

// SSRF 가드: http(s)만, 루프백·사설·링크로컬 거부.
// ponytail: 호스트명 문자열 판정만(DNS 재해석 미방어) — 두뇌 서버는 신뢰경계 안. 필요시 resolve 검증으로 승격.
export function isBlockedUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return true; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function webFetch(url: string, fetchFn: typeof fetch = fetch): Promise<string> {
  if (isBlockedUrl(url)) return `fetch error: blocked or invalid URL (public http/https only): ${url}`;
  try {
    const res = await fetchFn(url, { redirect: 'follow' });
    if (!res.ok) return `fetch error: HTTP ${res.status}`;
    const body = await res.text();
    const ct = res.headers.get('content-type') ?? '';
    const text = ct.includes('html') || /^\s*</.test(body) ? stripHtml(body) : body;
    return text.length > FETCH_CHAR_LIMIT ? `${text.slice(0, FETCH_CHAR_LIMIT)}\n…(truncated)` : text;
  } catch (e) {
    return `fetch error: ${(e as Error).message}`;
  }
}

interface SearchHit { title: string; url: string; snippet: string }

// ponytail: DDG HTML 스크레이핑 — 마크업 변경에 깨질 수 있는 알려진 천장. 깨지면 아래 에러 안내가
// searchProvider(brave/tavily) 키 설정으로 유도한다. 업그레이드 경로 = 키 기반 API.
export function parseDdgHtml(html: string, limit = SEARCH_LIMIT): SearchHit[] {
  const out: SearchHit[] = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < limit) {
    const href = m[1];
    const uddg = /[?&]uddg=([^&"]+)/.exec(href);
    out.push({ title: stripHtml(m[2]), url: uddg ? decodeURIComponent(uddg[1]) : href, snippet: stripHtml(m[3]) });
  }
  return out;
}

async function searchRaw(query: string, opts: SearchOpts, fetchFn: typeof fetch): Promise<SearchHit[]> {
  if (opts.searchProvider === 'brave' && opts.searchApiKey) {
    const res = await fetchFn(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${SEARCH_LIMIT}`, {
      headers: { 'X-Subscription-Token': opts.searchApiKey, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
    const j = (await res.json()) as { web?: { results?: Array<{ title: string; url: string; description?: string }> } };
    return (j.web?.results ?? []).slice(0, SEARCH_LIMIT).map((r) => ({ title: r.title, url: r.url, snippet: stripHtml(r.description ?? '') }));
  }
  if (opts.searchProvider === 'tavily' && opts.searchApiKey) {
    const res = await fetchFn('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: opts.searchApiKey, query, max_results: SEARCH_LIMIT }),
    });
    if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
    const j = (await res.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
    return (j.results ?? []).slice(0, SEARCH_LIMIT).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }));
  }
  const res = await fetchFn(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (Engram)' },
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const hits = parseDdgHtml(await res.text());
  if (hits.length === 0) throw new Error('DuckDuckGo 결과 파싱 실패(마크업 변경 가능)');
  return hits;
}

export async function webSearch(query: string, opts: SearchOpts = {}, fetchFn: typeof fetch = fetch): Promise<string> {
  try {
    const hits = await searchRaw(query, opts, fetchFn);
    if (hits.length === 0) return `no results for: ${query}`;
    return hits.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
  } catch (e) {
    return `search error: ${(e as Error).message} — 반복 실패 시 brains.json 프로필에 searchProvider(brave/tavily)+searchApiKey를 설정하세요.`;
  }
}

// 도구 실행 단일 진입점 — provider가 이름/인자만 넘긴다. never-throw.
export async function executeWebTool(name: string, input: unknown, opts: SearchOpts = {}, fetchFn: typeof fetch = fetch): Promise<string> {
  const arg = (input ?? {}) as Record<string, unknown>;
  if (name === 'web_search') {
    return typeof arg.query === 'string' ? webSearch(arg.query, opts, fetchFn) : 'tool error: query(string) required';
  }
  if (name === 'web_fetch') {
    return typeof arg.url === 'string' ? webFetch(arg.url, fetchFn) : 'tool error: url(string) required';
  }
  return `tool error: unknown tool ${name}`;
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx jest src/brain/web-tools.spec.ts`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add src/brain/web-tools.ts src/brain/web-tools.spec.ts src/brain/__fixtures__/ddg-sample.html
git commit -m "feat(phase8a): 공용 웹 도구(web_search DDG/Brave/Tavily + web_fetch SSRF가드)"
```

---

### Task 3: tool-loop — provider 중립 미니 도구루프

**Files:**
- Create: `src/brain/tool-loop.ts`
- Test: `src/brain/tool-loop.spec.ts`

**Interfaces:**
- Consumes: 없음(순수 로직).
- Produces(Task 4·5가 소비):

```ts
export interface ToolCall { id: string; name: string; input: unknown }
export interface TurnResult { text: string; toolCalls: ToolCall[]; inputTokens: number; outputTokens: number }
export interface LoopResult { text: string; inputTokens: number; outputTokens: number; hitLimit: boolean }
export const MAX_TOOL_ITERATIONS = 8;
export async function runToolLoop(
  callTurn: () => Promise<TurnResult>,
  pushToolResults: (results: Array<{ id: string; name: string; output: string }>) => void,
  executeTool: (name: string, input: unknown) => Promise<string>,
  maxIterations?: number,
): Promise<LoopResult>
```

- [ ] **Step 1: 실패 테스트 작성**

`src/brain/tool-loop.spec.ts`:

```ts
import { runToolLoop, TurnResult } from './tool-loop';

function turnSeq(turns: TurnResult[]): () => Promise<TurnResult> {
  let i = 0;
  return async () => turns[Math.min(i++, turns.length - 1)];
}

describe('runToolLoop', () => {
  it('도구 호출 없으면 1회전에 종료·토큰 집계', async () => {
    const r = await runToolLoop(
      turnSeq([{ text: '답', toolCalls: [], inputTokens: 10, outputTokens: 5 }]),
      () => { throw new Error('호출되면 안 됨'); },
      async () => '',
    );
    expect(r).toEqual({ text: '답', inputTokens: 10, outputTokens: 5, hitLimit: false });
  });

  it('도구 호출 → 실행 → 되먹임 → 최종 텍스트(토큰 합산)', async () => {
    const pushed: unknown[] = [];
    const r = await runToolLoop(
      turnSeq([
        { text: '', toolCalls: [{ id: 't1', name: 'web_fetch', input: { url: 'u' } }], inputTokens: 10, outputTokens: 3 },
        { text: '완성 답변', toolCalls: [], inputTokens: 20, outputTokens: 7 },
      ]),
      (results) => pushed.push(results),
      async (name) => `result-of-${name}`,
    );
    expect(pushed).toEqual([[{ id: 't1', name: 'web_fetch', output: 'result-of-web_fetch' }]]);
    expect(r).toEqual({ text: '완성 답변', inputTokens: 30, outputTokens: 10, hitLimit: false });
  });

  it('상한 도달 시 hitLimit=true·마지막 텍스트 유지', async () => {
    const r = await runToolLoop(
      turnSeq([{ text: '중간 생각', toolCalls: [{ id: 'x', name: 'web_search', input: {} }], inputTokens: 1, outputTokens: 1 }]),
      () => {},
      async () => 'r',
      3,
    );
    expect(r.hitLimit).toBe(true);
    expect(r.text).toBe('중간 생각');
    expect(r.inputTokens).toBe(3);
  });

  it('도구 실행 함수가 던지면 루프도 던진다(도구 내부 never-throw는 web-tools 책임)', async () => {
    await expect(runToolLoop(
      turnSeq([{ text: '', toolCalls: [{ id: 'x', name: 'boom', input: {} }], inputTokens: 0, outputTokens: 0 }]),
      () => {},
      async () => { throw new Error('boom'); },
    )).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/brain/tool-loop.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`src/brain/tool-loop.ts`:

```ts
// 미니 도구루프(스펙 §3.1) — provider 중립. 와이어 형식·history는 provider가 소유하고
// 이 모듈은 반복·토큰 집계·상한만 담당한다. Phase 8b 코딩 루프의 씨앗.
export interface ToolCall { id: string; name: string; input: unknown }
export interface TurnResult { text: string; toolCalls: ToolCall[]; inputTokens: number; outputTokens: number }
export interface LoopResult { text: string; inputTokens: number; outputTokens: number; hitLimit: boolean }

export const MAX_TOOL_ITERATIONS = 8;

export async function runToolLoop(
  callTurn: () => Promise<TurnResult>,
  pushToolResults: (results: Array<{ id: string; name: string; output: string }>) => void,
  executeTool: (name: string, input: unknown) => Promise<string>,
  maxIterations = MAX_TOOL_ITERATIONS,
): Promise<LoopResult> {
  let inputTokens = 0;
  let outputTokens = 0;
  let text = '';
  for (let i = 0; i < maxIterations; i++) {
    const turn = await callTurn();
    inputTokens += turn.inputTokens;
    outputTokens += turn.outputTokens;
    if (turn.text) text = turn.text; // 최종 답 = 마지막 비어있지 않은 턴의 텍스트
    if (turn.toolCalls.length === 0) return { text, inputTokens, outputTokens, hitLimit: false };
    const results: Array<{ id: string; name: string; output: string }> = [];
    for (const c of turn.toolCalls) {
      results.push({ id: c.id, name: c.name, output: await executeTool(c.name, c.input) });
    }
    pushToolResults(results);
  }
  return { text, inputTokens, outputTokens, hitLimit: true };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/brain/tool-loop.spec.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/brain/tool-loop.ts src/brain/tool-loop.spec.ts
git commit -m "feat(phase8a): provider 중립 미니 도구루프(상한 8·토큰 집계)"
```

---

### Task 4: sse 파서 + AnthropicApiBrain

**Files:**
- Create: `src/brain/sse.ts`
- Create: `src/brain/anthropic-api.brain.ts`
- Test: `src/brain/anthropic-api.brain.spec.ts` (sse 동작도 이 스위트로 커버)

**Interfaces:**
- Consumes: Task 1 필드, Task 2 `WEB_TOOL_DEFS`/`executeWebTool`, Task 3 `runToolLoop`.
- Produces(Task 5·6이 소비):
  - `sseJson(body: ReadableStream<Uint8Array> | null): AsyncGenerator<Record<string, unknown>>` — `data:` 라인 JSON을 순서대로, `[DONE]`·비JSON 스킵.
  - `class AnthropicApiBrain implements BrainProvider` — `constructor(profile: BrainProfile, fetchFn: typeof fetch = fetch)`.

- [ ] **Step 1: sse.ts 구현(작아서 테스트는 provider 스위트에 통합)**

`src/brain/sse.ts`:

```ts
// SSE(text/event-stream) 본문에서 `data: <json>` 라인을 순서대로 파싱해 내보낸다.
// '[DONE]'·빈 데이터·비JSON 라인은 건너뛴다(부분 청크 경계는 버퍼로 흡수).
export async function* sseJson(body: ReadableStream<Uint8Array> | null): AsyncGenerator<Record<string, unknown>> {
  if (!body) return;
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        yield JSON.parse(data) as Record<string, unknown>;
      } catch {
        // 비JSON/오염 라인 무시
      }
    }
  }
}
```

- [ ] **Step 2: 실패 테스트 작성**

`src/brain/anthropic-api.brain.spec.ts`:

```ts
import { AnthropicApiBrain } from './anthropic-api.brain';
import { BrainProfile } from './brain.config';

const PROFILE: BrainProfile = {
  provider: 'anthropic-api', cli: '', model: 'claude-opus-4-8', concurrency: 1, timeoutMs: 5000,
  extraArgs: [], apiKey: 'sk-test', inputUsdPerMTok: 5, outputUsdPerMTok: 25,
};

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const TEXT_TURN = [
  { type: 'message_start', message: { usage: { input_tokens: 100 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '안' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '녕' } },
  { type: 'message_delta', usage: { output_tokens: 4 } },
];

const TOOL_TURN = [
  { type: 'message_start', message: { usage: { input_tokens: 50 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'web_fetch' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"url":"https://ex' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ample.com/a"}' } },
  { type: 'message_delta', usage: { output_tokens: 2 } },
];

describe('AnthropicApiBrain', () => {
  it('단발 텍스트: 스트리밍 onChunk + 최종 텍스트 + costUsd 계산', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_TURN)) as unknown as typeof fetch;
    const brain = new AnthropicApiBrain(PROFILE, fetchFn);
    const chunks: string[] = [];
    const r = await brain.complete('hello', (t) => chunks.push(t));
    expect(r.isError).toBe(false);
    expect(r.text).toBe('안녕');
    expect(chunks).toEqual(['안', '녕']);
    expect(r.costUsd).toBeCloseTo((100 * 5 + 4 * 25) / 1_000_000);
    const req = (fetchFn as jest.Mock).mock.calls[0];
    expect(String(req[0])).toContain('/v1/messages');
    const body = JSON.parse(req[1].body);
    expect(body.stream).toBe(true);
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['web_search', 'web_fetch']);
    expect(req[1].headers['x-api-key']).toBe('sk-test');
  });

  it('도구루프: tool_use → web_fetch 실행 → tool_result 되먹임 → 최종 답', async () => {
    let call = 0;
    const fetchFn = jest.fn(async (url: string) => {
      if (String(url).includes('/v1/messages')) {
        call++;
        return call === 1 ? sse(TOOL_TURN) : sse(TEXT_TURN);
      }
      return new Response('<html><body>Hello page</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
    const brain = new AnthropicApiBrain(PROFILE, fetchFn);
    const r = await brain.complete('fetch it');
    expect(r.isError).toBe(false);
    expect(r.text).toBe('안녕');
    // 두 번째 모델 호출 body에 assistant tool_use + user tool_result가 실려야 함
    const secondBody = JSON.parse((fetchFn as jest.Mock).mock.calls.filter((c) => String(c[0]).includes('/v1/messages'))[1][1].body);
    const roles = secondBody.messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(secondBody.messages[2])).toContain('tool_result');
    expect(JSON.stringify(secondBody.messages[2])).toContain('Hello page');
    // 토큰 집계: 두 턴 합산
    expect(r.costUsd).toBeCloseTo(((50 + 100) * 5 + (2 + 4) * 25) / 1_000_000);
  });

  it('HTTP 4xx는 isError(never-throw)', async () => {
    const fetchFn = (async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch;
    const r = await new AnthropicApiBrain(PROFILE, fetchFn).complete('x');
    expect(r.isError).toBe(true);
    expect(String(r.raw)).toContain('401');
  });

  it('apiKey 없으면 즉시 isError(fetch 미호출)', async () => {
    const fetchFn = jest.fn() as unknown as typeof fetch;
    const r = await new AnthropicApiBrain({ ...PROFILE, apiKey: undefined }, fetchFn).complete('x');
    expect(r.isError).toBe(true);
    expect(String(r.raw)).toContain('apiKey');
    expect((fetchFn as jest.Mock)).not.toHaveBeenCalled();
  });

  it('opts.cwd(코딩 신호)는 즉시 isError', async () => {
    const r = await new AnthropicApiBrain(PROFILE, jest.fn() as unknown as typeof fetch).complete('x', undefined, { cwd: 'C:/repo' });
    expect(r.isError).toBe(true);
    expect(String(r.raw)).toContain('8b');
  });

  it('타임아웃은 isError(raw=timeout)', async () => {
    const fetchFn = ((_u: string, init: { signal: AbortSignal }) =>
      new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
    const r = await new AnthropicApiBrain(PROFILE, fetchFn).complete('x', undefined, { timeoutMs: 30 });
    expect(r.isError).toBe(true);
    expect(String(r.raw)).toContain('timeout');
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx jest src/brain/anthropic-api.brain.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 4: 구현**

`src/brain/anthropic-api.brain.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { BrainProvider, BrainResult, CompleteOpts } from './brain.port';
import { BrainProfile } from './brain.config';
import { Semaphore } from './semaphore';
import { sseJson } from './sse';
import { runToolLoop, ToolCall, TurnResult } from './tool-loop';
import { WEB_TOOL_DEFS, executeWebTool } from './web-tools';

// Anthropic Messages API 직접 호출 하네스(스펙 §2.1). 공식 SDK 미도입 — HTTP+SSE 직접.
// ponytail: SDK의 재시도·타이핑이 필요해지면 도입 재검토.
const DEFAULT_BASE = 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 16000;

type AnthropicMsg = { role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> };

function fail(raw: string): BrainResult {
  return { text: '', costUsd: 0, isError: true, raw };
}

@Injectable()
export class AnthropicApiBrain implements BrainProvider {
  private readonly sem: Semaphore;

  constructor(
    private readonly profile: BrainProfile,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.sem = new Semaphore(profile.concurrency);
  }

  complete(prompt: string, onChunk?: (text: string) => void, opts?: CompleteOpts): Promise<BrainResult> {
    return this.sem.run(async () => {
      // 코딩 신호(opts.cwd)는 8b까지 CLI 하네스 전용 — 조용한 품질저하 대신 정직한 거부(스펙 §2.3).
      if (opts?.cwd) return fail('coding requires a CLI-harness brain until Phase 8b (opts.cwd rejected)');
      if (!this.profile.apiKey) return fail('anthropic-api: apiKey missing in brains.json profile');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? this.profile.timeoutMs);
      const history: AnthropicMsg[] = [{ role: 'user', content: prompt }];
      try {
        const r = await runToolLoop(
          () => this.turn(history, onChunk, ctrl.signal),
          (results) => history.push({
            role: 'user',
            content: results.map((t) => ({ type: 'tool_result', tool_use_id: t.id, content: t.output })),
          }),
          (name, input) => executeWebTool(name, input, this.profile, this.fetchFn),
        );
        return {
          text: r.text,
          costUsd: this.cost(r.inputTokens, r.outputTokens),
          isError: false,
          ...(r.hitLimit ? { raw: 'tool-loop-limit' } : {}),
        };
      } catch (e) {
        return fail(ctrl.signal.aborted ? 'timeout' : String(e));
      } finally {
        clearTimeout(timer);
      }
    });
  }

  private cost(inTok: number, outTok: number): number {
    return (inTok * (this.profile.inputUsdPerMTok ?? 0) + outTok * (this.profile.outputUsdPerMTok ?? 0)) / 1_000_000;
  }

  // 한 턴 = 모델 호출 1회. SSE에서 텍스트(onChunk)·tool_use·usage를 수집하고 assistant 턴을 history에 기록.
  private async turn(history: AnthropicMsg[], onChunk: ((t: string) => void) | undefined, signal: AbortSignal): Promise<TurnResult> {
    const res = await this.fetchFn(`${this.profile.baseUrl || DEFAULT_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.profile.apiKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.profile.model,
        max_tokens: this.profile.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
        messages: history,
        tools: WEB_TOOL_DEFS.map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters })),
      }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const pending = new Map<number, { id: string; name: string; json: string }>();
    for await (const ev of sseJson(res.body)) {
      if (ev.type === 'message_start') {
        inputTokens = Number((ev.message as { usage?: { input_tokens?: number } })?.usage?.input_tokens ?? 0);
      } else if (ev.type === 'content_block_start') {
        const b = ev.content_block as { type?: string; id?: string; name?: string };
        if (b?.type === 'tool_use') pending.set(Number(ev.index), { id: String(b.id), name: String(b.name), json: '' });
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta as { type?: string; text?: string; partial_json?: string };
        if (d?.type === 'text_delta' && d.text) {
          text += d.text;
          onChunk?.(d.text);
        } else if (d?.type === 'input_json_delta') {
          const t = pending.get(Number(ev.index));
          if (t) t.json += d.partial_json ?? '';
        }
      } else if (ev.type === 'message_delta') {
        outputTokens += Number((ev.usage as { output_tokens?: number })?.output_tokens ?? 0);
      }
    }

    const toolCalls: ToolCall[] = [];
    for (const t of pending.values()) {
      let input: unknown = {};
      try {
        input = t.json ? JSON.parse(t.json) : {};
      } catch {
        // 오염된 인자 → 빈 객체(도구가 에러 텍스트로 응답해 모델이 재시도)
      }
      toolCalls.push({ id: t.id, name: t.name, input });
    }

    // assistant 턴을 history에 기록(다음 회전의 문맥)
    const blocks: Array<Record<string, unknown>> = [];
    if (text) blocks.push({ type: 'text', text });
    for (const c of toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
    if (blocks.length > 0) history.push({ role: 'assistant', content: blocks });

    return { text, toolCalls, inputTokens, outputTokens };
  }
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx jest src/brain/anthropic-api.brain.spec.ts`
Expected: PASS(6 테스트)

- [ ] **Step 6: 커밋**

```bash
git add src/brain/sse.ts src/brain/anthropic-api.brain.ts src/brain/anthropic-api.brain.spec.ts
git commit -m "feat(phase8a): AnthropicApiBrain — Messages API 직접 호출(SSE 스트리밍+도구루프)"
```

---

### Task 5: OpenAiApiBrain (OpenAI호환 — Ollama·LM Studio·OpenAI)

**Files:**
- Create: `src/brain/openai-api.brain.ts`
- Test: `src/brain/openai-api.brain.spec.ts`

**Interfaces:**
- Consumes: Task 1~4와 동일 공용 모듈(`sseJson`·`runToolLoop`·`WEB_TOOL_DEFS`·`executeWebTool`).
- Produces: `class OpenAiApiBrain implements BrainProvider` — `constructor(profile, fetchFn = fetch)`. 가드: `baseUrl` 미설정 → isError, `model` 미설정 → isError, `apiKey`는 옵셔널(있으면 `Authorization: Bearer`).

- [ ] **Step 1: 실패 테스트 작성**

`src/brain/openai-api.brain.spec.ts`:

```ts
import { OpenAiApiBrain } from './openai-api.brain';
import { BrainProfile } from './brain.config';

const PROFILE: BrainProfile = {
  provider: 'openai-api', cli: '', model: 'llama3.3', concurrency: 1, timeoutMs: 5000,
  extraArgs: [], baseUrl: 'http://localhost:11434/v1',
};

function sse(chunks: Array<Record<string, unknown>>): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const TEXT_CHUNKS = [
  { choices: [{ delta: { content: 'Hi' } }] },
  { choices: [{ delta: { content: '!' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
];

const TOOL_CHUNKS = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'web_fetch', arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"url":"https://example.com/a"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } },
];

describe('OpenAiApiBrain', () => {
  it('단발 텍스트: onChunk 스트리밍 + usage 집계', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_CHUNKS)) as unknown as typeof fetch;
    const brain = new OpenAiApiBrain(PROFILE, fetchFn);
    const chunks: string[] = [];
    const r = await brain.complete('hello', (t) => chunks.push(t));
    expect(r.isError).toBe(false);
    expect(r.text).toBe('Hi!');
    expect(chunks).toEqual(['Hi', '!']);
    expect(r.costUsd).toBe(0); // 단가 미설정=0(Ollama)
    const req = (fetchFn as jest.Mock).mock.calls[0];
    expect(String(req[0])).toBe('http://localhost:11434/v1/chat/completions');
    expect(JSON.parse(req[1].body).tools[0].type).toBe('function');
    expect(req[1].headers.Authorization).toBeUndefined(); // apiKey 없음
  });

  it('도구루프: tool_calls 인자 조립 → 실행 → role:tool 되먹임 → 최종 답', async () => {
    let call = 0;
    const fetchFn = jest.fn(async (url: string) => {
      if (String(url).includes('/chat/completions')) {
        call++;
        return call === 1 ? sse(TOOL_CHUNKS) : sse(TEXT_CHUNKS);
      }
      return new Response('<p>Page body</p>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
    const r = await new OpenAiApiBrain(PROFILE, fetchFn).complete('go');
    expect(r.isError).toBe(false);
    expect(r.text).toBe('Hi!');
    const second = JSON.parse((fetchFn as jest.Mock).mock.calls.filter((c) => String(c[0]).includes('/chat/completions'))[1][1].body);
    const roles = second.messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool']);
    expect(second.messages[1].tool_calls[0].function.name).toBe('web_fetch');
    expect(second.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call1' });
    expect(second.messages[2].content).toContain('Page body');
  });

  it('apiKey 있으면 Bearer 헤더', async () => {
    const fetchFn = jest.fn(async () => sse(TEXT_CHUNKS)) as unknown as typeof fetch;
    await new OpenAiApiBrain({ ...PROFILE, apiKey: 'sk-o' }, fetchFn).complete('x');
    expect((fetchFn as jest.Mock).mock.calls[0][1].headers.Authorization).toBe('Bearer sk-o');
  });

  it('baseUrl 없으면 즉시 isError', async () => {
    const r = await new OpenAiApiBrain({ ...PROFILE, baseUrl: undefined }, jest.fn() as unknown as typeof fetch).complete('x');
    expect(r.isError).toBe(true);
    expect(String(r.raw)).toContain('baseUrl');
  });

  it('model 없으면 즉시 isError', async () => {
    const r = await new OpenAiApiBrain({ ...PROFILE, model: '' }, jest.fn() as unknown as typeof fetch).complete('x');
    expect(r.isError).toBe(true);
    expect(String(r.raw)).toContain('model');
  });

  it('opts.cwd는 즉시 isError·HTTP 5xx는 isError', async () => {
    const r1 = await new OpenAiApiBrain(PROFILE, jest.fn() as unknown as typeof fetch).complete('x', undefined, { cwd: 'C:/r' });
    expect(r1.isError).toBe(true);
    const f = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    const r2 = await new OpenAiApiBrain(PROFILE, f).complete('x');
    expect(r2.isError).toBe(true);
    expect(String(r2.raw)).toContain('503');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/brain/openai-api.brain.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`src/brain/openai-api.brain.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { BrainProvider, BrainResult, CompleteOpts } from './brain.port';
import { BrainProfile } from './brain.config';
import { Semaphore } from './semaphore';
import { sseJson } from './sse';
import { runToolLoop, ToolCall, TurnResult } from './tool-loop';
import { WEB_TOOL_DEFS, executeWebTool } from './web-tools';

// OpenAI호환 chat/completions 하네스(스펙 §2.2) — Ollama·LM Studio·vLLM·OpenAI 공용.
// 모델이 tool calling을 지원 안 하면 tool_calls가 안 올 뿐(기능 저하이지 에러 아님).
const DEFAULT_MAX_TOKENS = 16000;

type OpenAiMsg = {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

function fail(raw: string): BrainResult {
  return { text: '', costUsd: 0, isError: true, raw };
}

@Injectable()
export class OpenAiApiBrain implements BrainProvider {
  private readonly sem: Semaphore;

  constructor(
    private readonly profile: BrainProfile,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.sem = new Semaphore(profile.concurrency);
  }

  complete(prompt: string, onChunk?: (text: string) => void, opts?: CompleteOpts): Promise<BrainResult> {
    return this.sem.run(async () => {
      if (opts?.cwd) return fail('coding requires a CLI-harness brain until Phase 8b (opts.cwd rejected)');
      if (!this.profile.baseUrl) return fail('openai-api: baseUrl missing in brains.json profile');
      if (!this.profile.model) return fail('openai-api: model missing in brains.json profile');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? this.profile.timeoutMs);
      const history: OpenAiMsg[] = [{ role: 'user', content: prompt }];
      try {
        const r = await runToolLoop(
          () => this.turn(history, onChunk, ctrl.signal),
          (results) => {
            for (const t of results) history.push({ role: 'tool', content: t.output, tool_call_id: t.id });
          },
          (name, input) => executeWebTool(name, input, this.profile, this.fetchFn),
        );
        return {
          text: r.text,
          costUsd: this.cost(r.inputTokens, r.outputTokens),
          isError: false,
          ...(r.hitLimit ? { raw: 'tool-loop-limit' } : {}),
        };
      } catch (e) {
        return fail(ctrl.signal.aborted ? 'timeout' : String(e));
      } finally {
        clearTimeout(timer);
      }
    });
  }

  private cost(inTok: number, outTok: number): number {
    return (inTok * (this.profile.inputUsdPerMTok ?? 0) + outTok * (this.profile.outputUsdPerMTok ?? 0)) / 1_000_000;
  }

  private async turn(history: OpenAiMsg[], onChunk: ((t: string) => void) | undefined, signal: AbortSignal): Promise<TurnResult> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.profile.apiKey) headers.Authorization = `Bearer ${this.profile.apiKey}`;
    const res = await this.fetchFn(`${this.profile.baseUrl!.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.profile.model,
        max_tokens: this.profile.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
        stream_options: { include_usage: true }, // usage 미지원 서버면 그 청크가 안 올 뿐(토큰 0)
        messages: history,
        tools: WEB_TOOL_DEFS.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } })),
      }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const pending = new Map<number, { id: string; name: string; args: string }>();
    for await (const ev of sseJson(res.body)) {
      const usage = ev.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      if (usage) {
        inputTokens = Number(usage.prompt_tokens ?? 0);
        outputTokens = Number(usage.completion_tokens ?? 0);
      }
      const delta = (ev.choices as Array<{ delta?: Record<string, unknown> }> | undefined)?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        onChunk?.(delta.content);
      }
      const calls = delta.tool_calls as Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> | undefined;
      for (const c of calls ?? []) {
        const slot = pending.get(c.index) ?? { id: '', name: '', args: '' };
        if (c.id) slot.id = c.id;
        if (c.function?.name) slot.name = c.function.name;
        if (c.function?.arguments) slot.args += c.function.arguments;
        pending.set(c.index, slot);
      }
    }

    const toolCalls: ToolCall[] = [];
    const rawCalls: NonNullable<OpenAiMsg['tool_calls']> = [];
    for (const t of pending.values()) {
      let input: unknown = {};
      try {
        input = t.args ? JSON.parse(t.args) : {};
      } catch {
        // 오염된 인자 → 빈 객체(도구가 에러 텍스트로 응답)
      }
      toolCalls.push({ id: t.id, name: t.name, input });
      rawCalls.push({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } });
    }

    history.push({
      role: 'assistant',
      content: text || null,
      ...(rawCalls.length > 0 ? { tool_calls: rawCalls } : {}),
    });

    return { text, toolCalls, inputTokens, outputTokens };
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/brain/openai-api.brain.spec.ts`
Expected: PASS(6 테스트)

- [ ] **Step 5: 커밋**

```bash
git add src/brain/openai-api.brain.ts src/brain/openai-api.brain.spec.ts
git commit -m "feat(phase8a): OpenAiApiBrain — OpenAI호환 직접 호출(Ollama 등, claude CLI 불필요)"
```

---

### Task 6: brain.factory 배선

**Files:**
- Modify: `src/brain/brain.factory.ts`
- Test: `src/brain/brain.factory.spec.ts`

**Interfaces:**
- Consumes: Task 4 `AnthropicApiBrain`, Task 5 `OpenAiApiBrain`.
- Produces: `createBrain(profile)`이 `'anthropic-api'`/`'openai-api'`에 해당 인스턴스 반환(다른 provider와 동일한 lazy require 패턴).

- [ ] **Step 1: 실패 테스트 추가**

`src/brain/brain.factory.spec.ts` 끝에 append:

```ts
import { AnthropicApiBrain } from './anthropic-api.brain';
import { OpenAiApiBrain } from './openai-api.brain';

describe('createBrain — Phase 8a API providers', () => {
  const base = { cli: '', model: 'm', concurrency: 1, timeoutMs: 1000, extraArgs: [] };
  it('anthropic-api → AnthropicApiBrain', () => {
    expect(createBrain({ ...base, provider: 'anthropic-api', apiKey: 'k' })).toBeInstanceOf(AnthropicApiBrain);
  });
  it('openai-api → OpenAiApiBrain', () => {
    expect(createBrain({ ...base, provider: 'openai-api', baseUrl: 'http://x/v1' })).toBeInstanceOf(OpenAiApiBrain);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/brain/brain.factory.spec.ts`
Expected: FAIL — `지원하지 않는 provider: anthropic-api`.

- [ ] **Step 3: 구현**

`src/brain/brain.factory.ts`의 switch에 case 2개 추가(gemini/codex와 동일한 lazy require 패턴):

```ts
    case 'anthropic-api': {
      const { AnthropicApiBrain } = require('./anthropic-api.brain');
      return new AnthropicApiBrain(profile);
    }
    case 'openai-api': {
      const { OpenAiApiBrain } = require('./openai-api.brain');
      return new OpenAiApiBrain(profile);
    }
```

파일 상단 주석의 "로컬LLM은 claude-cli + env 프로필이라 별 provider 불요"는 낡았으니 교체:

```ts
// brains.json provider → 어댑터(설계 §6). Phase 8a: anthropic-api/openai-api = 자체 하네스(CLI 불필요).
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/brain/brain.factory.spec.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/brain/brain.factory.ts src/brain/brain.factory.spec.ts
git commit -m "feat(phase8a): createBrain에 anthropic-api·openai-api 케이스 배선"
```

---

### Task 7: 데스크톱 설정 — Anthropic 키 입력 + Ollama 흐름 openai-api 전환

**Files:**
- Create: `src/desktop/brains-file.ts` (공용 병합 쓰기)
- Create: `src/desktop/api-brain.ts` (`saveAnthropicApiKey`)
- Modify: `src/desktop/ollama.ts` (openai-api 프로필로 교체)
- Modify: `src/desktop/main.ts` (IPC `engram:save-api-key`)
- Modify: `src/desktop/preload.ts` (`saveApiKey`)
- Modify: `src/desktop/settings.html` (키 입력 UI + i18n + ollamaMissing 문구 갱신)
- Test: `src/desktop/brains-file.spec.ts`, `src/desktop/api-brain.spec.ts`, `src/desktop/ollama.spec.ts`(기대값 갱신)

**Interfaces:**
- Consumes: Task 1의 프로필 필드 이름(`provider`/`baseUrl`/`apiKey`/`model`).
- Produces:
  - `mergeBrainProfile(configDir: string, name: string, profile: Record<string, unknown>, setDefault?: boolean): void`
  - `saveAnthropicApiKey(configDir: string, apiKey: string, setDefault?: boolean): void` — `brains.anthropic = { provider:'anthropic-api', model:'claude-opus-4-8', apiKey }`
  - `addOllamaProfile(configDir, model, setDefault?)` — **변경**: `brains.ollama = { provider:'openai-api', baseUrl:'http://localhost:11434/v1', model }`

- [ ] **Step 1: brains-file 테스트 작성**

`src/desktop/brains-file.spec.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mergeBrainProfile } from './brains-file';

describe('mergeBrainProfile', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-bf-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const read = () => JSON.parse(fs.readFileSync(path.join(tmp, 'brains.json'), 'utf8'));

  it('없으면 만들고 프로필 병합(default=claude 유지)', () => {
    mergeBrainProfile(tmp, 'x', { provider: 'openai-api' });
    expect(read()).toEqual({ default: 'claude', brains: { x: { provider: 'openai-api' } } });
  });

  it('기존 프로필 보존 + setDefault 시 default 교체', () => {
    fs.writeFileSync(path.join(tmp, 'brains.json'), JSON.stringify({ default: 'claude', brains: { claude: { model: 'opus' } } }));
    mergeBrainProfile(tmp, 'api', { provider: 'anthropic-api' }, true);
    const cfg = read();
    expect(cfg.brains.claude).toEqual({ model: 'opus' });
    expect(cfg.default).toBe('api');
  });

  it('깨진 파일은 기본 골격으로 재작성', () => {
    fs.writeFileSync(path.join(tmp, 'brains.json'), '{{{');
    mergeBrainProfile(tmp, 'x', { provider: 'openai-api' });
    expect(read().brains.x.provider).toBe('openai-api');
  });
});
```

- [ ] **Step 2: 실패 확인 후 brains-file 구현**

Run: `npx jest src/desktop/brains-file.spec.ts` → FAIL(모듈 없음) 확인 후, `src/desktop/brains-file.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';

// brains.json 병합 쓰기(설정창 공용): 다른 프로필·설정 보존, 깨진 파일은 기본 골격으로 재작성.
export function mergeBrainProfile(configDir: string, name: string, profile: Record<string, unknown>, setDefault = false): void {
  const file = path.join(configDir, 'brains.json');
  let cfg: { default: string; brains: Record<string, unknown> } = { default: 'claude', brains: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') cfg = { default: raw.default ?? 'claude', brains: raw.brains ?? {} };
  } catch {
    // 없거나 깨짐 → 기본 골격
  }
  cfg.brains[name] = profile;
  if (setDefault) cfg.default = name;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}
```

Run: `npx jest src/desktop/brains-file.spec.ts` → PASS.

- [ ] **Step 3: ollama.spec 기대값을 openai-api로 갱신(RED)**

`src/desktop/ollama.spec.ts`의 `addOllamaProfile` 기대값들을 교체 — `provider: 'claude-cli', cli: 'claude', env: {...}` 검증을 다음으로:

```ts
  it('brains.json이 없으면 만들고 ollama 프로필을 넣는다(default는 claude 유지)', () => {
    addOllamaProfile(tmp, 'llama3.3:latest');
    const cfg = readBrains();
    expect(cfg.brains.ollama).toEqual({
      provider: 'openai-api',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.3:latest',
    });
    expect(cfg.default).toBe('claude');
  });
```

(같은 describe의 나머지 테스트들도 `provider: 'openai-api'` 형태를 기대하도록 동일하게 갱신. `detectOllama` 테스트는 무변경.)

Run: `npx jest src/desktop/ollama.spec.ts` → FAIL 확인.

- [ ] **Step 4: ollama.ts 교체(GREEN)**

`src/desktop/ollama.ts`의 `addOllamaProfile`을 교체(헤더 주석 포함):

```ts
import { mergeBrainProfile } from './brains-file';

// Ollama 도우미: Phase 8a부터 자체 하네스(openai-api provider)로 직접 붙는다 — claude CLI 불필요.
// (이전: claude-cli 껍데기 + env 교체 — Phase 8a에서 폐기. 기존 사용자 프로필은 건드리지 않음.)

// …detectOllama는 무변경…

export function addOllamaProfile(configDir: string, model: string, setDefault = false): void {
  mergeBrainProfile(configDir, 'ollama', {
    provider: 'openai-api',
    baseUrl: `${OLLAMA_URL}/v1`,
    model,
  }, setDefault);
}
```

Run: `npx jest src/desktop/ollama.spec.ts` → PASS.

- [ ] **Step 5: api-brain 테스트+구현**

`src/desktop/api-brain.spec.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { saveAnthropicApiKey } from './api-brain';

describe('saveAnthropicApiKey', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ak-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('anthropic 프로필을 쓰고 기본은 유지', () => {
    saveAnthropicApiKey(tmp, 'sk-ant-x');
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'brains.json'), 'utf8'));
    expect(cfg.brains.anthropic).toEqual({ provider: 'anthropic-api', model: 'claude-opus-4-8', apiKey: 'sk-ant-x' });
    expect(cfg.default).toBe('claude');
  });

  it('setDefault=true면 default를 anthropic으로', () => {
    saveAnthropicApiKey(tmp, 'sk-ant-x', true);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'brains.json'), 'utf8'));
    expect(cfg.default).toBe('anthropic');
  });
});
```

RED 확인 후 `src/desktop/api-brain.ts`:

```ts
import { mergeBrainProfile } from './brains-file';

// 설정창(스펙 §5): Anthropic API 키 저장 → anthropic-api 프로필 생성/갱신(반영은 상주 재시작).
export function saveAnthropicApiKey(configDir: string, apiKey: string, setDefault = false): void {
  mergeBrainProfile(configDir, 'anthropic', {
    provider: 'anthropic-api',
    model: 'claude-opus-4-8',
    apiKey,
  }, setDefault);
}
```

Run: `npx jest src/desktop/api-brain.spec.ts` → PASS.

- [ ] **Step 6: IPC + preload + settings.html 배선(테스트 없는 접합부 — 로직은 위 모듈이 담당)**

`src/desktop/main.ts` — import에 `import { saveAnthropicApiKey } from './api-brain';` 추가, `registerIpc()` 안(`engram:save-token` 핸들러 옆)에:

```ts
  ipcMain.handle('engram:save-api-key', (_e, apiKey: string, setDefault: boolean) => {
    saveAnthropicApiKey(configDir, apiKey, setDefault);
  });
```

`src/desktop/preload.ts` — `saveToken` 줄 옆에:

```ts
  saveApiKey: (apiKey: string, setDefault: boolean) =>
    ipcRenderer.invoke('engram:save-api-key', apiKey, setDefault),
```

`src/desktop/settings.html` — 세 군데:

(a) `#sec-brain` 섹션의 `</section>` 직전(`#ollama-add` div 뒤)에 추가:

```html
    <div class="row" id="api-add" style="margin-top:14px">
      <input id="apikey" type="password" placeholder="sk-ant-…" />
      <label style="font-size:13px"><input type="checkbox" id="api-default" /> <span data-t="setDefault"></span></label>
      <button class="primary" id="btn-apikey" data-t="saveKey"></button>
    </div>
    <div id="api-note" style="font-size:12px;margin-top:4px;opacity:.75"></div>
```

CSS의 `input#token { width: 340px; … }` 셀렉터를 `input#token, input#apikey { … }`로 확장.

(b) i18n 사전(ko/en)에 추가·수정:

```js
      // ko에 추가
      saveKey: '저장',
      apiKeyNote: 'Anthropic API 키 — claude CLI 없이 두뇌를 씁니다. 기본 두뇌로 설정해도 코딩 기능은 아직 CLI 두뇌가 필요해요(Phase 8b).',
      apiKeySaved: '저장됨 — 재시작 후 적용',
      // ko ollamaMissing 교체(claude CLI 문구 제거)
      ollamaMissing: 'Ollama가 실행 중이 아니에요 — 로컬 LLM을 쓰려면 ollama.com에서 설치하세요',
      // en에 추가
      saveKey: 'Save',
      apiKeyNote: 'Anthropic API key — runs the brain without the claude CLI. Coding still needs a CLI brain until Phase 8b.',
      apiKeySaved: 'Saved — restart to apply',
      // en ollamaMissing 교체
      ollamaMissing: 'Ollama is not running — install it from ollama.com to use a local LLM',
```

(c) 초기화 스크립트(기존 `$('ollama').textContent = …` 부근)에:

```js
    $('api-note').textContent = t.apiKeyNote;
    $('btn-apikey').onclick = async () => {
      const k = $('apikey').value.trim();
      if (!k) return;
      await window.engram.saveApiKey(k, $('api-default').checked);
      $('api-note').textContent = t.apiKeySaved;
      $('apikey').value = '';
    };
```

- [ ] **Step 7: 데스크톱 스위트 통과 확인**

Run: `npx jest src/desktop`
Expected: PASS(brains-file 3·api-brain 2·ollama 갱신분 + 기존 전부)

- [ ] **Step 8: 커밋**

```bash
git add src/desktop/brains-file.ts src/desktop/brains-file.spec.ts src/desktop/api-brain.ts src/desktop/api-brain.spec.ts src/desktop/ollama.ts src/desktop/ollama.spec.ts src/desktop/main.ts src/desktop/preload.ts src/desktop/settings.html
git commit -m "feat(phase8a): 설정창 Anthropic 키 저장 + Ollama 흐름 openai-api 전환(claude CLI 불필요)"
```

---

### Task 8: 전체 회귀 + 빌드 검증

**Files:** 없음(검증만)

**Interfaces:** Consumes: 전 Task.

- [ ] **Step 1: 백엔드 전체 스위트**

Run: `npm test`
Expected: PASS(기존 + 신규 전부 — 특히 claude-cli.brain·orchestrator·brain.module 회귀 없음). 실패 시 해당 Task로 복귀.

- [ ] **Step 2: 렌더러 전체 스위트(무변경 확인)**

Run: `npm --prefix renderer test`
Expected: PASS.

- [ ] **Step 3: 타입/빌드**

Run: `npm run build && npm --prefix renderer run build`
Expected: nest/tsc/vite 에러 0.

---

## Self-Review

**Spec coverage:**
- §2.1 AnthropicApiBrain(SSE·도구·키가드·기본 base/model) → Task 4. ✅
- §2.2 OpenAiApiBrain(baseUrl·Bearer 옵셔널·tool calling 미지원 관용) → Task 5. ✅
- §2.3 공통 계약(never-throw·Semaphore·전체 타임아웃·cwd 거부·extraArgs 무시·costUsd·루프상한 isError=false) → Task 3~5 코드+테스트. ✅
- §3.1 미니 도구루프(상한 8·도구실패는 에러텍스트 되먹임) → Task 3 + Task 2 executeWebTool never-throw. ✅
- §3.2 web_search(DDG 기본+Brave/Tavily)·web_fetch(SSRF·상한)·스키마 단일정의 → Task 2. ✅
- §4 프로필 필드·ALLOWED·env·기본파일 무변경 → Task 1. ✅
- §5 설정창(키 입력·기본두뇌 경고문구·Ollama 교체·기존 프로필 무변경) → Task 7. ✅
- §6 하위호환(CLI 3종 무변경·키/baseUrl 미설정 즉시 isError) → Task 4·5 테스트 + Task 8 회귀. ✅
- §7 테스트 전략 전 항목(①~⑧) → Task 2~7의 테스트가 1:1 대응. ✅

**Placeholder scan:** "적절한 처리"류 없음 — 전 스텝 실제 코드/명령/기대 출력. Task 3 Step 1의 임시 표기 교체 지시 포함(의도된 지시문). ✅

**Type consistency:**
- `TurnResult`/`ToolCall`/`runToolLoop` 시그니처 — Task 3 정의, Task 4·5 사용 동일. ✅
- `executeWebTool(name, input, opts, fetchFn)` — Task 2 정의, Task 4·5 호출 동일. `SearchOpts`는 `BrainProfile`의 부분집합이라 profile 통째 전달 가능. ✅
- `sseJson(body)` — Task 4 정의, Task 5 동일 사용. ✅
- 프로필 필드 철자(`apiKey`/`baseUrl`/`maxTokens`/`inputUsdPerMTok`/`outputUsdPerMTok`/`searchProvider`/`searchApiKey`) — Task 1·2·4·5·7 전부 동일. ✅
- `mergeBrainProfile`/`saveAnthropicApiKey`/`addOllamaProfile` — Task 7 내 정의·IPC 사용 일치. ✅

**주의(구현자용):**
- Task 4·5 테스트는 도구 실행도 **같은 주입 fetchFn**을 타므로 URL로 분기하는 목이 필요(코드에 반영됨).
- `message_delta`의 `output_tokens`는 Anthropic이 누적값을 주지만 이벤트가 1회라 `+=`로 무해.
- Ollama `stream_options.include_usage` 미지원 구버전이면 usage 청크가 안 와서 토큰 0 → costUsd 0(Ollama는 어차피 0) — 에러 아님.
