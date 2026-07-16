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

const MAX_REDIRECTS = 5;

// redirect:'manual' + 매 홉마다 isBlockedUrl 재검증(스펙 Finding2) — redirect:'follow'는 최초 URL만
// 검사하고 302 목적지는 그대로 따라가므로 공개 URL → 사설/링크로컬 리다이렉트로 SSRF 가드를 우회당한다.
export async function webFetch(url: string, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<string> {
  if (isBlockedUrl(url)) return `fetch error: blocked or invalid URL (public http/https only): ${url}`;
  try {
    let current = url;
    let hops = 0;
    for (;;) {
      const res = await fetchFn(current, { redirect: 'manual', signal });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        hops++;
        if (hops > MAX_REDIRECTS) return 'fetch error: too many redirects';
        const next = new URL(loc, current).toString();
        if (isBlockedUrl(next)) return `fetch error: blocked redirect target: ${next}`;
        current = next;
        continue;
      }
      if (!res.ok) return `fetch error: HTTP ${res.status}`;
      const body = await res.text();
      const ct = res.headers.get('content-type') ?? '';
      const text = ct.includes('html') || /^\s*</.test(body) ? stripHtml(body) : body;
      return text.length > FETCH_CHAR_LIMIT ? `${text.slice(0, FETCH_CHAR_LIMIT)}\n…(truncated)` : text;
    }
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

async function searchRaw(query: string, opts: SearchOpts, fetchFn: typeof fetch, signal?: AbortSignal): Promise<SearchHit[]> {
  if (opts.searchProvider === 'brave' && opts.searchApiKey) {
    const res = await fetchFn(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${SEARCH_LIMIT}`, {
      headers: { 'X-Subscription-Token': opts.searchApiKey, accept: 'application/json' },
      signal,
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
      signal,
    });
    if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
    const j = (await res.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
    return (j.results ?? []).slice(0, SEARCH_LIMIT).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }));
  }
  const res = await fetchFn(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (Engram)' },
    signal,
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const hits = parseDdgHtml(await res.text());
  if (hits.length === 0) throw new Error('DuckDuckGo 결과 파싱 실패(마크업 변경 가능)');
  return hits;
}

export async function webSearch(query: string, opts: SearchOpts = {}, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<string> {
  try {
    const hits = await searchRaw(query, opts, fetchFn, signal);
    if (hits.length === 0) return `no results for: ${query}`;
    return hits.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
  } catch (e) {
    return `search error: ${(e as Error).message} — 반복 실패 시 brains.json 프로필에 searchProvider(brave/tavily)+searchApiKey를 설정하세요.`;
  }
}

// 도구 실행 단일 진입점 — provider가 이름/인자만 넘긴다. never-throw.
// signal: 루프 타임아웃 AbortController를 관통시켜 모델 호출뿐 아니라 도구 실행(fetch)도 타임아웃이 덮게 한다(Finding1).
export async function executeWebTool(
  name: string,
  input: unknown,
  opts: SearchOpts = {},
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string> {
  const arg = (input ?? {}) as Record<string, unknown>;
  if (name === 'web_search') {
    return typeof arg.query === 'string' ? webSearch(arg.query, opts, fetchFn, signal) : 'tool error: query(string) required';
  }
  if (name === 'web_fetch') {
    return typeof arg.url === 'string' ? webFetch(arg.url, fetchFn, signal) : 'tool error: url(string) required';
  }
  return `tool error: unknown tool ${name}`;
}
