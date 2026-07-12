import type { RosterEntry } from '../../../shared/protocol';
import { T } from '../i18n';

// 비공개 채널 멤버 관리 패널(스펙 §3.3) — 주인에게만 App이 렌더. 순수 UI.
export function ChannelMembers(props: {
  roster: RosterEntry[]; memberIds: string[]; creatorId?: string; visibility: 'public' | 'private';
  onSetMembers: (memberIds: string[]) => void;
  onSetVisibility: (v: 'public' | 'private') => void;
  onClose: () => void;
}) {
  const isMember = (id: string) => id === props.creatorId || props.memberIds.includes(id);
  const toggle = (id: string, on: boolean) => {
    const base = props.memberIds.filter((m) => m !== id && m !== props.creatorId);
    props.onSetMembers(on ? [...base, id] : base);
  };
  return (
    <div id="membersOverlay" onClick={props.onClose}>
      <div id="membersPanel" onClick={(e) => e.stopPropagation()}>
        <div className="visRow">
          <span className={'visBadge ' + props.visibility}>{props.visibility === 'private' ? T.channelPrivate : ''}</span>
          {props.visibility === 'private'
            ? <button type="button" onClick={() => props.onSetVisibility('public')}>{T.makePublic}</button>
            : <button type="button" onClick={() => props.onSetVisibility('private')}>{T.makePrivate}</button>}
        </div>
        <div className="rosterList">
          {props.roster.map((r) => (
            <label key={r.id}>
              <input type="checkbox" aria-label={r.displayName}
                checked={isMember(r.id)}
                disabled={r.id === props.creatorId}
                onChange={(e) => toggle(r.id, e.target.checked)} />
              {r.displayName}{r.id === props.creatorId ? ' (owner)' : ''}
            </label>
          ))}
        </div>
        <button type="button" id="membersCloseBtn" onClick={props.onClose}>{T.membersClose}</button>
      </div>
    </div>
  );
}
