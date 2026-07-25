import { useState } from 'react';
import { T } from '../i18n';

// HTML 인라인 미리보기 카드 — 메시지 안 ```html 블록을 채팅 안에서 바로 렌더한다(승인된 목업).
// 헤더: 언어 라벨(왼쪽) + [미리보기]/[코드] 토글 + 확대(우측, onExpand 있을 때만).
// 본문: 기본은 미리보기(iframe), [코드]를 누르면 기존과 같은 pre>code.
//
// 보안(브리프 요구): 렌더는 반드시 sandbox iframe + srcdoc이고 sandbox는 allow-scripts 하나뿐이다.
// allow-same-origin을 같이 주면 샌드박스가 사실상 해제되어(자식이 부모와 동일 출처가 된다) 두뇌가
// 만든 HTML이 앱 DOM·localStorage·preload 브리지(window.engramDesktop)에 닿는다 — 절대 금지.
// srcdoc 문서는 unique origin이라 부모 접근·쿠키·IPC가 모두 막힌다.
export function HtmlPreview({ code, onExpand }: { code: string; onExpand?: (code: string) => void }) {
  const [view, setView] = useState<'preview' | 'code'>('preview');
  return (
    <div className="htmlCard">
      <div className="htmlCardBar">
        <span className="htmlCardLabel">html</span>
        <span className="htmlCardTabs">
          <button type="button" className={'htmlCardTab' + (view === 'preview' ? ' active' : '')}
            onClick={() => setView('preview')}>{T.htmlPreviewTab}</button>
          <button type="button" className={'htmlCardTab' + (view === 'code' ? ' active' : '')}
            onClick={() => setView('code')}>{T.htmlCodeTab}</button>
        </span>
        {onExpand && (
          <button type="button" className="htmlCardExpand" title={T.htmlExpand}
            onClick={() => onExpand(code)}>⤢</button>
        )}
      </div>
      {view === 'preview' ? (
        <iframe className="htmlCardFrame" sandbox="allow-scripts" srcDoc={code} title={T.htmlPreviewTab} />
      ) : (
        <pre className="htmlCardCode"><code>{code}</code></pre>
      )}
    </div>
  );
}
