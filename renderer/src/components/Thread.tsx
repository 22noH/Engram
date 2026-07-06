import { useState } from 'react';
import type { Message as Msg } from '../../../shared/protocol';
import { Message } from './Message';
import { T } from '../i18n';

// chat.html renderMsgs의 스레드 로직 이전: 답1=인라인(.reply), 2+=<details>(기본 펼침).
export function Thread(props: {
  anchor: Msg; replies: Msg[]; draft: string;
  onDraft: (v: string) => void; onReply: (text: string) => void; onPick: (t: string) => void;
}) {
  const { anchor, replies } = props;
  const [open, setOpen] = useState(true);
  if (replies.length === 0) return <Message m={anchor} onPick={props.onPick} />;
  if (replies.length === 1) {
    return (<>
      <Message m={anchor} onPick={props.onPick} />
      <div className="msg reply"><Message m={replies[0]} onPick={props.onPick} /></div>
    </>);
  }
  return (<>
    <Message m={anchor} onPick={props.onPick} />
    <details className="thread" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{'🧵 ' + T.replies(replies.length)}</summary>
      {replies.map((r) => <Message key={r.id} m={r} onPick={props.onPick} />)}
      <div className="treply">
        <input type="text" placeholder={T.replyPh} value={props.draft}
          onChange={(e) => props.onDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && props.draft.trim()) { props.onReply(props.draft); props.onDraft(''); } }} />
      </div>
    </details>
  </>);
}
