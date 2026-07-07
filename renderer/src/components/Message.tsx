import { useEffect, useRef } from 'react';
import type { Message as Msg } from '../../../shared/protocol';
import { renderMarkdown } from '../render/markdown';
import { ko } from '../config';
import { ActionButtons } from './ActionButtons';

// 메시지 1개. 본문은 검증된 DOM 빌더를 ref로 마운트(React 이스케이프 밖이지만 빌더가 XSS 안전).
// 선택이 필요한 결정 지점은 actions 버튼(ActionButtons)이 담당 — 번호 나열은 그냥 텍스트다.
// onSend: actions 버튼 클릭 시 그 send 문자열을 현재 채널로 보낸다(App.sendText로 연결). 기존 테스트 호환 위해 optional.
export function Message({ m, onSend }: { m: Msg; onSend?: (text: string) => void }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const isEngram = m.authorId === 'engram';
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.replaceChildren(renderMarkdown(m.text));
  }, [m.text]);
  return (
    <div className={'msg' + (isEngram ? '' : ' me')}>
      <div className="who">{(isEngram ? 'Engram' : ko ? '나' : 'me') + ' · ' + new Date(m.ts).toLocaleTimeString()}</div>
      <div className="body" ref={bodyRef} />
      {m.actions && m.actions.length > 0 && onSend && <ActionButtons actions={m.actions} onSend={onSend} />}
    </div>
  );
}
