import { useEffect, useRef, useState } from 'react';
import type { WikiPageMeta, WikiPageDto, ProposalDto } from '../../../shared/protocol';
import { renderMarkdown } from '../render/markdown';
import { T } from '../i18n';

// 위키 영역: ① 페이지 읽기(아티팩트 스타일) ② 승인함(두뇌 제안 승인/거부). 순수 프레젠테이션.
export function WikiArea(props: {
  pages: WikiPageMeta[];
  openPage: WikiPageDto | null;
  proposals: ProposalDto[];
  canApprove: boolean;
  onOpenPage: (slug: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const [tab, setTab] = useState<'pages' | 'inbox'>('pages');
  const [filter, setFilter] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.replaceChildren(props.openPage ? renderMarkdown(props.openPage.body) : document.createDocumentFragment());
  }, [props.openPage]);

  const q = filter.trim().toLowerCase();
  const shown = q ? props.pages.filter((p) => p.title.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)) : props.pages;

  return (
    <div id="wikiArea">
      <div id="wikiTabs">
        <div className={'wtab' + (tab === 'pages' ? ' sel' : '')} onClick={() => setTab('pages')}>{T.wikiPages}</div>
        <div className={'wtab' + (tab === 'inbox' ? ' sel' : '')} onClick={() => setTab('inbox')}>
          {T.wikiInbox}{props.proposals.length > 0 ? ` (${props.proposals.length})` : ''}
        </div>
      </div>

      {tab === 'pages' ? (
        <div id="wikiPagesView">
          <div id="wikiList">
            <input type="text" placeholder={T.wikiFilterPh} value={filter} onChange={(e) => setFilter(e.target.value)} />
            {shown.map((p) => (
              <div key={p.slug} className={'wikiRow' + (props.openPage?.slug === p.slug ? ' sel' : '')} onClick={() => props.onOpenPage(p.slug)}>
                <span className="title">{p.title}</span>
                <span className={'badge ' + p.status}>{p.status}</span>
                <span className="cat">{p.category}</span>
              </div>
            ))}
          </div>
          <div id="wikiDoc">
            {props.openPage && <div className="docHead"><h1>{props.openPage.title}</h1><span className="cat">{props.openPage.category}</span></div>}
            <div className="docBody" ref={bodyRef} />
          </div>
        </div>
      ) : (
        <div id="wikiInbox">
          {props.proposals.length === 0 && <div className="empty">{T.wikiInboxEmpty}</div>}
          {props.proposals.map((p) => (
            <div key={p.id} className="propCard">
              <div className="propHead">
                <span className={'opBadge ' + p.op}>{p.op}</span>
                <span className="target">{p.title} · {p.targetSlug}</span>
              </div>
              <div className="propWhy">
                <span className="reason">{p.reason}</span>
                {` · ${Math.round(p.confidence * 100)}%`}
                {p.conflictSlugs?.length ? ` · ⚠ ${p.conflictSlugs.join(', ')}` : ''}
              </div>
              <PropBody markdown={p.payload} />
              {props.canApprove && (
                <div className="propActions">
                  <button type="button" onClick={() => props.onApprove(p.id)}>{T.wikiApprove}</button>
                  <button type="button" className="danger" onClick={() => props.onReject(p.id)}>{T.wikiReject}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 제안 본문 미리보기 — 검증된 마크다운 빌더 재사용(XSS 안전).
function PropBody({ markdown }: { markdown: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.replaceChildren(renderMarkdown(markdown)); }, [markdown]);
  return <div className="propBody" ref={ref} />;
}
