import { useEffect, useRef, useState } from 'react';
import type { WikiPageMeta, WikiPageDto, ProposalDto, WikiSearchHit } from '../../../shared/protocol';
import { renderMarkdown } from '../render/markdown';
import { T } from '../i18n';
import { ko } from '../config';

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(ko ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric' });
}

function StatusPill({ status }: { status: WikiPageMeta['status'] }) {
  const label = status === 'published' ? T.wikiStatusPublished : T.wikiStatusDraft;
  return <span className={'pill' + (status === 'published' ? ' pub' : '')}>{label}</span>;
}

// 위키 영역: ① 페이지 읽기·의미검색(+게시 페이지 파괴적 행위) ② 승인함(두뇌 제안 승인/거부). 순수 프레젠테이션.
// 2026-07-19: 목업(docs/superpowers/mockups/2026-07-19-wiki-ui.html) 기준 시각 재구현 — 세그먼트+목록 위계·문서 타이포·승인함 카드.
// 기존 props/동작/권한 게이트는 전부 그대로, DOM 구조와 클래스만 목업에 맞춰 교체.
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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
  const pendingCount = props.proposals.length;

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div id="wikiArea">
      <div className="wikiSide">
        <div className="wikiSeg">
          <button type="button" className={'segBtn' + (tab === 'pages' ? ' on' : '')} onClick={() => setTab('pages')}>
            {T.wikiPages}
          </button>
          <button type="button" className={'segBtn' + (tab === 'inbox' ? ' on' : '')} onClick={() => setTab('inbox')}>
            {T.wikiInbox}
            {pendingCount > 0 && <span className="segBadge">{pendingCount}</span>}
          </button>
        </div>
        <div className="wikiSearch">
          <input type="text" placeholder={T.wikiSearchPh} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="wikiList">
          {tab === 'pages' && (
            q === '' ? (
              props.pages.map((p) => (
                <div key={p.slug} className={'pitem' + (open?.slug === p.slug ? ' sel' : '')} onClick={() => props.onOpenPage(p.slug)}>
                  <div className="t">{p.title}</div>
                  <div className="m">
                    <StatusPill status={p.status} />
                    <span className="cat">{p.category}</span>
                    <span className="date">{formatDate(p.updated)}</span>
                  </div>
                </div>
              ))
            ) : props.searchResults.length === 0 ? (
              <div className="empty">{T.wikiNoResults}</div>
            ) : (
              props.searchResults.map((h) => (
                <div key={h.slug} className={'pitem' + (open?.slug === h.slug ? ' sel' : '')} onClick={() => props.onOpenPage(h.slug)}>
                  <div className="t">{h.title}</div>
                  <div className="snippet">{h.snippet}</div>
                </div>
              ))
            )
          )}
        </div>
      </div>

      <div className="wikiDocPane">
        {tab === 'pages' ? (
          <>
            {open && (
              <div className="dochdr">
                <div className="titles">
                  <h2>{open.title}</h2>
                  <div className="meta">
                    <StatusPill status={open.status} />
                    <span className="cat">{open.category}</span>
                    <span className="date">{formatDate(open.updated)}</span>
                  </div>
                </div>
                {canAct && !editing && (
                  <div className="acts">
                    {props.canEdit && <button type="button" onClick={() => { setDraft(open.body); setEditing(true); }}>{T.wikiEdit}</button>}
                    {props.canUnpublish && <button type="button" onClick={() => props.onUnpublish(open.slug)}>{T.wikiUnpublish}</button>}
                    {props.canDelete && <button type="button" className="danger" onClick={() => { if (window.confirm(T.wikiDeleteConfirm)) props.onDelete(open.slug); }}>{T.wikiDelete}</button>}
                  </div>
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
          </>
        ) : (
          <div className="inboxView">
            <h2>{T.wikiPendingCount(pendingCount)}</h2>
            <div className="sub">{T.wikiInboxSub}</div>
            {pendingCount === 0 && <div className="empty">{T.wikiInboxEmpty}</div>}
            {props.proposals.map((p) => (
              <div key={p.id} className="card">
                <div className="ct">{p.title}</div>
                <div className="who">
                  <span className={'opBadge ' + p.op}>{p.op}</span>
                  {` ${p.targetSlug} · ${Math.round(p.confidence * 100)}%`}
                  {p.conflictSlugs?.length ? ` · ⚠ ${p.conflictSlugs.join(', ')}` : ''}
                </div>
                <div className="reason">{p.reason}</div>
                <div className={'snip' + (expanded.has(p.id) ? ' open' : '')}>
                  <PropBody markdown={p.payload} />
                </div>
                <div className="cbtns">
                  {props.canApprove && <button type="button" className="approve" onClick={() => props.onApprove(p.id)}>{T.wikiApprove}</button>}
                  {props.canApprove && <button type="button" className="rejectb" onClick={() => props.onReject(p.id)}>{T.wikiReject}</button>}
                  <button type="button" className="diffb" onClick={() => toggleExpand(p.id)}>{T.wikiViewFull}</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// 제안 본문 미리보기 — 검증된 마크다운 빌더 재사용(XSS 안전).
function PropBody({ markdown }: { markdown: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.replaceChildren(renderMarkdown(markdown)); }, [markdown]);
  return <div className="propBody" ref={ref} />;
}
