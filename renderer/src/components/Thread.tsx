import { Fragment } from 'react';
import type { Message as Msg } from '../../../shared/protocol';
import { Message, type AttachmentCtx } from './Message';
import { ko } from '../config';
import { T } from '../i18n';

// 스레드 = Team 채널 전용(목업 승인). Chat·Code는 threaded=false로 내려와 답글이 스레드로 접히지 않고
// 앵커→답글 순서 그대로 평평하게(일반 메시지처럼) 이어지고, 답글을 새로 시작하는 입구도 안 보인다.
// 기록은 그대로 남고 표시만 바뀐다.
// Team에서 답글 2개 이상 = 스레드(참여자 아바타 겹침 + 답글 수 + 마지막 시각 + 접기 셰브론, 세로
// 연결선 안에 답글들, 입력창+보내기 버튼). 답글 1개는 그대로 인라인(.msg.reply) — 가벼운 대화가
// 무거워지지 않게(목업 명시).
// Task 5 — getAnsweredText/onAnswer: 질문 카드(m.question) 렌더용. App이 전체 메시지 배열에서
// answersId===그 메시지.id인 답을 찾아 넘겨준다(카드 자신은 답 목록을 모른다 — Message.tsx 주석 참조).
// Task 4 — getAttachmentCtx: m.attachments 렌더에 필요한 연결 정보를 메시지 id별로 내려준다
// (같은 이디엄 — anchor/replies가 서로 다른 연결에서 왔을 수 있어 메시지별로 다시 조회한다).

// 아바타 색: theme.css의 --av-1..--av-6(라이트/다크 각각 정의)에서 이름 해시로 고른다. 같은 사람은
// 언제나 같은 색이고, 색값 자체는 CSS 토큰이라 다크모드가 알아서 따라온다(하드코딩 없음).
const AVATAR_TOKENS = 6;
// 헤더에 겹쳐 보여줄 아바타 최대 개수. 넘치면 마지막 칸이 "+N"이 된다.
const MAX_AVATARS = 3;

export function avatarInitial(name: string): string {
  // [...str]로 코드포인트 단위 — 한글은 첫 음절, 이모지 이름도 안 깨진다.
  const first = [...name.trim()][0];
  return first ? first.toUpperCase() : '?';
}

export function avatarColor(name: string): string {
  // djb2 — 짧은 이름에서도 잘 흩어지고, 문자열만 같으면 언제 어디서 계산해도 같은 값(순수).
  let h = 5381;
  for (const ch of name) h = (Math.imul(h, 33) ^ (ch.codePointAt(0) ?? 0)) >>> 0;
  return `var(--av-${(h % AVATAR_TOKENS) + 1})`;
}

// 화면에 뜨는 이름. Message.tsx의 who 계산과 같은 규칙(engram=Engram, 나=myName 일치 또는 myName
// 미지정, 그 외=서버 스탬프 authorName ?? authorId)을 아바타에도 그대로 쓴다.
export function authorLabel(m: Msg, myName?: string): string {
  if (m.authorId === 'engram') return 'Engram';
  if (myName === undefined || m.authorId === myName) return ko ? '나' : 'me';
  return m.authorName ?? m.authorId;
}

