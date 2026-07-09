import type { Message as Msg } from '../../../shared/protocol';
import { Message } from './Message';
import { T } from '../i18n';

// chat.html renderMsgs의 스레드 로직 이전: 답1=인라인(.reply), 2+=<details>(기본 펼침).
export function Thread(props: {
  anchor: Msg; replies: Msg[]; draft: string; collapsed: boolean;
  onDraft: (v: string) => void; onReply: (text: string) => void;
  onToggle: (collapsed: boolean) => void; onSend?: (text: string) => void;
  myName?: string;
}) {
  const { anchor, replies } = props;
  if (replies.length === 0) return <Message m={anchor} onSend={props.onSend} myName={props.myName} />;
  if (replies.length === 1) {
    return (<>
      <Message m={anchor} onSend={props.onSend} myName={props.myName} />
      <div className="msg reply"><Message m={replies[0]} onSend={props.onSend} myName={props.myName} /></div>
    </>);
  }
  return (<>
    <Message m={anchor} onSend={props.onSend} myName={props.myName} />
    <details className="thread" open={!props.collapsed} onToggle={(e) => props.onToggle(!(e.target as HTMLDetailsElement).open)}>
      <summary>{'🧵 ' + T.replies(replies.length)}</summary>
      {replies.map((r) => <Message key={r.id} m={r} onSend={props.onSend} myName={props.myName} />)}
      <div className="treply">
        <input type="text" placeholder={T.replyPh} value={props.draft}
          onChange={(e) => props.onDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && props.draft.trim()) { props.onReply(props.draft); props.onDraft(''); } }} />
      </div>
    </details>
  </>);
}
