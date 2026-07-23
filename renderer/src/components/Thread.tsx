import type { Message as Msg } from '../../../shared/protocol';
import { Message, type AttachmentCtx } from './Message';
import { T } from '../i18n';

// chat.html renderMsgs의 스레드 로직 이전: 답1=인라인(.reply), 2+=<details>(기본 펼침).
// Task 5 — getAnsweredText/onAnswer: 질문 카드(m.question) 렌더용. App이 전체 메시지 배열에서
// answersId===그 메시지.id인 답을 찾아 넘겨준다(카드 자신은 답 목록을 모른다 — Message.tsx 주석 참조).
// Task 4 — getAttachmentCtx: m.attachments 렌더에 필요한 연결 정보를 메시지 id별로 내려준다
// (같은 이디엄 — anchor/replies가 서로 다른 연결에서 왔을 수 있어 메시지별로 다시 조회한다).
export function Thread(props: {
  anchor: Msg; replies: Msg[]; draft: string; collapsed: boolean;
  onDraft: (v: string) => void; onReply: (text: string) => void;
  onToggle: (collapsed: boolean) => void; onSend?: (text: string) => void;
  myName?: string;
  getAnsweredText?: (id: string) => string | undefined;
  onAnswer?: (text: string, answersId: string) => void;
  getAttachmentCtx?: (id: string) => AttachmentCtx | undefined;
}) {
  const { anchor, replies } = props;
  const answeredText = props.getAnsweredText?.(anchor.id);
  if (replies.length === 0) return <Message m={anchor} onSend={props.onSend} myName={props.myName} answeredText={answeredText} onAnswer={props.onAnswer} attachmentCtx={props.getAttachmentCtx?.(anchor.id)} />;
  if (replies.length === 1) {
    return (<>
      <Message m={anchor} onSend={props.onSend} myName={props.myName} answeredText={answeredText} onAnswer={props.onAnswer} attachmentCtx={props.getAttachmentCtx?.(anchor.id)} />
      <div className="msg reply"><Message m={replies[0]} onSend={props.onSend} myName={props.myName} answeredText={props.getAnsweredText?.(replies[0].id)} onAnswer={props.onAnswer} attachmentCtx={props.getAttachmentCtx?.(replies[0].id)} /></div>
    </>);
  }
  return (<>
    <Message m={anchor} onSend={props.onSend} myName={props.myName} answeredText={answeredText} onAnswer={props.onAnswer} attachmentCtx={props.getAttachmentCtx?.(anchor.id)} />
    <details className="thread" open={!props.collapsed} onToggle={(e) => props.onToggle(!(e.target as HTMLDetailsElement).open)}>
      <summary>{'🧵 ' + T.replies(replies.length)}</summary>
      {replies.map((r) => <Message key={r.id} m={r} onSend={props.onSend} myName={props.myName} answeredText={props.getAnsweredText?.(r.id)} onAnswer={props.onAnswer} attachmentCtx={props.getAttachmentCtx?.(r.id)} />)}
      <div className="treply">
        <input type="text" placeholder={T.replyPh} value={props.draft}
          onChange={(e) => props.onDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && props.draft.trim()) { props.onReply(props.draft); props.onDraft(''); } }} />
      </div>
    </details>
  </>);
}
