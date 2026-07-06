import { renderMarkdown } from './markdown';

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

it('외부 링크만 허용하고 스크립트 텍스트는 실행 노드가 아니다(XSS)', () => {
  const d = html('[safe](https://x.com) <script>alert(1)</script>');
  expect(d.querySelector('a[href="https://x.com"]')).toBeTruthy();
  expect(d.querySelector('script')).toBeNull(); // textContent로만 들어가 실행 노드 아님
});
