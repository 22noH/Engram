import { useEffect, useRef, useState } from 'react';
import type { WikiPageMeta, WikiPageDto, ProposalDto, WikiSearchHit } from '../../../shared/protocol';
import { renderMarkdown } from '../render/markdown';
import { T } from '../i18n';

// 위키 영역: ① 페이지 읽기·의미검색(+게시 페이지 파괴적 행위) ② 승인함(두뇌 제안 승인/거부). 순수 프레젠테이션.
export function WikiArea(props: {
  pages: WikiPageMeta[];
  openPage: WikiPageDto | null;
  proposals: ProposalDto[];
  searchResults: WikiSearchHit[];
  canApprove: boolean;
  canUnpublish: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onOpenPage: (slug: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onUnpublish: (slug: string) => void;
  onEdit: (slug: string, body: string) => void;
  onDelete: (slug: string) => void;
  onSearch: (query: string) => void;
}) {
  const [tab, setTab] = useState<'pages' | 'inbox'>('pages');
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  // onSearch의 최신 참조(App이 매 렌더 새 콜백을 넘겨도 디바운스 effect를 재실행하지 않기 위함 — App의 ref 패턴).
  const onSearchRef = useRef(props.onSearch); onSearchRef.current = props.onSearch;

  // 다른 페이지로 전환하면 편집 모드 해제.
  useEffect(() => { setEditing(false); }, [props.openPage?.slug]);

  useEffect(() => {
    if (editing) return; // 편집 중엔 docBody 미마운트
    const el = bodyRef.current;
    if (el) el.replaceChildren(props.openPage ? renderMarkdown(props.openPage.body) : document.createDocumentFragment());
  }, [props.openPage, editing]);

  // 검색어 디바운스(300ms) → 서버 의미검색. 빈 쿼리면 검색 안 함(브라우즈 모드).
  useEffect(() => {
    const query = filter.trim();
    if (!query) return;
    const id = setTimeout(() => onSearchRef.current(query), 300);
    return () => clearTimeout(id);
  }, [filter]);

  const q = filter.trim();
  const open = props.openPage;
  const canAct = !!open && open.status === 'published'; // 게시 페이지만 대상

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
            <input type="text" placeholder={T.wikiSearchPh} value={filter} onChange={(e) => setFilter(e.target.value)} />
            {q === '' ? (
              props.pages.map((p) => (
                <div key={p.slug} className={'wikiRow' + (open?.slug === p.slug ? ' sel' : '')} onClick={() => props.onOpenPage(p.slug)}>
                  <span className="title">{p.title}</span>
                  <span className={'badge ' + p.status}>{p.status}</span>
                  <span className="cat">{p.category}</span>
                </div>
              ))
            ) : props.searchResults.length === 0 ? (
              <div className="empty">{T.wikiNoResults}</div>
            ) : (
              props.searchResults.map((h) => (
                <div key={h.slug} className={'wikiRow' + (open?.slug === h.slug ? ' sel' : '')} onClick={() => props.onOpenPage(h.slug)}>
                  <span className="title">{h.title}</span>
                  <span className="snippet">{h.snippet}</span>
                </div>
              ))
            )}
          </div>
          <div id="wikiDoc">
            {open && (
              <div className="docHead">
                <h1>{open.title}</h1>
                <span className="cat">{open.category}</span>
                {canAct && !editing && (
                  <span className="docActions">
                    {props.canEdit && <button type="button" onClick={() => { setDraft(open.body); setEditing(true); }}>{T.wikiEdit}</button>}
                    {props.canUnpublish && <button type="button" onClick={() => props.onUnpublish(open.slug)}>{T.wikiUnpublish}</button>}
                    {props.canDelete && <button type="button" className="danger" onClick={() => { if (window.confirm(T.wikiDeleteConfirm)) props.onDelete(open.slug); }}>{T.wikiDelete}</button>}
                  </span>
                )}
              </div>
            )}
            {editing && open ? (
              <div className="docEdit">
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
                <div className="docEditActions">
                  <button type="button" onClick={() => { props.onEdit(open.slug, draft); setEditing(false); }}>{T.wikiSave}</button>
                  <button type="button" onClick={() => setEditing(false)}>{T.wikiCancel}</button>
                </div>
              </div>
            ) : (
              <div className="docBody" ref={bodyRef} />
            )}
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
