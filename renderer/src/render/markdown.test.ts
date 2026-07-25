import { renderMarkdown, splitHtmlBlocks, HTML_PREVIEW_MAX } from './markdown';

const html = (t: string) => { const d = document.createElement('div'); d.appendChild(renderMarkdown(t)); return d; };

it('체크리스트를 disabled 체크박스로 렌더한다', () => {
  const d = html('- [x] 완료\n- [ ] 미완');
  const boxes = d.querySelectorAll('ul.check input[type=checkbox]');
  expect(boxes).toHaveLength(2);
  expect((boxes[0] as HTMLInputElement).checked).toBe(true);
  expect((boxes[0] as HTMLInputElement).disabled).toBe(true);
});

it('비교 표를 렌더하고 +/▲ 셀에 up 클래스를 준다', () => {
  const d = html('| 항목 | 값 |\n| --- | --- |\n| 매출 | ▲ 12% |');
  expect(d.querySelector('table.cmp')).toBeTruthy();
  expect(d.querySelector('td.up')).toBeTruthy();
});

it('```chart bar 블록을 SVG로 렌더한다', () => {
  const d = html('```chart\n{"type":"bar","labels":["a","b"],"values":[1,2]}\n```');
  expect(d.querySelector('.chart svg rect.cbar')).toBeTruthy();
});

// HTML 인라인 미리보기 — 메시지 텍스트를 "마크다운 조각 / html 코드블록"으로 쪼개는 토크나이저.
// renderMarkdown과 같은 ``` 규칙(짝수=본문, 홀수=코드블록)을 써야 두 렌더가 어긋나지 않는다.
describe('splitHtmlBlocks', () => {
  it('html 블록이 없으면 원문 그대로 md 세그먼트 1개다(회귀 0)', () => {
    const t = '앞말\n```js\nconst a = 1\n```\n뒷말';
    expect(splitHtmlBlocks(t)).toEqual([{ kind: 'md', text: t }]);
  });

  it('```html 블록을 html 세그먼트로 분리하고 앞뒤 마크다운을 보존한다', () => {
    const segs = splitHtmlBlocks('앞말\n```html\n<h1>hi</h1>\n```\n뒷말');
    expect(segs.map((s) => s.kind)).toEqual(['md', 'html', 'md']);
    expect(segs[1]).toEqual({ kind: 'html', code: '<h1>hi</h1>' });
    expect(segs[0]).toEqual({ kind: 'md', text: '앞말' });
    expect(segs[2]).toEqual({ kind: 'md', text: '뒷말' });
  });

  it('html 블록만 있는 메시지는 html 세그먼트 하나만 낸다(빈 md 조각 없음)', () => {
    expect(splitHtmlBlocks('```html\n<p>x</p>\n```')).toEqual([{ kind: 'html', code: '<p>x</p>' }]);
  });

  it('아직 닫히지 않은 html 펜스(스트리밍 중)는 미리보기로 빼지 않는다', () => {
    const t = '앞말\n```html\n<h1>hi';
    expect(splitHtmlBlocks(t)).toEqual([{ kind: 'md', text: t }]);
  });

  it('임계값(200KB) 초과 html은 미리보기 대신 코드블록으로 폴백한다', () => {
    const t = '```html\n<p>' + 'x'.repeat(HTML_PREVIEW_MAX) + '</p>\n```';
    expect(splitHtmlBlocks(t)).toEqual([{ kind: 'md', text: t }]);
    expect(HTML_PREVIEW_MAX).toBe(200 * 1024);
  });

  it('빈 html 블록은 미리보기로 빼지 않는다', () => {
    const t = '```html\n\n```';
    expect(splitHtmlBlocks(t)).toEqual([{ kind: 'md', text: t }]);
  });
});

it('외부 링크만 허용하고 스크립트 텍스트는 실행 노드가 아니다(XSS)', () => {
  const d = html('[safe](https://x.com) <script>alert(1)</script>');
  expect(d.querySelector('a[href="https://x.com"]')).toBeTruthy();
  expect(d.querySelector('script')).toBeNull(); // textContent로만 들어가 실행 노드 아님
});
