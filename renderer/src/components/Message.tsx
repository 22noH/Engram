import { useEffect, useRef } from 'react';
import type { Message as Msg } from '../../../shared/protocol';
import { renderMarkdown } from '../render/markdown';
import { ko } from '../config';
import { ActionButtons } from './ActionButtons';
import { QuestionCard } from './QuestionCard';

// 메시지 1개. 본문은 검증된 DOM 빌더를 ref로 마운트(React 이스케이프 밖이지만 빌더가 XSS 안전).
// 선택이 필요한 결정 지점은 actions 버튼(ActionButtons)이 담당 — 번호 나열은 그냥 텍스트다.
// onSend: actions 버튼 클릭 시 그 send 문자열을 현재 채널로 보낸다(App.sendText로 연결). 기존 테스트 호환 위해 optional.
// myName 지정(team, Phase16a부터 값은 "내 계정 id") 시 authorId===myName만 '나',
// 그 외 사람은 authorName(서버 스탬프)을 우선 표시, 없으면 authorId(.other).
// myName 미지정(Ask/Code)이면 비-engram은 전부 '나'(기존 동작 유지).
// m.question 있으면 QuestionCard가 본문 자리를 대신한다(m.text는 비-self 어댑터용 폴백이라 렌더러에선
// 카드가 원본 — 텍스트와 카드를 같이 보여주지 않는다). answeredText/onAnswer는 Task 5(App→Thread)에서 내려온다.
export function Message({ m, onSend, myName, answeredText, onAnswer }: {
  m: Msg; onSend?: (text: string) => void; myName?: string;
  answeredText?: string; onAnswer?: (text: string, answersId: string) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const isEngram = m.authorId === 'engram';
  const isMe = !isEngram && (myName === undefined || m.authorId === myName);
  const who = isEngram ? 'Engram' : isMe ? (ko ? '나' : 'me') : (m.authorName ?? m.authorId);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.replaceChildren(renderMarkdown(m.text));
  }, [m.text]);
  return (
    <div className={'msg' + (isEngram ? '' : isMe ? ' me' : ' other')}>
      <div className="who">{who + ' · ' + new Date(m.ts).toLocaleTimeString()}</div>
      {m.question ? (
        <QuestionCard msgId={m.id} question={m.question} answeredText={answeredText} onAnswer={onAnswer ?? (() => {})} />
      ) : (
        <div className="body" ref={bodyRef} />
      )}
      {m.actions && m.actions.length > 0 && onSend && <ActionButtons actions={m.actions} onSend={onSend} />}
    </div>
  );
}
