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