// 답글 작성자 고유 인원을 등장 순서대로. 헤더 아바타 겹침용.
export function threadParticipants(replies: Msg[], myName?: string): string[] {
  const out: string[] = [];
  for (const r of replies) {
    const label = authorLabel(r, myName);
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

function hm(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function Avatar({ name, cls }: { name: string; cls: string }) {
  return <span className={cls} style={{ background: avatarColor(name) }} title={name}>{avatarInitial(name)}</span>;
}

export function Thread(props: {
  anchor: Msg; replies: Msg[]; draft: string; collapsed: boolean;
  onDraft: (v: string) => void; onReply: (text: string) => void;
  onToggle: (collapsed: boolean) => void; onSend?: (text: string, answersId?: string) => void;
  myName?: string;
  // Team 채널에서만 true. 생략 시 true(기존 호출부 호환) — App은 mode === 'team'을 그대로 내려준다.
  threaded?: boolean;
  getAnsweredText?: (id: string) => string | undefined;
  onAnswer?: (text: string, answersId: string) => void;
  getAttachmentCtx?: (id: string) => AttachmentCtx | undefined;
  // HTML 인라인 미리보기 — 카드의 확대 버튼을 우측 코드 패널로 잇는다(App이 패널 가능할 때만 전달).
  onExpandHtml?: (html: string) => void;
  // 진행 중 표시 — 지금 실제로 돌고 있는 단계의 메시지 id(App이 판정). getAnsweredText와 같은 결로
  // Message까지 그대로 흘려보낸다.
  activeProgressId?: string;
  // 이미 쓴 버튼 숨기기 — 그 메시지의 액션이 이미 소비됐는지(App이 저장된 기록으로 판정).
  isActionsConsumed?: (id: string) => boolean;
  // 완료 보고서 액션 줄 — 코드 채널(데스크톱)에서만 내려온다. 다른 소품과 같은 결로 그대로 흘려보낸다.
  onShowDiff?: () => void;
  reportRepoPath?: string;
}) {
  const { anchor, replies } = props;
  const threaded = props.threaded ?? true;
  // 앵커·답글 모두 같은 방식으로 그린다 — Message가 마크다운·첨부·질문 카드·액션 버튼을 다 책임진다.
  const msg = (m: Msg) => (
    <Message m={m} onSend={props.onSend} myName={props.myName}
      answeredText={props.getAnsweredText?.(m.id)} onAnswer={props.onAnswer}
      attachmentCtx={props.getAttachmentCtx?.(m.id)} onExpandHtml={props.onExpandHtml}
      activeProgressId={props.activeProgressId}
      actionsConsumed={props.isActionsConsumed?.(m.id)}
      onShowDiff={props.onShowDiff} reportRepoPath={props.reportRepoPath} />
  );

  if (replies.length === 0) return msg(anchor);

  // Chat·Code — 평탄화: 앵커 다음에 답글들이 일반 메시지로 이어진다(들여쓰기·껍데기·답글칸 없음).
  if (!threaded) {
    return (<>
      {msg(anchor)}
      {replies.map((r) => <Fragment key={r.id}>{msg(r)}</Fragment>)}
    </>);
  }

  if (replies.length === 1) {
    return (<>
      {msg(anchor)}
      <div className="msg reply">{msg(replies[0])}</div>
    </>);
  }

  const participants = threadParticipants(replies, props.myName);
  const shown = participants.length > MAX_AVATARS ? participants.slice(0, MAX_AVATARS - 1) : participants;
  const overflow = participants.length - shown.length;
  const submit = () => {
    if (!props.draft.trim()) return; // 빈 답글 전송 금지
    props.onReply(props.draft);
    props.onDraft('');
  };

  return (<>
    {msg(anchor)}
    <div className="thread">
      {/* 헤더 전체가 토글 클릭 영역(키보드로도 열고 닫힌다). */}
      <div className="th-head" role="button" tabIndex={0} aria-expanded={!props.collapsed}
        onClick={() => props.onToggle(!props.collapsed)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onToggle(!props.collapsed); } }}>
        <span className="avs">
          {shown.map((n) => <Avatar key={n} name={n} cls="av" />)}
          {overflow > 0 && <span className="av more">{'+' + overflow}</span>}
        </span>
        <span className="th-count">{T.replies(replies.length)}</span>
        <span className="th-when">{T.threadLast(hm(replies[replies.length - 1].ts))}</span>
        <span className="chev">{props.collapsed ? '▼ ' + T.threadExpand : '▲ ' + T.threadCollapse}</span>
      </div>
      {!props.collapsed && (<>
        {replies.map((r) => (
          <div className="th-msg" key={r.id}>
            <Avatar name={authorLabel(r, props.myName)} cls="th-av" />
            <div className="th-body">{msg(r)}</div>
          </div>
        ))}
        <div className="treply">
          <input type="text" placeholder={T.replyPh} value={props.draft}
            onChange={(e) => props.onDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          <button type="button" className="th-send" onClick={submit}>{T.send}</button>
        </div>
      </>)}
    </div>
  </>);
}
