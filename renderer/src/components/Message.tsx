import { useEffect, useRef, useState } from 'react';
import type { Message as Msg, AttachmentMeta } from '../../../shared/protocol';
import { renderMarkdown } from '../render/markdown';
import { ko } from '../config';
import { ActionButtons } from './ActionButtons';
import { QuestionCard } from './QuestionCard';
import { fetchAttachmentBlobUrl } from '../auth-api';

// Task 4(chat-attachments) — 그 메시지가 속한 연결의 접속 정보(http 엔드포인트·실 채널id·세션 토큰).
// App이 anchorConn(메시지→연결) 매핑으로 계산해 Thread를 거쳐 내려준다. 못 구하면(edge case) 첨부는
// 로딩 상태로 남고 조용히 포기(never-throw 결).
export interface AttachmentCtx { endpoint: string; channelId: string; token?: string }

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// 첨부 1개: 이미지=인라인 썸네일(클릭=새 창에서 원본), 그 외=칩(클릭=다운로드). 인증 연결은
// <img src>/평범한 링크가 Authorization 헤더를 못 실어(브라우저 한계) fetch+blob으로 통일했다
// (무인증 연결도 같은 경로 — 렌더러 단순화, 구현자 재량 사용·브리프에 보고). 언마운트 시 revoke(누수 방지).
function Attachment({ a, ctx }: { a: AttachmentMeta; ctx?: AttachmentCtx }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const revokeRef = useRef<string | null>(null);
  // T4 리뷰 C1: deps는 반드시 원시값이어야 한다 — ctx는 App이 매 렌더 새 객체 리터럴로 내려주므로
  // (attachmentCtxFor가 렌더마다 새로 만듦) ctx 자체를 deps에 넣으면 값이 같아도 매 렌더 재fetch+revoke가
  // 돈다(타자마다 이미 보이는 첨부까지 재요청하는 처닝). endpoint/channelId/token/id 4개 원시값만 비교.
  useEffect(() => {
    if (!ctx) return;
    let alive = true;
    void fetchAttachmentBlobUrl(ctx.endpoint, ctx.channelId, a.id, ctx.token).then((url) => {
      if (!url) return;
      // T4 리뷰 I3: 언마운트 후 도착한 fetch도 blob은 이미 만들어졌으니 URL을 그대로 흘리면 누수다 —
      // alive가 꺼졌으면 state에 반영하지 않고 즉시 revoke한다.
      if (!alive) { URL.revokeObjectURL(url); return; }
      revokeRef.current = url;
      setBlobUrl(url);
    });
    return () => {
      alive = false;
      if (revokeRef.current) { URL.revokeObjectURL(revokeRef.current); revokeRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx?.endpoint, ctx?.channelId, ctx?.token, a.id]);

  const isImage = IMAGE_MIMES.has(a.mime);
  if (isImage) {
    return blobUrl
      ? <img className="attachThumb" src={blobUrl} alt={a.name} onClick={() => window.open(blobUrl, '_blank')} />
      : <span className="attachChip loading">{a.name}</span>;
  }
  return (
    <span
      className={'attachChip file' + (blobUrl ? '' : ' loading')}
      title={`${a.mime} · ${formatSize(a.size)}`}
      onClick={() => { if (blobUrl) triggerDownload(blobUrl, a.name); }}
    >
      <span className="icon">📄</span>
      <span className="name">{a.name}</span>
      <span className="meta">{formatSize(a.size)}</span>
    </span>
  );
}

// 메시지 1개. 본문은 검증된 DOM 빌더를 ref로 마운트(React 이스케이프 밖이지만 빌더가 XSS 안전).
// 선택이 필요한 결정 지점은 actions 버튼(ActionButtons)이 담당 — 번호 나열은 그냥 텍스트다.
// onSend: actions 버튼 클릭 시 그 send 문자열을 현재 채널로 보낸다(App.sendText로 연결). 기존 테스트 호환 위해 optional.
// myName 지정(team, Phase16a부터 값은 "내 계정 id") 시 authorId===myName만 '나',
// 그 외 사람은 authorName(서버 스탬프)을 우선 표시, 없으면 authorId(.other).
// myName 미지정(Ask/Code)이면 비-engram은 전부 '나'(기존 동작 유지).
// m.question 있으면 QuestionCard가 본문 자리를 대신한다(m.text는 비-self 어댑터용 폴백이라 렌더러에선
// 카드가 원본 — 텍스트와 카드를 같이 보여주지 않는다). answeredText/onAnswer는 Task 5(App→Thread)에서 내려온다.
// attachmentCtx(Task 4): m.attachments 렌더에 필요한 연결 정보(App→Thread→Message로 전달, optional —
// 없으면 기존 테스트·attachments 없는 메시지 회귀 0).
export function Message({ m, onSend, myName, answeredText, onAnswer, attachmentCtx }: {
  m: Msg; onSend?: (text: string) => void; myName?: string;
  answeredText?: string; onAnswer?: (text: string, answersId: string) => void;
  attachmentCtx?: AttachmentCtx;
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
      {m.attachments && m.attachments.length > 0 && (
        <div className="attachRow">
          {m.attachments.map((a) => <Attachment key={a.id} a={a} ctx={attachmentCtx} />)}
        </div>
      )}
      {/* 최종 리뷰 픽스(방어): 카드가 있으면 액션 버튼은 안 그린다 — 현재 프로듀서는 question과 actions를
          동시에 안 보내지만(위 주석), 이 게이트가 없으면 미래에 둘 다 실린 메시지가 카드+버튼을 같이
          그려 사용자가 어디에 답해야 할지 헷갈린다. */}
      {!m.question && m.actions && m.actions.length > 0 && onSend && <ActionButtons actions={m.actions} onSend={onSend} />}
    </div>
  );
}
