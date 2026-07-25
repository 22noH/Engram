import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HtmlPreview } from './HtmlPreview';
import { T } from '../i18n';

const CODE = '<h1>hi</h1><script>parent.postMessage(1)</script>';

describe('HtmlPreview 카드', () => {
  it('기본은 미리보기 — srcdoc iframe으로 렌더한다', () => {
    const { container } = render(<HtmlPreview code={CODE} />);
    const frame = container.querySelector('iframe');
    expect(frame).toBeTruthy();
    expect(frame?.getAttribute('srcdoc')).toBe(CODE);
    expect(container.querySelector('pre')).toBeNull();
  });

  // 보안 핵심: allow-scripts와 allow-same-origin을 같이 주면 샌드박스가 무력화된다(자식이 부모
  // 문서·쿠키·IPC에 닿는다). 이 테스트가 그 조합을 영구히 막는 가드다.
  it('sandbox는 allow-scripts 하나뿐이다(allow-same-origin 금지)', () => {
    const { container } = render(<HtmlPreview code={CODE} />);
    const sandbox = container.querySelector('iframe')?.getAttribute('sandbox');
    expect(sandbox).toBe('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
  });

  it('[코드] 토글은 원본 코드블록(pre>code)을, [미리보기]는 다시 iframe을 보여준다', () => {
    const { container } = render(<HtmlPreview code={CODE} />);
    fireEvent.click(screen.getByText(T.htmlCodeTab));
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('pre > code')?.textContent).toBe(CODE);

    fireEvent.click(screen.getByText(T.htmlPreviewTab));
    expect(container.querySelector('iframe')).toBeTruthy();
    expect(container.querySelector('pre')).toBeNull();
  });

  it('언어 라벨(html)을 헤더 왼쪽에 보여준다', () => {
    const { container } = render(<HtmlPreview code={CODE} />);
    expect(container.querySelector('.htmlCardLabel')?.textContent).toBe('html');
  });

  it('onExpand가 없으면 확대 버튼을 숨긴다(패널 없는 영역)', () => {
    const { container } = render(<HtmlPreview code={CODE} />);
    expect(container.querySelector('.htmlCardExpand')).toBeNull();
  });

  it('onExpand가 있으면 확대 버튼이 나오고 클릭 시 코드를 그대로 넘긴다', () => {
    const onExpand = vi.fn();
    const { container } = render(<HtmlPreview code={CODE} onExpand={onExpand} />);
    const btn = container.querySelector('.htmlCardExpand') as HTMLButtonElement;
    expect(btn.getAttribute('title')).toBe(T.htmlExpand);
    fireEvent.click(btn);
    expect(onExpand).toHaveBeenCalledWith(CODE);
  });
});
