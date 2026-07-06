import { useEffect, useRef } from 'react';
import type { Message as Msg } from '../../../shared/protocol';
import { renderMarkdown } from '../render/markdown';
import { ko } from '../config';

// 메시지 1개. 본문은 검증된 DOM 빌더를 ref로 마운트(React 이스케이프 밖이지만 빌더가 XSS 안전).
// engram 메시지의 번호목록(후보 선택 등)은 클릭하면 그 번호가 입력창에 채워지도록 onPick 호출.
export function Message({ m, onPick }: { m: Msg; onPick: (text: string) => void }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const isEngram = m.authorId === 'engram';
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.replaceChildren(renderMarkdown(m.text));
    if (isEngram) {
      body.querySelectorAll('ol').forEach((ol) => {
        ol.querySelectorAll(':scope > li').forEach((li, i) => {
          li.classList.add('pick');
          (li as HTMLElement).title = ko ? '클릭하면 번호가 입력됩니다' : 'Click to fill this number';
          (li as HTMLElement).onclick = () => onPick(String(i + 1));
        });
      });
    }
  }, [m.text, isEngram, onPick]);
  return (
    <div className={'msg' + (isEngram ? '' : ' me')}>
      <div className="who">{(isEngram ? 'Engram' : ko ? '나' : 'me') + ' · ' + new Date(m.ts).toLocaleTimeString()}</div>
      <div className="body" ref={bodyRef} />
    </div>
  );
}
